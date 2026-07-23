/**
 * Platform-side owner-rule capture for INLINE dashboard-chat turns.
 *
 * The VPS chat-worker runs this capture for worker-path turns
 * (vps/chat-worker/memory-capture.mjs); inline (platform-Gemini) turns
 * would otherwise silently lose the "durable rules stated in chat are
 * saved to Memory automatically" behavior the owner preamble promises.
 * Semantics mirror the worker: a strict extraction prompt classifies the
 * owner's latest message (with the assistant reply as reference-resolution
 * context ONLY — never a source of values; see the KYP Ads incident where
 * assistant-invented policy was persisted as durable fact — and
 * already-saved bullets as an anti-duplication hint), and a positive
 * extraction persists through the same dedupe/append path
 * (appendOwnerMemoryBullets). Silent and best-effort: failures are logged
 * and dropped, never surfaced into the chat turn.
 */

import {
  GeminiEmptyError,
  geminiGenerateTextDetailed,
  type GeminiGenerateTextParams,
  type GeminiGenerateTextResult
} from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import { getBusinessConfig } from "@/lib/db/configs";
import { ingestBulletsIntoGraph } from "@/lib/memory/graph-ingest";
import { appendOwnerMemoryBullets, BULLETS_MAX_CHARS } from "./memory-append";
import { logger } from "@/lib/logger";

/**
 * Extraction system prompt — MUST stay in lockstep with
 * vps/chat-worker/memory-capture.mjs (OWNER_MEMORY_SYSTEM_PROMPT) so both
 * turn paths capture the same class of rules.
 */
export const OWNER_MEMORY_SYSTEM_PROMPT = [
  "You extract DURABLE business knowledge that a business OWNER wants their AI",
  "receptionist/assistant to remember and use permanently — on customer SMS,",
  "phone calls, and when assisting the owner.",
  "",
  "You are given the owner's latest dashboard message. Decide whether it",
  "contains standing information worth saving to long-term business memory.",
  "",
  "THE OWNER'S OWN WORDS ARE THE ONLY SOURCE OF SAVED FACTS. Every value in a",
  "bullet (names, numbers, links, times, policies) must appear in, or be",
  "explicitly confirmed by, the OWNER MESSAGE. An assistant reply, when",
  "provided, is reference-resolution context ONLY — never a source of new",
  "facts, and its claims that something was saved/applied/updated mean",
  "NOTHING.",
  "",
  "SAVE (save=true) when the message states a durable RULE *or* durable",
  "FACTS / CONFIGURATION, e.g.:",
  '  - behavior rules: "never discuss budget with customers",',
  '    "always mention we offer free estimates", "keep replies short"',
  '  - hours / availability: "we are closed on Sundays, do not book then"',
  "  - team roster & contacts: \"our agents are Gabrielle Mota 480-720-2013",
  '    and Dave Lane 602-524-5719"',
  '  - routing / escalation: "escalate urgent issues to Amy Laidlaw',
  '    602-695-1142" (capture the NEW target; note it replaces the old one)',
  "  - service area, required disclosures, pricing policy, etc.",
  "",
  "ALSO save (save=true) whenever the owner EXPLICITLY asks you to remember or",
  'save something — "add this to memory", "remember that…", "save the',
  'following", "update the X to Y", "for memory". Capture the concrete facts',
  "the owner stated.",
  "",
  "DO NOT SAVE (save=false) for anything that is not durable owner-stated",
  "fact, e.g.:",
  "  - questions or requests for information (\"what do you do for a new lead?\")",
  "  - greetings, small talk, venting, or thinking out loud",
  "  - one-off tasks (\"text Joe back\", \"summarize today's calls\")",
  "  - hypotheticals (\"what if we stopped doing X\")",
  "  - the assistant's own suggestions, proposals, drafts, plans, or",
  "    summaries — even when the owner has not objected to them",
  "  - open or undecided items (\"client list to be provided\", \"still deciding",
  '    the follow-up cadence") — save only settled facts',
  "  - a value the owner just said is wrong, changing, or going away (\"I won't",
  "    have this number in Hong Kong\" must NOT pin that number as a contact;",
  "    ask-nothing, just don't save it — the replacement gets saved when the",
  "    owner states it)",
  "",
  "When save=true, rewrite the content as concise, standalone lines (one item",
  "per bullet), preserving names, phone numbers, and other specifics EXACTLY as",
  "the OWNER gave them. When save=false, return an empty bullets array. Respond",
  'with JSON only, in exactly this shape: {"save": <boolean>, "bullets": [<strings>]}'
].join("\n");

