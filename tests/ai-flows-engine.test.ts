import { describe, expect, it } from "vitest";
import {
  allUrlsInText,
  buildExtractionPrompt,
  evaluateSmsTrigger,
  extractPhones,
  firstUrlInText,
  hasUnresolvedPlaceholders,
  htmlToText,
  isExecutableDefinition,
  messagesInWindow,
  normalizeNanpToE164,
  parseExtractionJson,
  renderTemplate,
  resolvePath,
  safeRegexTest
} from "../supabase/functions/_shared/ai_flows/engine";
import type {
  AiFlowDefinition,
  SmsTrigger,
  TriggerContext
} from "../supabase/functions/_shared/ai_flows/types";

describe("firstUrlInText", () => {
  it("finds a url and trims trailing punctuation", () => {
    expect(firstUrlInText("see https://rfrl.to/abc123.")).toBe("https://rfrl.to/abc123");
  });
  it("returns null when no url present", () => {
    expect(firstUrlInText("no link here")).toBeNull();
  });
});

describe("allUrlsInText", () => {
  it("returns deduped urls in order", () => {
    expect(
      allUrlsInText("a https://x.com b https://y.com, then https://x.com again")
    ).toEqual(["https://x.com", "https://y.com"]);
  });
  it("returns empty array when none", () => {
    expect(allUrlsInText("nothing")).toEqual([]);
  });
});

describe("safeRegexTest", () => {
  it("matches case-insensitively by default", () => {
    expect(safeRegexTest("lead", "New LEAD arrived")).toBe(true);
  });
  it("respects case-sensitive mode", () => {
    expect(safeRegexTest("LEAD", "lead", false)).toBe(false);
  });
  it("returns false (never throws) for an invalid pattern", () => {
    expect(safeRegexTest("(", "anything")).toBe(false);
  });
});

describe("messagesInWindow", () => {
  const base = 1_000_000_000_000;
  const ctx: TriggerContext = {
    nowMs: base,
    messages: [
      { text: "old", from: "+1", atMs: base - 30 * 60_000 },
      { text: "recent", from: "+1", atMs: base - 5 * 60_000 },
      { text: "future", from: "+1", atMs: base + 60_000 }
    ]
  };
  it("keeps messages within the window and future ones, drops stale", () => {
    const got = messagesInWindow(ctx, 10).map((m) => m.text);
    expect(got).toEqual(["recent", "future"]);
  });
  it("defaults nowMs to Date.now when omitted", () => {
    const recent: TriggerContext = {
      messages: [{ text: "now", from: "+1", atMs: Date.now() }]
    };
    expect(messagesInWindow(recent, 10).map((m) => m.text)).toEqual(["now"]);
  });
});

describe("evaluateSmsTrigger", () => {
  const base = 2_000_000_000_000;
  function ctx(texts: { text: string; from?: string }[]): TriggerContext {
    return {
      nowMs: base,
      messages: texts.map((t) => ({ text: t.text, from: t.from ?? "+15550001111", atMs: base }))
    };
  }

  it("matches any inbound SMS with empty conditions", () => {
    const trig: SmsTrigger = { channel: "sms", conditions: [] };
    const r = evaluateSmsTrigger(trig, ctx([{ text: "hi" }]));
    expect(r.matched).toBe(true);
    expect(r.url).toBeNull();
    expect(r.windowText).toBe("hi");
  });

  it("AND-s contains + has_url across the correlation window and extracts the url", () => {
    const trig: SmsTrigger = {
      channel: "sms",
      correlationWindowMinutes: 15,
      conditions: [{ type: "contains", value: "referral" }, { type: "has_url" }]
    };
    const r = evaluateSmsTrigger(
      trig,
      ctx([{ text: "New referral lead" }, { text: "details https://rfrl.to/xy" }])
    );
    expect(r.matched).toBe(true);
    expect(r.url).toBe("https://rfrl.to/xy");
  });

  it("fails when a condition is unmet", () => {
    const trig: SmsTrigger = {
      channel: "sms",
      conditions: [{ type: "regex", value: "^lead" }]
    };
    expect(evaluateSmsTrigger(trig, ctx([{ text: "not a lead" }])).matched).toBe(false);
  });

  it("honors case-sensitive contains", () => {
    const cs: SmsTrigger = {
      channel: "sms",
      conditions: [{ type: "contains", value: "Lead", caseInsensitive: false }]
    };
    expect(evaluateSmsTrigger(cs, ctx([{ text: "new lead" }])).matched).toBe(false);
    expect(evaluateSmsTrigger(cs, ctx([{ text: "new Lead" }])).matched).toBe(true);
  });

  it("matches on sender via from_matches", () => {
    const trig: SmsTrigger = {
      channel: "sms",
      conditions: [{ type: "from_matches", value: "15559998888" }]
    };
    expect(
      evaluateSmsTrigger(trig, ctx([{ text: "x", from: "+15559998888" }])).matched
    ).toBe(true);
  });

  it("uses empty latestFrom when the window is empty", () => {
    const trig: SmsTrigger = {
      channel: "sms",
      conditions: [{ type: "from_matches", value: "anything" }]
    };
    const empty: TriggerContext = { nowMs: base, messages: [] };
    expect(evaluateSmsTrigger(trig, empty).matched).toBe(false);
  });
});

