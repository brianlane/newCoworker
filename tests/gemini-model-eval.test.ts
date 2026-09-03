import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GEMINI_PRICES_PER_1M } from "@/lib/billing/ai-spend-meter";
import {
  classifyThinkingProbe,
  evaluateListedModels,
  findNewerCandidates,
  formatEvalReport,
  highestInOutPair,
  parsePublishedGeminiPrices,
  predecessorPriceFor,
  recommendAllPins,
  recommendForPin,
  reportHasAdopt,
  reportHasWait,
  resolveCandidatePrice,
  tablePriceFor,
  type CandidateProbe,
  type GeminiPrice
} from "@/lib/gemini-model-eval";
import { GEMINI_MODEL_PINS, type GeminiModelPin } from "@/lib/gemini-model-pins";

function textPrices(): Record<string, GeminiPrice> {
  const out: Record<string, GeminiPrice> = {};
  for (const [k, v] of Object.entries(GEMINI_PRICES_PER_1M)) {
    out[k] = { in: v.in, out: v.out };
  }
  return out;
}

function okProbe(model: string, listed = true): CandidateProbe {
  return {
    model,
    listed,
    generateContent: { ok: true, status: 200 },
    openAiCompat: { ok: true, status: 200 },
    thinkingMinimal: "rejected",
    thinkingLow: "supported"
  };
}

const PRICES = textPrices();

function fakePin(
  over: Partial<GeminiModelPin> & Pick<GeminiModelPin, "id" | "defaultModel" | "family">
): GeminiModelPin {
  return {
    workers: ["test"],
    envVar: null,
    acceptsFamilies: [over.family],
    needsOpenAiCompat: false,
    autoAdopt: true,
    sources: [],
    ...over
  };
}

describe("classifyThinkingProbe", () => {
  it("maps 2xx, thinking 400s, and other failures", () => {
    expect(classifyThinkingProbe(200, "")).toBe("supported");
    expect(classifyThinkingProbe(204, "ok")).toBe("supported");
    expect(
      classifyThinkingProbe(400, 'Thinking level MINIMAL is not supported for this model')
    ).toBe("rejected");
    expect(classifyThinkingProbe(404, "not found")).toBe("unknown");
    expect(classifyThinkingProbe(500, "boom")).toBe("unknown");
  });
});

describe("tablePriceFor / predecessorPriceFor", () => {
  it("returns null for unknown table keys instead of the meter default", () => {
    expect(tablePriceFor("gemini-9.9-flash", PRICES)).toBeNull();
    expect(tablePriceFor("gemini-3.7-flash", PRICES)).toEqual({ in: 1.5, out: 7.5 });
  });

  it("inherits the newest older same-family pin price", () => {
    expect(predecessorPriceFor("gemini-3.8-flash", GEMINI_MODEL_PINS, PRICES)).toEqual({
      in: 1.5,
      out: 7.5
    });
    expect(predecessorPriceFor("gemini-3.8-flash-lite", GEMINI_MODEL_PINS, PRICES)).toEqual({
      in: 0.3,
      out: 2.5
    });
    expect(predecessorPriceFor("not-a-model", GEMINI_MODEL_PINS, PRICES)).toBeNull();
    expect(predecessorPriceFor("gemini-3.7-flash", GEMINI_MODEL_PINS, PRICES)).toBeNull();
  });

  it("skips live pins and unpriced defaults when inheriting", () => {
    const pins: GeminiModelPin[] = [
      fakePin({ id: "live", defaultModel: "gemini-live-audio", family: "live" }),
      fakePin({
        id: "unpriced",
        defaultModel: "gemini-3.0-flash",
        family: "flagship",
        acceptsFamilies: ["flagship"]
      })
    ];
    expect(predecessorPriceFor("gemini-3.8-flash", pins, PRICES)).toBeNull();
  });
});

