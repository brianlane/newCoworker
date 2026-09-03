/**
 * Should we adopt a new Gemini id on a given worker pin?
 *
 * The rules are the ones past bumps already paid for:
 *   - A 404 id must never become a default (gemini-3.1-flash, PR #655).
 *   - Flagship/SMS also need the OpenAI-compat route the llm-router uses.
 *   - Same or lower post-intro list price, never the launch promo
 *     (3.7-flash intro $0.75/$3.75 lapses 2026-12-31; we meter $1.50/$7.50).
 *   - A pricier flagship must not land on the SMS/lite pin
 *     (3.5-flash was a poor deal at ~$0.026/turn vs ~$0.004).
 *   - Preview / cyber / -latest ids are never fleet defaults.
 *   - Live audio pins are never auto-adopted.
 *   - thinkingLevel "minimal" rejecting is not a blocker (PR #1372 retries).
 */

import { isThinkingLevelRejection } from "@/lib/gemini-generate-content";
import {
  compareGeminiVersions,
  isUnstableGeminiId,
  parseGeminiModelId,
  type GeminiModelPin,
  type GeminiParsedModel
} from "@/lib/gemini-model-pins";

export type GeminiPrice = { in: number; out: number };

export type RouteProbe = {
  ok: boolean;
  status: number;
  excerpt?: string;
};

export type ThinkingProbe = "supported" | "rejected" | "unknown";

export type CandidateProbe = {
  model: string;
  listed: boolean;
  generateContent: RouteProbe;
  openAiCompat: RouteProbe;
  thinkingMinimal: ThinkingProbe;
  thinkingLow: ThinkingProbe;
};

export type AdoptionVerdict = "adopt" | "skip" | "wait" | "already";

export type AdoptionRecommendation = {
  pinId: string;
  workers: string[];
  current: string;
  candidate: string;
  verdict: AdoptionVerdict;
  reasons: string[];
};

export type RecommendContext = {
  probe: CandidateProbe;
  candidatePrice: GeminiPrice | null;
  pinPrice: GeminiPrice;
};

const PRICE_TOLERANCE = 1.05;

export function classifyThinkingProbe(status: number, body: string): ThinkingProbe {
  if (status >= 200 && status < 300) return "supported";
  if (isThinkingLevelRejection(status, body)) return "rejected";
  return "unknown";
}

function priceNotWorse(candidate: GeminiPrice, current: GeminiPrice): boolean {
  return candidate.in <= current.in * PRICE_TOLERANCE && candidate.out <= current.out * PRICE_TOLERANCE;
}

function priceWorse(candidate: GeminiPrice, current: GeminiPrice): boolean {
  return !priceNotWorse(candidate, current);
}

function pinParsedOrThrow(pin: GeminiModelPin): GeminiParsedModel {
  if (pin.family === "live") {
    return {
      id: pin.defaultModel,
      family: "live",
      version: [0, 0],
      unstable: false
    };
  }
  const parsed = parseGeminiModelId(pin.defaultModel);
  if (!parsed) {
    throw new Error(`gemini-model-eval: pin ${pin.id} has an unparseable default ${pin.defaultModel}`);
  }
  return parsed;
}

/**
 * One pin vs one candidate. First matching rule wins. Reasons always
 * name the historical lesson so the next session does not re-derive it.
 */