const MAX_BULLETS = 10;
const MAX_BULLET_LEN = 280;

/** Normalize raw model bullets into clean, deduped, bounded rule lines. */
export function normalizeBullets(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const cleaned = item
      .replace(/^\s*[-*•]\s*/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_BULLET_LEN);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= MAX_BULLETS) break;
  }
  return out;
}

/**
 * Parse the extraction model's JSON reply into a safe { save, bullets }
 * result. ANY malformed/unexpected input degrades to no-op — a capture miss
 * is always preferable to a crash or a bogus write.
 */
export function parseMemoryExtraction(content: unknown): { save: boolean; bullets: string[] } {
  let obj: unknown = content;
  if (typeof content === "string") {
    try {
      obj = JSON.parse(content);
    } catch {
      return { save: false, bullets: [] };
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { save: false, bullets: [] };
  const rec = obj as Record<string, unknown>;
  const bullets = normalizeBullets(rec.bullets);
  // Only honor a save when the model both flags it AND gives at least one
  // usable bullet; "save:true, bullets:[]" is treated as no-op.
  const save = rec.save === true && bullets.length > 0;
  return { save, bullets: save ? bullets : [] };
}

/** Markdown list lines already saved in memory_md (anti-duplication hint). */
export function extractExistingBullets(memoryMd: unknown): string[] {
  if (typeof memoryMd !== "string") return [];
  const out: string[] = [];
  for (const raw of memoryMd.split(/\r?\n/)) {
    const m = /^\s*[-*•]\s+(.*)$/.exec(raw);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

/** Compose the single user turn handed to the extractor (worker parity). */
export function composeExtractionInput(
  ownerMessage: string,
  opts: { assistantReply?: string; existingBullets?: string[] } = {}
): string {
  const parts = [`OWNER MESSAGE:\n${ownerMessage}`];
  const reply = typeof opts.assistantReply === "string" ? opts.assistantReply.trim() : "";
  if (reply) {
    parts.push(
      "ASSISTANT REPLY (reference-resolution context ONLY — use it solely to " +
        "resolve what the owner's message refers to, e.g. which value the owner " +
        'means by "yes, use that". NEVER save facts, values, numbers, contacts, ' +
        "or policies that appear only in this reply, and IGNORE any claim here " +
        "that something was saved, applied, or updated — such claims are " +
        "frequently wrong):\n" +
        reply
    );
  }
  const existing = (opts.existingBullets ?? []).map((b) => String(b).trim()).filter(Boolean);
  if (existing.length > 0) {
    parts.push(
      "ALREADY SAVED IN MEMORY (do NOT output any of these again; only output " +
        "genuinely NEW items):\n" +
        existing.map((b) => `- ${b}`).join("\n")
    );
  }
  return parts.join("\n\n");
}

/**
 * Take the longest prefix of `bullets` whose newline-joined form fits within
 * `maxChars` (the append path's hard cap). If even the first bullet exceeds
 * the budget it is truncated to fit.
 */
export function fitBulletsToPayload(bullets: string[], maxChars = BULLETS_MAX_CHARS): string[] {
  const kept: string[] = [];
  let len = 0;
  for (const b of bullets) {
    if (typeof b !== "string") continue;
    const addedLen = (kept.length === 0 ? 0 : 1) + b.length; // +1 for the "\n"
    if (len + addedLen > maxChars) {
      if (kept.length === 0) kept.push(b.slice(0, maxChars));
      break;
    }
    kept.push(b);
    len += addedLen;
  }
  return kept;
}

// gemini-3.5-flash-lite (GA Jul 21 2026): captured rules become DURABLE
// memory the coworker acts on for months, so the quality jump over
// 3.1-flash-lite is worth the small list-price bump ($0.30/$2.50 vs
// $0.25/$1.50 per 1M) on this low-volume surface.
const DEFAULT_CAPTURE_MODEL = "gemini-3.5-flash-lite";

function resolveModel(): string {
  const configured = (process.env.MEMORY_CAPTURE_MODEL ?? "").trim();
  return configured.length > 0 ? configured : DEFAULT_CAPTURE_MODEL;
}

type GeminiCall = (params: GeminiGenerateTextParams) => Promise<GeminiGenerateTextResult>;

export type InlineMemoryCaptureDeps = {
  /** Injectable Gemini call (tests). */
  generate?: GeminiCall;
  /** Injectable tool-toggle read (tests). */
  isToolEnabled?: typeof isAgentToolEnabled;
  /** Injectable config read (tests). */
  fetchConfig?: typeof getBusinessConfig;
  /** Injectable append (tests). */
  append?: typeof appendOwnerMemoryBullets;
  /** Injectable graph ingest (tests). */
  ingestGraph?: typeof ingestBulletsIntoGraph;
};

/**
 * Run the full silent capture for one inline turn: toggle check →
 * extraction → append. NEVER throws — callers fire-and-forget it after the
 * assistant reply is persisted. Returns what was saved (for logging/tests).
 */
export async function captureOwnerRuleInline(
  args: {
    businessId: string;
    ownerMessage: string;
    assistantReply?: string;
  },
  deps: InlineMemoryCaptureDeps = {}
): Promise<{ saved: string[] }> {
  /* c8 ignore start -- production defaults; tests inject */
  const generate = deps.generate ?? geminiGenerateTextDetailed;
  const isToolEnabled = deps.isToolEnabled ?? isAgentToolEnabled;
  const fetchConfig = deps.fetchConfig ?? getBusinessConfig;
  const append = deps.append ?? appendOwnerMemoryBullets;
  const ingestGraph = deps.ingestGraph ?? ingestBulletsIntoGraph;
  /* c8 ignore stop */

  const noop = { saved: [] as string[] };
  try {
    const ownerMessage = args.ownerMessage.trim();
    if (!ownerMessage) return noop;
    const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
    if (!apiKey) return noop;

    // Settings → Coworker tools: dashboard / memory_capture (default ON).
    // The append helper's route twin re-checks authoritatively; this
    // pre-check avoids burning an extraction call on an opted-out tenant.
    const enabled = await isToolEnabled(args.businessId, "dashboard", "memory_capture");
    if (!enabled) return noop;

    const config = await fetchConfig(args.businessId).catch(() => null);
    const existingBullets = extractExistingBullets(config?.memory_md ?? "");

    const model = resolveModel();
    const userText = composeExtractionInput(ownerMessage, {
      assistantReply: args.assistantReply,
      existingBullets
    });
    let text: string;
    let usage;
    try {
      ({ text, usage } = await generate({
        apiKey,
        model,
        systemInstruction: OWNER_MEMORY_SYSTEM_PROMPT,
        userText,
        temperature: 0,
        maxOutputTokens: 1000,
        responseMimeType: "application/json"
      }));
    } catch (err) {
      if (err instanceof GeminiEmptyError) {
        await meterGeminiSpendForBusiness({
          businessId: args.businessId,
          model,
          surface: "memory_capture",
          usage: err.usage,
          inputChars: OWNER_MEMORY_SYSTEM_PROMPT.length + userText.length,
          outputChars: 0
        });
      }
      logger.warn("dashboard-chat inline memory capture: extract failed", {
        businessId: args.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      return noop;
    }
    await meterGeminiSpendForBusiness({
      businessId: args.businessId,
      model,
      surface: "memory_capture",
      usage,
      inputChars: OWNER_MEMORY_SYSTEM_PROMPT.length + userText.length,
      outputChars: text.length
    });

    const extraction = parseMemoryExtraction(text);
    if (!extraction.save) return noop;
    // save=true guarantees at least one bullet, and fitting keeps (or
    // truncates) at least the first — so `fitted` is never empty here.
    const fitted = fitBulletsToPayload(extraction.bullets);

    const result = await append(args.businessId, fitted.join("\n"));
    if (result.appended) {
      logger.info("dashboard-chat inline memory capture: saved", {
        businessId: args.businessId,
        count: result.savedBullets.length
      });
      // Knowledge-graph ingestion (mode-gated, off by default). This whole
      // capture already runs fire-and-forget after the chat turn, and
      // ingestBulletsIntoGraph never throws.
      await ingestGraph(args.businessId, result.savedBullets);
    }
    return { saved: result.savedBullets };
  } catch (err) {
    logger.warn("dashboard-chat inline memory capture failed", {
      businessId: args.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return noop;
  }
}