describe("parsePublishedGeminiPrices / highestInOutPair", () => {
  it("returns null when there is no rising pair", () => {
    expect(highestInOutPair([])).toBeNull();
    expect(highestInOutPair([9])).toBeNull();
    expect(highestInOutPair([5, 3])).toBeNull();
  });

  it("keeps the pricier adjacent pair (standard vs intro)", () => {
    expect(highestInOutPair([0.75, 3.75, 1.5, 7.5])).toEqual({ in: 1.5, out: 7.5 });
    expect(highestInOutPair([0.3, 2.5])).toEqual({ in: 0.3, out: 2.5 });
    expect(highestInOutPair([1.5, 7.5, 1.5, 7.5])).toEqual({ in: 1.5, out: 7.5 });
  });

  it("parses model ids out of a pricing-page snippet and skips unstable ids", () => {
    const text = `
      gemini-3.7-flash input $0.75 output $3.75 then standard $1.50 $7.50
      gemini-3.8-flash-preview $0.10 $0.40
      gemini-3.8-flash-cyber $9 $9
      gemini-exp-1206 $1 $2
      gemini-3.8-flash-latest $1 $2
      gemini-3.5-flash-lite $0.30 $2.50
      gemini-3.5-flash-lite also listed cheaper $0.10 $0.40
    `;
    const parsed = parsePublishedGeminiPrices(text);
    expect(parsed["gemini-3.7-flash"]).toEqual({ in: 1.5, out: 7.5 });
    expect(parsed["gemini-3.5-flash-lite"]).toEqual({ in: 0.3, out: 2.5 });
    expect(parsed["gemini-3.8-flash-preview"]).toBeUndefined();
    expect(parsed["gemini-3.8-flash-cyber"]).toBeUndefined();
    expect(parsed["gemini-exp-1206"]).toBeUndefined();
    expect(parsed["gemini-3.8-flash-latest"]).toBeUndefined();
  });

  it("skips a model id with no dollar amounts nearby", () => {
    expect(parsePublishedGeminiPrices("gemini-3.9-flash has no prices here")).toEqual({});
  });

  it("reads Standard Input/Output rows from Google's pricing HTML and ignores grounding $14", () => {
    const html = `
      <h2 id="gemini-3.8-flash-preview">Preview</h2>
      <table><tr><td>Input price</td><td>$0.10</td></tr><tr><td>Output price</td><td>$0.40</td></tr></table>
      <h2 id="gemini-3.8-flash" data-text="Gemini 3.8 Flash">Gemini 3.8 Flash</h2>
      <em><code>gemini-3.8-flash</code></em>
      <section><h3 id="standard">Standard</h3><table>
        <tr><td>Input price</td><td>$0.75 through December 31, 2026.<br>$1.50 starting January 1, 2027.</td></tr>
        <tr><td>Output price (including thinking tokens)</td><td>$3.75 through December 31, 2026.<br>$7.50 starting January 1, 2027.</td></tr>
        <tr><td>Context caching price</td><td>$0.15<br>$1.00 / 1,000,000 tokens per hour</td></tr>
        <tr><td>Grounding with Google Search</td><td>then $14 per 1,000 requests.</td></tr>
      </table></section>
      <section><h3 id="batch">Batch</h3><table>
        <tr><td>Input price</td><td>$0.375</td></tr>
        <tr><td>Output price</td><td>$1.875</td></tr>
      </table></section>
      <h2 id="gemini-3.7-flash">Gemini 3.7 Flash</h2>
      <table>
        <tr><td>Input price</td><td>$1.50</td></tr>
        <tr><td>Output price</td><td>$7.50</td></tr>
      </table>
    `;
    const parsed = parsePublishedGeminiPrices(html);
    expect(parsed["gemini-3.8-flash"]).toEqual({ in: 1.5, out: 7.5 });
    expect(parsed["gemini-3.7-flash"]).toEqual({ in: 1.5, out: 7.5 });
    expect(parsed["gemini-3.8-flash-preview"]).toBeUndefined();
  });

  it("skips an HTML section that has no usable Standard input/output pair", () => {
    const html = `
      <h2 id="gemini-9.9-flash">Nine</h2>
      <p>no table</p>
      <h2 id="gemini-9.8-flash">Inverted</h2>
      <table>
        <tr><td>Input price</td><td>$9</td></tr>
        <tr><td>Output price</td><td>$1</td></tr>
      </table>
      <h2 id="gemini-9.7-flash">Input only</h2>
      <table>
        <tr><td>Input price</td><td>$1.50</td></tr>
      </table>
      <h2 id="gemini-9.6-flash">Output only</h2>
      <table>
        <tr><td>Output price</td><td>$7.50</td></tr>
      </table>
    `;
    expect(parsePublishedGeminiPrices(html)).toEqual({});
  });

  it("still reads a Standard row when the table omits </tr>", () => {
    const html = `
      <h2 id="gemini-3.9-flash">Three nine</h2>
      Input price $0.40 $0.80
      Output price $2 $4
      <h3>Batch</h3>
      Input price $0.10
      Output price $0.20
    `;
    expect(parsePublishedGeminiPrices(html)["gemini-3.9-flash"]).toEqual({ in: 0.8, out: 4 });
  });

  it("skips HTML Standard rows that name Input/Output but have no dollar amounts", () => {
    const html = `
      <h2 id="gemini-9.4-flash"><h2 id="gemini-9.3-flash">Free</h2>
      <table>
        <tr><td>Input price</td><td>Free of charge</td></tr>
        <tr><td>Output price</td><td>Free of charge</td></tr>
      </table>
    `;
    expect(parsePublishedGeminiPrices(html)).toEqual({});
  });
});