export function recommendForPin(
  pin: GeminiModelPin,
  candidateId: string,
  ctx: RecommendContext
): AdoptionRecommendation {
  const candidate = stripAndParse(candidateId);
  const current = pinParsedOrThrow(pin);
  const base = {
    pinId: pin.id,
    workers: [...pin.workers],
    current: pin.defaultModel,
    candidate: candidate?.id ?? stripAndParseId(candidateId)
  };

  if (!pin.autoAdopt) {
    return {
      ...base,
      verdict: "wait",
      reasons: [
        "Live audio pins are never auto-adopted. Preview ids rotate, and a live-translate id can satisfy 'must contain live' while being the wrong product."
      ]
    };
  }

  if (!candidate) {
    return {
      ...base,
      verdict: "skip",
      reasons: ["Candidate id is not a parseable gemini-* model."]
    };
  }

  if (candidate.unstable) {
    return {
      ...base,
      verdict: "skip",
      reasons: [
        "Preview, experimental, -latest, or specialist (cyber/tts) ids are never fleet defaults."
      ]
    };
  }

  if (!pin.acceptsFamilies.includes(candidate.family)) {
    return {
      ...base,
      verdict: "skip",
      reasons: [
        `Family mismatch: ${candidate.family} is not accepted by the ${pin.family} pin. A flagship Flash must not replace the SMS/lite pin (3.5-flash was a poor deal on that path).`
      ]
    };
  }

  if (candidate.id === current.id) {
    return {
      ...base,
      verdict: "already",
      reasons: ["This pin already defaults to the candidate id."]
    };
  }

  if (compareGeminiVersions(candidate.version, current.version) <= 0) {
    return {
      ...base,
      verdict: "skip",
      reasons: [
        `Not newer than the current pin (${formatVersion(current.version)} vs candidate ${formatVersion(candidate.version)}).`
      ]
    };
  }

  if (!ctx.probe.generateContent.ok) {
    return {
      ...base,
      verdict: "skip",
      reasons: [
        `generateContent failed HTTP ${ctx.probe.generateContent.status}. A 404 id must never become a default (gemini-3.1-flash, PR #655).`
      ]
    };
  }

  if (pin.needsOpenAiCompat && !ctx.probe.openAiCompat.ok) {
    return {
      ...base,
      verdict: "skip",
      reasons: [
        `OpenAI-compat failed HTTP ${ctx.probe.openAiCompat.status}. voice_task and SMS reach Gemini through the llm-router, which uses that route.`
      ]
    };
  }

  if (!ctx.candidatePrice) {
    return {
      ...base,
      verdict: "wait",
      reasons: [
        "No post-intro list price on file. Refuse to pin a launch promo: 3.7-flash intro rates lapse 2026-12-31 and would undercount the fuse."
      ]
    };
  }

  if (priceWorse(ctx.candidatePrice, ctx.pinPrice)) {
    return {
      ...base,
      verdict: "skip",
      reasons: [
        `Costs more than the current pin ($${ctx.candidatePrice.in}/$${ctx.candidatePrice.out} vs $${ctx.pinPrice.in}/$${ctx.pinPrice.out} per 1M). Same class as skipping 3.5-flash for SMS.`
      ]
    };
  }

  if (ctx.probe.thinkingMinimal === "rejected" && ctx.probe.thinkingLow === "rejected") {
    return {
      ...base,
      verdict: "wait",
      reasons: [
        "Both thinkingLevel minimal and low were rejected. Surfaces that send thinkingConfig would 400 even after the PR #1372 retry."
      ]
    };
  }

  const reasons = [
    `Newer ${candidate.family} than ${pin.defaultModel}, generateContent ok, post-intro price at or below the current pin ($${ctx.candidatePrice.in}/$${ctx.candidatePrice.out} per 1M).`
  ];
  if (pin.needsOpenAiCompat) {
    reasons.push("OpenAI-compat ok (llm-router path).");
  }
  if (ctx.probe.thinkingMinimal === "rejected") {
    reasons.push(
      "thinkingLevel minimal is rejected (same as 3.7-flash). The generateContent retry already steps minimal down to low."
    );
  }
  if (!ctx.probe.listed) {
    reasons.push("Id was not in models.list; generateContent still succeeded so the list lag is not a blocker.");
  }
  return { ...base, verdict: "adopt", reasons };
}