describe("resolvePath", () => {
  const scope = { vars: { seller_phone: "+15551234567", nested: { a: 1 } }, n: 3 };
  it("resolves a dotted path", () => {
    expect(resolvePath(scope, "vars.seller_phone")).toBe("+15551234567");
  });
  it("resolves a top-level key", () => {
    expect(resolvePath(scope, "n")).toBe(3);
  });
  it("returns undefined when traversing through a non-object", () => {
    expect(resolvePath(scope, "vars.seller_phone.nope")).toBeUndefined();
  });
  it("returns undefined for a missing key", () => {
    expect(resolvePath(scope, "missing")).toBeUndefined();
  });
});

describe("renderTemplate", () => {
  const scope = { vars: { phone: "+15551234567", count: 2, ok: true, obj: {}, empty: null } };
  it("substitutes string, number, and boolean values", () => {
    expect(renderTemplate("p={{vars.phone}} c={{vars.count}} ok={{vars.ok}}", scope)).toBe(
      "p=+15551234567 c=2 ok=true"
    );
  });
  it("renders null/undefined/object values as empty string", () => {
    expect(renderTemplate("[{{vars.empty}}][{{vars.obj}}][{{vars.missing}}]", scope)).toBe(
      "[][][]"
    );
  });
});

describe("hasUnresolvedPlaceholders", () => {
  it("is true when a placeholder is missing/empty", () => {
    expect(hasUnresolvedPlaceholders("hi {{vars.x}}", { vars: { x: "" } })).toBe(true);
    expect(hasUnresolvedPlaceholders("hi {{vars.y}}", { vars: {} })).toBe(true);
  });
  it("is false when all placeholders resolve", () => {
    expect(hasUnresolvedPlaceholders("hi {{vars.x}}", { vars: { x: "ok" } })).toBe(false);
  });
  it("is false with no placeholders (and resets between calls)", () => {
    expect(hasUnresolvedPlaceholders("plain", {})).toBe(false);
    expect(hasUnresolvedPlaceholders("plain", {})).toBe(false);
  });
});

describe("normalizeNanpToE164", () => {
  it("normalizes 10 digits", () => {
    expect(normalizeNanpToE164("(602) 686-6672")).toBe("+16026866672");
  });
  it("normalizes 11 digits starting with 1", () => {
    expect(normalizeNanpToE164("1-602-686-6672")).toBe("+16026866672");
  });
  it("returns null for an implausible length", () => {
    expect(normalizeNanpToE164("12345")).toBeNull();
  });
});

describe("extractPhones", () => {
  it("extracts deduped E.164 numbers", () => {
    const text = "call 602-686-6672 or (602) 686-6672 or 480.555.1212";
    expect(extractPhones(text)).toEqual(["+16026866672", "+14805551212"]);
  });
  it("returns empty when no phones", () => {
    expect(extractPhones("no digits here")).toEqual([]);
  });
});

describe("buildExtractionPrompt", () => {
  it("includes field names with and without descriptions", () => {
    const p = buildExtractionPrompt(
      [{ name: "seller_phone", description: "the seller's phone" }, { name: "price" }],
      "Seller phone 602-686-6672, price $10"
    );
    expect(p).toContain("- seller_phone: the seller's phone");
    expect(p).toContain("- price\n");
    expect(p).toContain("price $10");
  });
  it("truncates long page text to maxChars", () => {
    const long = "x".repeat(50);
    const p = buildExtractionPrompt([{ name: "a" }], long, 10);
    expect(p).toContain("x".repeat(10));
    expect(p).not.toContain("x".repeat(11));
  });
});