describe("resolveCandidatePrice", () => {
  it("prefers cli, then table, then docs, then predecessor", () => {
    expect(
      resolveCandidatePrice("gemini-3.7-flash", GEMINI_MODEL_PINS, PRICES, {}, { in: 9, out: 9 })
    ).toEqual({ price: { in: 9, out: 9 }, source: "cli" });
    expect(resolveCandidatePrice("gemini-3.7-flash", GEMINI_MODEL_PINS, PRICES)).toEqual({
      price: { in: 1.5, out: 7.5 },
      source: "table"
    });
    expect(
      resolveCandidatePrice("models/gemini-9.9-flash", GEMINI_MODEL_PINS, PRICES, {
        "gemini-9.9-flash": { in: 2, out: 8 }
      })
    ).toEqual({ price: { in: 2, out: 8 }, source: "docs" });
    expect(resolveCandidatePrice("gemini-3.8-flash", GEMINI_MODEL_PINS, PRICES)).toEqual({
      price: { in: 1.5, out: 7.5 },
      source: "predecessor"
    });
    expect(resolveCandidatePrice("gemini-9-embedding", GEMINI_MODEL_PINS, PRICES)).toEqual({
      price: null,
      source: "unknown"
    });
  });

  it("ignores a docs intro promo that undercuts the post-intro predecessor", () => {
    expect(
      resolveCandidatePrice("gemini-3.8-flash", GEMINI_MODEL_PINS, PRICES, {
        "gemini-3.8-flash": { in: 0.75, out: 3.75 }
      })
    ).toEqual({ price: { in: 1.5, out: 7.5 }, source: "predecessor" });
  });
});