function stripAndParseId(raw: string): string {
  return raw.trim().replace(/^models\//i, "").toLowerCase();
}

function stripAndParse(raw: string): GeminiParsedModel | null {
  return parseGeminiModelId(raw);
}

function formatVersion(version: [number, number]): string {
  return version[1] === 0 ? `${version[0]}` : `${version[0]}.${version[1]}`;
}

export function recommendAllPins(
  pins: readonly GeminiModelPin[],
  candidateId: string,
  ctx: {
    probe: CandidateProbe;
    candidatePrice: GeminiPrice | null;
    prices: Record<string, GeminiPrice>;
  }
): AdoptionRecommendation[] {
  return pins.map((pin) =>
    recommendForPin(pin, candidateId, {
      probe: ctx.probe,
      candidatePrice: ctx.candidatePrice,
      pinPrice: tablePriceFor(pin.defaultModel, ctx.prices) ?? { in: 1.5, out: 9.0 }
    })
  );
}

/**
 * Listed Google ids that are a newer GA model in a family at least one
 * auto-adopt pin accepts.
 */
export function findNewerCandidates(
  listedIds: string[],
  pins: readonly GeminiModelPin[]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of listedIds) {
    const parsed = parseGeminiModelId(raw);
    if (!parsed || parsed.unstable) continue;
    if (parsed.family === "other" || parsed.family === "pro" || parsed.family === "live") {
      continue;
    }
    let newer = false;
    for (const pin of pins) {
      if (!pin.autoAdopt) continue;
      if (pin.family !== parsed.family) continue;
      const current = pinParsedOrThrow(pin);
      if (compareGeminiVersions(parsed.version, current.version) > 0) {
        newer = true;
        break;
      }
    }
    if (newer && !seen.has(parsed.id)) {
      seen.add(parsed.id);
      out.push(parsed.id);
    }
  }
  out.sort();
  return out;
}

export type PriceSource = "table" | "docs" | "predecessor" | "cli" | "unknown";

export type ResolvedPrice = {
  price: GeminiPrice | null;
  source: PriceSource;
};

/**
 * Exact table hit only. Do not use the meter default ($1.50/$9.00): that
 * would make every unknown flagship look more expensive than 3.7-flash and
 * skip a same-price successor.
 */
export function tablePriceFor(
  model: string,
  prices: Record<string, GeminiPrice>
): GeminiPrice | null {
  const key = model.trim();
  return Object.prototype.hasOwnProperty.call(prices, key) ? prices[key] : null;
}

/**
 * Post-intro list price of the newest same-family pin that is older than
 * the candidate. Google has shipped flagship Flash successors at the
 * previous post-intro rate (3.6 -> 3.7). Promo intro rates are never stored
 * on the pin, so inheriting that row cannot undercount the fuse.
 */
export function predecessorPriceFor(
  candidateId: string,
  pins: readonly GeminiModelPin[],
  prices: Record<string, GeminiPrice>
): GeminiPrice | null {
  const candidate = parseGeminiModelId(candidateId);
  if (!candidate) return null;
  let best: { version: [number, number]; price: GeminiPrice } | null = null;
  for (const pin of pins) {
    if (pin.family === "live") continue;
    const current = parseGeminiModelId(pin.defaultModel);
    if (!current || current.family !== candidate.family) continue;
    if (compareGeminiVersions(current.version, candidate.version) >= 0) continue;
    const priced = tablePriceFor(pin.defaultModel, prices);
    if (!priced) continue;
    if (!best || compareGeminiVersions(current.version, best.version) > 0) {
      best = { version: current.version, price: priced };
    }
  }
  return best?.price ?? null;
}

/**
 * Pull Standard-SKU input/output USD-per-1M rates out of a Google pricing
 * page. Intro + post-intro rows keep the higher number (never the launch
 * promo). Grounding ($14 / 1,000 requests), cache storage, and
 * Batch/Flex/Priority tables are not token rates and must not win.
 *
 * Google's HTML is one `<h2 id="gemini-...">` section per model, with
 * Input price / Output price in the first (Standard) table. Compact
 * snippets (tests, markdown) fall through to adjacent $ pairing.
 */
export function parsePublishedGeminiPrices(text: string): Record<string, GeminiPrice> {
  const html = parsePricingPageHtml(text);
  if (Object.keys(html).length > 0) return html;
  return parseCompactPublishedPrices(text);
}

function parsePricingPageHtml(text: string): Record<string, GeminiPrice> {
  const out: Record<string, GeminiPrice> = {};
  const sectionRe = /<h2 id="(gemini-[^"]+)"[^>]*>([\s\S]*?)(?=<h2 id="gemini-|$)/gi;
  for (const match of text.matchAll(sectionRe)) {
    const id = match[1].toLowerCase();
    if (isUnstableGeminiId(id)) continue;
    const pair = parseStandardTablePrices(match[2] || "");
    if (pair) out[id] = pair;
  }
  return out;
}