describe("parseExtractionJson", () => {
  const fields = [{ name: "seller_phone" }, { name: "price" }, { name: "active" }];
  it("parses a JSON object and coerces non-strings", () => {
    const raw = '```json\n{"seller_phone":"+16026866672","price":10,"active":true,"junk":"x"}\n```';
    expect(parseExtractionJson(raw, fields)).toEqual({
      seller_phone: "+16026866672",
      price: "10",
      active: "true"
    });
  });
  it("defaults missing/non-primitive fields to empty string", () => {
    const raw = '{"seller_phone":null,"price":["a"]}';
    expect(parseExtractionJson(raw, fields)).toEqual({
      seller_phone: "",
      price: "",
      active: ""
    });
  });
  it("returns all-empty defaults when no JSON object is present", () => {
    expect(parseExtractionJson("sorry, nothing", fields)).toEqual({
      seller_phone: "",
      price: "",
      active: ""
    });
  });
  it("handles strings containing braces and escaped quotes", () => {
    const raw = 'prefix {"seller_phone":"a\\"b}c"} suffix';
    expect(parseExtractionJson(raw, [{ name: "seller_phone" }])).toEqual({
      seller_phone: 'a"b}c'
    });
  });
  it("handles nested objects (depth > 1)", () => {
    const raw = '{"seller_phone":"x","meta":{"k":"v"}}';
    expect(parseExtractionJson(raw, [{ name: "seller_phone" }])).toEqual({
      seller_phone: "x"
    });
  });
  it("returns defaults on unbalanced/invalid JSON", () => {
    expect(parseExtractionJson('{"seller_phone":', [{ name: "seller_phone" }])).toEqual({
      seller_phone: ""
    });
    expect(parseExtractionJson("{not json}", [{ name: "seller_phone" }])).toEqual({
      seller_phone: ""
    });
  });
});

describe("htmlToText", () => {
  it("strips scripts, styles, tags and decodes entities", () => {
    const html =
      "<html><head><style>.a{color:red}</style><script>var x=1;</script></head>" +
      "<body><p>Call&nbsp;Bob &amp; &lt;Co&gt; &quot;now&quot; it&#39;s open</p></body></html>";
    expect(htmlToText(html)).toBe('Call Bob & <Co> "now" it\'s open');
  });

  it("strips script/style end tags that contain whitespace", () => {
    expect(htmlToText("<script >evil()</script >keep")).toBe("keep");
    expect(htmlToText("<style >.a{}</style >keep")).toBe("keep");
  });

  it("decodes &amp; last so it does not double-unescape", () => {
    // "&amp;lt;" must become the literal "&lt;", not "<".
    expect(htmlToText("a &amp;lt; b")).toBe("a &lt; b");
  });
});

describe("isExecutableDefinition", () => {
  const valid: AiFlowDefinition = {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
    steps: [{ id: "s1", type: "extract_url", saveAs: "url" }]
  };
  it("accepts a valid definition", () => {
    expect(isExecutableDefinition(valid)).toBe(true);
  });
  it("rejects non-objects", () => {
    expect(isExecutableDefinition(null)).toBe(false);
    expect(isExecutableDefinition("nope")).toBe(false);
  });
  it("rejects a wrong version", () => {
    expect(isExecutableDefinition({ ...valid, version: 2 })).toBe(false);
  });
  it("rejects a bad trigger (missing / wrong channel / non-array conditions)", () => {
    expect(isExecutableDefinition({ ...valid, trigger: undefined })).toBe(false);
    expect(
      isExecutableDefinition({ ...valid, trigger: { channel: "email", conditions: [] } })
    ).toBe(false);
    expect(
      isExecutableDefinition({ ...valid, trigger: { channel: "sms", conditions: "x" } })
    ).toBe(false);
  });
  it("rejects non-array steps", () => {
    expect(isExecutableDefinition({ ...valid, steps: "x" })).toBe(false);
  });
  it("rejects malformed steps", () => {
    expect(isExecutableDefinition({ ...valid, steps: [null] })).toBe(false);
    expect(isExecutableDefinition({ ...valid, steps: [{ id: "s1" }] })).toBe(false);
    expect(isExecutableDefinition({ ...valid, steps: [{ type: "send_sms" }] })).toBe(false);
  });
});