describe("recommendForPin", () => {
  const ctx = {
    probe: okProbe("gemini-3.8-flash"),
    candidatePrice: { in: 1.5, out: 7.5 } as GeminiPrice,
    pinPrice: { in: 1.5, out: 7.5 } as GeminiPrice
  };

  it("waits on live pins before any other rule", () => {
    const rec = recommendForPin(pinByIdRequired("gemini-live"), "gemini-3.8-flash-native-audio", ctx);
    expect(rec.verdict).toBe("wait");
  });

  it("skips unparseable, unstable, and family-mismatched candidates", () => {
    expect(recommendForPin(pinByIdRequired("sms-chat"), "not-gemini", ctx).verdict).toBe("skip");
    expect(
      recommendForPin(pinByIdRequired("sms-chat"), "gemini-3.8-flash-preview", ctx).verdict
    ).toBe("skip");
    expect(recommendForPin(pinByIdRequired("sms-chat"), "gemini-3.8-flash", ctx).verdict).toBe(
      "skip"
    );
  });

  it("returns already when the pin is already on the candidate", () => {
    expect(
      recommendForPin(pinByIdRequired("voice-task"), "gemini-3.7-flash", ctx).verdict
    ).toBe("already");
  });

  it("skips a candidate that is not newer", () => {
    expect(
      recommendForPin(pinByIdRequired("voice-task"), "gemini-3.6-flash", ctx).verdict
    ).toBe("skip");
    const majorOnly = fakePin({
      id: "major-only",
      defaultModel: "gemini-3-flash",
      family: "flagship",
      acceptsFamilies: ["flagship"]
    });
    const rec = recommendForPin(majorOnly, "gemini-2-flash", ctx);
    expect(rec.verdict).toBe("skip");
    expect(rec.reasons[0]).toContain("(3 vs candidate 2)");
  });

  it("skips generateContent failures and OpenAI-compat failures on router pins", () => {
    const genFail = {
      ...ctx,
      probe: { ...okProbe("gemini-3.8-flash"), generateContent: { ok: false, status: 404 } }
    };
    expect(recommendForPin(pinByIdRequired("voice-task"), "gemini-3.8-flash", genFail).verdict).toBe(
      "skip"
    );
    const oaiFail = {
      ...ctx,
      probe: { ...okProbe("gemini-3.8-flash"), openAiCompat: { ok: false, status: 404 } }
    };
    expect(recommendForPin(pinByIdRequired("voice-task"), "gemini-3.8-flash", oaiFail).verdict).toBe(
      "skip"
    );
    expect(recommendForPin(pinByIdRequired("aiflow-compile"), "gemini-3.8-flash", oaiFail).verdict).toBe(
      "adopt"
    );
  });

  it("waits when price is unknown and skips when the candidate costs more", () => {
    expect(
      recommendForPin(pinByIdRequired("voice-task"), "gemini-3.8-flash", {
        ...ctx,
        candidatePrice: null
      }).verdict
    ).toBe("wait");
    expect(
      recommendForPin(pinByIdRequired("webchat"), "gemini-3.8-flash", {
        ...ctx,
        pinPrice: { in: 0.1, out: 0.4 }
      }).verdict
    ).toBe("skip");
  });

  it("waits when both thinking levels are rejected", () => {
    expect(
      recommendForPin(pinByIdRequired("voice-task"), "gemini-3.8-flash", {
        ...ctx,
        probe: {
          ...okProbe("gemini-3.8-flash"),
          thinkingMinimal: "rejected",
          thinkingLow: "rejected"
        }
      }).verdict
    ).toBe("wait");
  });

  it("adopts a same-price flagship successor and notes a missing list entry", () => {
    const rec = recommendForPin(pinByIdRequired("voice-task"), "gemini-3.8-flash", {
      ...ctx,
      probe: { ...okProbe("gemini-3.8-flash", false), thinkingMinimal: "rejected" }
    });
    expect(rec.verdict).toBe("adopt");
    expect(rec.reasons.some((r) => r.includes("OpenAI-compat"))).toBe(true);
    expect(rec.reasons.some((r) => r.includes("minimal"))).toBe(true);
    expect(rec.reasons.some((r) => r.includes("models.list"))).toBe(true);
  });

  it("adopts without the optional notes when list+thinking are clean and no router", () => {
    const rec = recommendForPin(pinByIdRequired("aiflow-compile"), "gemini-3.8-flash", {
      ...ctx,
      probe: { ...okProbe("gemini-3.8-flash"), thinkingMinimal: "supported" }
    });
    expect(rec.verdict).toBe("adopt");
    expect(rec.reasons.some((r) => r.includes("OpenAI-compat"))).toBe(false);
    expect(rec.reasons.some((r) => r.includes("minimal"))).toBe(false);
    expect(rec.reasons.some((r) => r.includes("models.list"))).toBe(false);
  });

  it("throws when a non-live pin default is unparseable", () => {
    const bad = fakePin({
      id: "broken",
      defaultModel: "not-a-model",
      family: "flagship",
      acceptsFamilies: ["flagship"]
    });
    expect(() => recommendForPin(bad, "gemini-3.8-flash", ctx)).toThrow(/unparseable default/);
  });
});