function parseStandardTablePrices(section: string): GeminiPrice | null {
  const standard = standardSkuSection(section);
  const inputRow = rowAfterLabel(standard, /Input price/i);
  const outputRow = rowAfterLabel(standard, /Output price/i);
  if (!inputRow || !outputRow) return null;
  const inn = maxDollar(inputRow);
  const outp = maxDollar(outputRow);
  if (inn == null || outp == null || outp <= inn) return null;
  return { in: inn, out: outp };
}

/** Cut before Batch/Flex/Priority h3s so those SKUs cannot replace Standard. */
function standardSkuSection(section: string): string {
  const cuts = [
    section.search(/<h3\b[^>]*id="batch/i),
    section.search(/<h3\b[^>]*>\s*Batch\b/i)
  ].filter((n) => n >= 0);
  return cuts.length === 0 ? section : section.slice(0, Math.min(...cuts));
}

function rowAfterLabel(html: string, label: RegExp): string | null {
  const idx = html.search(label);
  if (idx < 0) return null;
  const slice = html.slice(idx);
  const trEnd = slice.search(/<\/tr>/i);
  const nextLabel = slice.slice(1).search(/Input price|Output price|Context caching|Grounding with/i);
  let end = Math.min(slice.length, 500);
  if (trEnd >= 0) end = Math.min(end, trEnd);
  if (nextLabel >= 0) end = Math.min(end, nextLabel + 1);
  return slice.slice(0, end);
}

function maxDollar(text: string): number | null {
  const amounts = dollarAmounts(text);
  return amounts.length > 0 ? Math.max(...amounts) : null;
}

function dollarAmounts(text: string): number[] {
  return [...text.matchAll(/\$([0-9]+(?:\.[0-9]+)?)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 100);
}

function parseCompactPublishedPrices(text: string): Record<string, GeminiPrice> {
  const out: Record<string, GeminiPrice> = {};
  const compact = text.replace(/\s+/g, " ");
  const chunks = compact.split(/(?=gemini-\d)/i);
  for (const chunk of chunks) {
    const idMatch = /^(gemini-\d+(?:\.\d+)?(?:-[a-z0-9.]+)*)/i.exec(chunk.trim());
    if (!idMatch) continue;
    const id = idMatch[1].toLowerCase();
    if (isUnstableGeminiId(id)) continue;
    const pair = highestInOutPair(dollarAmounts(chunk));
    if (!pair) continue;
    const prev = out[id];
    if (!prev || prev.in + prev.out < pair.in + pair.out) {
      out[id] = pair;
    }
  }
  return out;
}

/** Adjacent (in, out) pairs with out > in; keep the priciest output. */
export function highestInOutPair(amounts: number[]): GeminiPrice | null {
  let best: GeminiPrice | null = null;
  for (let i = 0; i < amounts.length - 1; i++) {
    const inn = amounts[i];
    const outp = amounts[i + 1];
    if (outp <= inn) continue;
    if (!best || outp > best.out || (outp === best.out && inn > best.in)) {
      best = { in: inn, out: outp };
    }
  }
  return best;
}

export function resolveCandidatePrice(
  candidateId: string,
  pins: readonly GeminiModelPin[],
  prices: Record<string, GeminiPrice>,
  published: Record<string, GeminiPrice> = {},
  cliPrice: GeminiPrice | null = null
): ResolvedPrice {
  const id = candidateId.trim().replace(/^models\//i, "").toLowerCase();
  if (cliPrice) return { price: cliPrice, source: "cli" };
  const fromTable = tablePriceFor(id, prices);
  if (fromTable) return { price: fromTable, source: "table" };
  const fromPred = predecessorPriceFor(id, pins, prices);
  const fromDocs = tablePriceFor(id, published);
  if (fromDocs && fromPred && fromDocs.in + fromDocs.out < (fromPred.in + fromPred.out) * 0.7) {
    return { price: fromPred, source: "predecessor" };
  }
  if (fromDocs) return { price: fromDocs, source: "docs" };
  if (fromPred) return { price: fromPred, source: "predecessor" };
  return { price: null, source: "unknown" };
}

export type CandidateEvaluation = {
  candidate: string;
  probe: CandidateProbe;
  price: GeminiPrice | null;
  priceSource: PriceSource;
  recommendations: AdoptionRecommendation[];
};

function missingProbe(model: string, listed: boolean): CandidateProbe {
  return {
    model,
    listed,
    generateContent: { ok: false, status: 0 },
    openAiCompat: { ok: false, status: 0 },
    thinkingMinimal: "unknown",
    thinkingLow: "unknown"
  };
}

/**
 * Diff Google's listed ids against our pins and score every newer GA
 * candidate. The caller supplies the list plus probes; this never takes a
 * hardcoded model name.
 */
export function evaluateListedModels(args: {
  listedIds: string[];
  pins: readonly GeminiModelPin[];
  probes: Record<string, CandidateProbe>;
  prices: Record<string, GeminiPrice>;
  published?: Record<string, GeminiPrice>;
  generatedAt: string;
}): EvalReport {
  const newerThanPins = findNewerCandidates(args.listedIds, args.pins);
  const listedSet = new Set(
    args.listedIds.map((id) => id.trim().replace(/^models\//i, "").toLowerCase())
  );
  const evaluations: CandidateEvaluation[] = newerThanPins.map((candidate) => {
    const probe =
      args.probes[candidate] ?? missingProbe(candidate, listedSet.has(candidate));
    const resolved = resolveCandidatePrice(
      candidate,
      args.pins,
      args.prices,
      args.published ?? {}
    );
    return {
      candidate,
      probe,
      price: resolved.price,
      priceSource: resolved.source,
      recommendations: recommendAllPins(args.pins, candidate, {
        probe,
        candidatePrice: resolved.price,
        prices: args.prices
      })
    };
  });
  return {
    generatedAt: args.generatedAt,
    listedCount: args.listedIds.length,
    newerThanPins,
    evaluations
  };
}

export type EvalReport = {
  generatedAt: string;
  listedCount: number;
  newerThanPins: string[];
  evaluations: CandidateEvaluation[];
};

export function formatEvalReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`Gemini model eval (${report.generatedAt})`);
  lines.push("");
  lines.push(`Google listed ${report.listedCount} model(s). Newer than our pins: ${
    report.newerThanPins.length > 0 ? report.newerThanPins.join(", ") : "(none)"
  }.`);
  if (report.evaluations.length === 0) {
    lines.push("");
    lines.push("No candidates evaluated.");
    return lines.join("\n");
  }
  for (const ev of report.evaluations) {
    lines.push("");
    lines.push(`## ${ev.candidate}`);
    lines.push(
      `listed=${ev.probe.listed} generateContent=${probeLabel(ev.probe.generateContent)} openai=${probeLabel(ev.probe.openAiCompat)} thinking.minimal=${ev.probe.thinkingMinimal} thinking.low=${ev.probe.thinkingLow}`
    );
    const priceLine =
      ev.price === null
        ? "price: unknown"
        : `price: $${ev.price.in}/$${ev.price.out} per 1M (${ev.priceSource})`;
    lines.push(priceLine);
    const byVerdict = groupByVerdict(ev.recommendations);
    for (const verdict of ["adopt", "wait", "skip", "already"] as const) {
      const rows = byVerdict.get(verdict) ?? [];
      if (rows.length === 0) continue;
      lines.push("");
      lines.push(`### ${verdict} (${rows.length})`);
      for (const row of rows) {
        lines.push(`- ${row.pinId} (${row.workers.join("; ")}): ${row.current} -> ${row.candidate}`);
        for (const reason of row.reasons) {
          lines.push(`  ${reason}`);
        }
      }
    }
  }
  return lines.join("\n");
}

function probeLabel(probe: RouteProbe): string {
  return probe.ok ? `ok/${probe.status}` : `fail/${probe.status}`;
}

function groupByVerdict(
  rows: AdoptionRecommendation[]
): Map<AdoptionVerdict, AdoptionRecommendation[]> {
  const map = new Map<AdoptionVerdict, AdoptionRecommendation[]>();
  for (const row of rows) {
    const list = map.get(row.verdict) ?? [];
    list.push(row);
    map.set(row.verdict, list);
  }
  return map;
}

export function reportHasAdopt(report: EvalReport): boolean {
  return report.evaluations.some((ev) =>
    ev.recommendations.some((r) => r.verdict === "adopt")
  );
}

export function reportHasWait(report: EvalReport): boolean {
  return report.evaluations.some((ev) =>
    ev.recommendations.some((r) => r.verdict === "wait")
  );
}