describe("findNewerCandidates / evaluateListedModels", () => {
  it("ignores unstable, pro, live, other, and not-newer ids", () => {
    expect(
      findNewerCandidates(
        [
          "models/gemini-3.7-flash",
          "gemini-3.5-flash-lite",
          "gemini-3.8-flash-preview",
          "gemini-3.1-pro",
          "gemini-3.8-flash-native-audio",
          "gemini-3-embedding",
          "gpt-4",
          "gemini-3.8-flash",
          "gemini-3.8-flash"
        ],
        GEMINI_MODEL_PINS
      )
    ).toEqual(["gemini-3.8-flash"]);
  });

  it("discovers a newer listed flagship without being told the id up front", () => {
    const report = evaluateListedModels({
      listedIds: [
        "gemini-2.5-flash-lite",
        "gemini-3.5-flash-lite",
        "gemini-3.7-flash",
        "models/gemini-3.8-flash"
      ],
      pins: GEMINI_MODEL_PINS,
      probes: { "gemini-3.8-flash": okProbe("gemini-3.8-flash") },
      prices: PRICES,
      generatedAt: "2026-09-03T00:00:00.000Z"
    });
    expect(report.newerThanPins).toEqual(["gemini-3.8-flash"]);
    expect(report.listedCount).toBe(4);
    const flagship = report.evaluations[0].recommendations.filter((r) => r.verdict === "adopt");
    expect(flagship.map((r) => r.pinId).sort()).toEqual(
      ["aiflow-compile", "agent-run", "blog-text", "dashboard-chat", "voice-task"].sort()
    );
    expect(
      report.evaluations[0].recommendations.find((r) => r.pinId === "sms-chat")?.verdict
    ).toBe("skip");
    expect(
      report.evaluations[0].recommendations.find((r) => r.pinId === "webchat")?.verdict
    ).toBe("skip");
    expect(reportHasAdopt(report)).toBe(true);
    expect(reportHasWait(report)).toBe(true);
  });

  it("synthesizes a failed probe and still reports when Google lists a newer id we did not probe", () => {
    const report = evaluateListedModels({
      listedIds: ["gemini-3.8-flash"],
      pins: GEMINI_MODEL_PINS,
      probes: {},
      prices: PRICES,
      generatedAt: "t"
    });
    expect(report.evaluations[0].probe.generateContent.status).toBe(0);
    expect(report.evaluations[0].recommendations.every((r) => r.verdict !== "adopt")).toBe(true);
    expect(formatEvalReport(report)).toContain("generateContent=fail/0");
  });

  it("returns an empty evaluation when nothing listed is newer", () => {
    const report = evaluateListedModels({
      listedIds: ["gemini-3.7-flash", "gemini-3.5-flash-lite"],
      pins: GEMINI_MODEL_PINS,
      probes: {},
      prices: PRICES,
      generatedAt: "t"
    });
    expect(report.evaluations).toEqual([]);
    expect(formatEvalReport(report)).toContain("No candidates evaluated.");
    expect(reportHasAdopt(report)).toBe(false);
    expect(reportHasWait(report)).toBe(false);
  });
});

describe("formatEvalReport", () => {
  it("renders adopt/wait/skip/already groups and an unknown price", () => {
    const report = evaluateListedModels({
      listedIds: ["gemini-3.8-flash"],
      pins: GEMINI_MODEL_PINS,
      probes: { "gemini-3.8-flash": okProbe("gemini-3.8-flash") },
      prices: PRICES,
      generatedAt: "t"
    });
    const text = formatEvalReport(report);
    expect(text).toContain("## gemini-3.8-flash");
    expect(text).toContain("### adopt");
    expect(text).toContain("### skip");
    expect(text).toContain("### wait");
  });

  it("prints price unknown when the candidate has no rate", () => {
    const report = evaluateListedModels({
      listedIds: ["gemini-9.9-flash"],
      pins: [
        fakePin({
          id: "flag",
          defaultModel: "gemini-9.0-flash",
          family: "flagship",
          acceptsFamilies: ["flagship"]
        })
      ],
      probes: { "gemini-9.9-flash": okProbe("gemini-9.9-flash") },
      prices: {},
      generatedAt: "t"
    });
    expect(formatEvalReport(report)).toContain("price: unknown");
    expect(reportHasWait(report)).toBe(true);
  });
});

describe("recommendAllPins", () => {
  it("prices each pin from its own default, so webchat does not inherit flagship rates", () => {
    const rows = recommendAllPins(GEMINI_MODEL_PINS, "gemini-3.8-flash", {
      probe: okProbe("gemini-3.8-flash"),
      candidatePrice: { in: 1.5, out: 7.5 },
      prices: PRICES
    });
    expect(rows.find((r) => r.pinId === "webchat")?.verdict).toBe("skip");
    expect(rows.find((r) => r.pinId === "voice-task")?.verdict).toBe("adopt");
  });
});

describe("debug/gemini-model-eval.ts", () => {
  it("never takes a --model flag; Google's models.list is the only candidate source", () => {
    const src = readFileSync(join(__dirname, "../debug/gemini-model-eval.ts"), "utf8");
    expect(src).not.toMatch(/argValue\(\s*["']--model["']\s*\)/);
    expect(src).not.toMatch(/process\.argv\.includes\(["']--model["']\)/);
    expect(src).toContain("listGeminiModels");
    expect(src).toContain("findNewerCandidates(listed, GEMINI_MODEL_PINS)");
  });
});

function pinByIdRequired(id: string): GeminiModelPin {
  const pin = GEMINI_MODEL_PINS.find((p) => p.id === id);
  if (!pin) throw new Error(`missing pin ${id}`);
  return pin;
}
