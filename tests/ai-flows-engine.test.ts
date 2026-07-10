import { describe, expect, it } from "vitest";
import {
  allUrlsInText,
  buildClassifyPrompt,
  buildExtractionPrompt,
  CLASSIFY_UNCLEAR,
  parseClassifyChoice,
  buildNowScope,
  evaluateSmsTrigger,
  evaluateStepCondition,
  extractLeadIdentity,
  extractLinkByText,
  extractPhones,
  filterRosterByAvailability,
  firstUrlInText,
  hasUnresolvedPlaceholders,
  htmlToText,
  flowTriggers,
  isExecutableDefinition,
  isWithinWeeklyWindows,
  localClock,
  messagesInWindow,
  isE164,
  normalizeNanpToE164,
  parseExtractionJson,
  parseHmToMinutes,
  parseRoutedAgent,
  parseWeeklyWindows,
  pickRosterAgent,
  renderTemplate,
  resolvePath,
  safeRegexTest
} from "../supabase/functions/_shared/ai_flows/engine";
import type {
  AiFlowDefinition,
  SmsTrigger,
  TriggerContext
} from "../supabase/functions/_shared/ai_flows/types";

describe("extractLeadIdentity", () => {
  it("reads the canonical lead_name / lead_email keys, trimming + lowercasing email", () => {
    expect(
      extractLeadIdentity({ lead_name: "  William Unger ", lead_email: " Will@X.COM " })
    ).toEqual({ name: "William Unger", email: "will@x.com" });
  });

  it("falls back to alternate conventional keys (e.g. seller_first_name)", () => {
    expect(extractLeadIdentity({ seller_first_name: "William" })).toEqual({
      name: "William",
      email: null
    });
    expect(extractLeadIdentity({ contact_email: "a@b.co" })).toEqual({
      name: null,
      email: "a@b.co"
    });
  });

  it("prefers the higher-priority key when several are present", () => {
    expect(
      extractLeadIdentity({ name: "Generic", lead_name: "Specific", seller_first_name: "Mid" })
    ).toEqual({ name: "Specific", email: null });
  });

  it("ignores blank, whitespace-only, and non-string values", () => {
    expect(
      extractLeadIdentity({ lead_name: "   ", name: 42, lead_email: "", email: null })
    ).toEqual({ name: null, email: null });
  });

  it("returns nulls when nothing matches", () => {
    expect(extractLeadIdentity({ unrelated: "x" })).toEqual({ name: null, email: null });
  });
});

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

  it("matches a from_matches contact ref against pre-resolved identity values", () => {
    const ref = { source: "contact" as const, id: "22222222-2222-4222-8222-222222222222" };
    const trig: SmsTrigger = { channel: "sms", conditions: [{ type: "from_matches", ref }] };
    const refValues = new Map([["contact:22222222-2222-4222-8222-222222222222", ["+15559998888", "pat@x.com"]]]);
    expect(
      evaluateSmsTrigger(trig, ctx([{ text: "x", from: "+15559998888" }]), refValues).matched
    ).toBe(true);
    // A different sender does not match any candidate.
    expect(
      evaluateSmsTrigger(trig, ctx([{ text: "x", from: "+15550000000" }]), refValues).matched
    ).toBe(false);
    // No pre-resolved entry (deleted person / resolution failure) fails closed.
    expect(evaluateSmsTrigger(trig, ctx([{ text: "x", from: "+15559998888" }])).matched).toBe(false);
  });

  it("fails a from_matches with neither value nor ref (malformed row)", () => {
    const trig = {
      channel: "sms",
      conditions: [{ type: "from_matches" }]
    } as unknown as SmsTrigger;
    expect(evaluateSmsTrigger(trig, ctx([{ text: "x", from: "+15559998888" }])).matched).toBe(false);
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

describe("evaluateStepCondition", () => {
  it("equals matches case-insensitively by default", () => {
    expect(evaluateStepCondition({ var: "t", equals: "Buyer" }, { vars: { t: "buyer" } })).toBe(true);
    expect(evaluateStepCondition({ var: "t", equals: "buyer" }, { vars: { t: "seller" } })).toBe(false);
  });
  it("equals respects caseInsensitive=false", () => {
    expect(
      evaluateStepCondition({ var: "t", equals: "Buyer", caseInsensitive: false }, { vars: { t: "buyer" } })
    ).toBe(false);
    expect(
      evaluateStepCondition({ var: "t", equals: "buyer", caseInsensitive: false }, { vars: { t: "buyer" } })
    ).toBe(true);
  });
  it("contains matches substrings (e.g. '30% Buyer')", () => {
    expect(evaluateStepCondition({ var: "t", contains: "buyer" }, { vars: { t: "30% Buyer" } })).toBe(true);
    expect(evaluateStepCondition({ var: "t", contains: "seller" }, { vars: { t: "30% Buyer" } })).toBe(false);
  });
  it("contains respects caseInsensitive=false", () => {
    expect(
      evaluateStepCondition({ var: "t", contains: "Buyer", caseInsensitive: false }, { vars: { t: "30% buyer" } })
    ).toBe(false);
  });
  it("stringifies numeric/boolean vars before matching", () => {
    expect(evaluateStepCondition({ var: "n", equals: "42" }, { vars: { n: 42 } })).toBe(true);
    expect(evaluateStepCondition({ var: "b", contains: "ru" }, { vars: { b: true } })).toBe(true);
  });
  it("trims surrounding whitespace/newlines from string vars before matching", () => {
    expect(evaluateStepCondition({ var: "t", equals: "buyer" }, { vars: { t: "  buyer\n" } })).toBe(true);
    expect(evaluateStepCondition({ var: "t" }, { vars: { t: "   " } })).toBe(false);
  });
  it("treats missing/non-scalar vars as empty (never matches a non-empty needle)", () => {
    expect(evaluateStepCondition({ var: "t", contains: "buyer" }, { vars: {} })).toBe(false);
    expect(evaluateStepCondition({ var: "t", equals: "buyer" }, {})).toBe(false);
    expect(evaluateStepCondition({ var: "t", contains: "x" }, { vars: { t: { a: 1 } } })).toBe(false);
  });
  it("notEquals is the inverse of equals, case-insensitive by default", () => {
    expect(evaluateStepCondition({ var: "t", notEquals: "none" }, { vars: { t: "buyer" } })).toBe(true);
    expect(evaluateStepCondition({ var: "t", notEquals: "None" }, { vars: { t: "none" } })).toBe(false);
  });
  it("notEquals respects caseInsensitive=false", () => {
    expect(
      evaluateStepCondition({ var: "t", notEquals: "None", caseInsensitive: false }, { vars: { t: "none" } })
    ).toBe(true);
    expect(
      evaluateStepCondition({ var: "t", notEquals: "none", caseInsensitive: false }, { vars: { t: "none" } })
    ).toBe(false);
  });
  it("notEquals passes for a missing var against a non-empty needle (absent ≠ value)", () => {
    expect(evaluateStepCondition({ var: "t", notEquals: "none" }, { vars: {} })).toBe(true);
  });
  it("falls back to a presence check when neither equals nor contains is set", () => {
    expect(evaluateStepCondition({ var: "t" }, { vars: { t: "anything" } })).toBe(true);
    expect(evaluateStepCondition({ var: "t" }, { vars: { t: "" } })).toBe(false);
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

  it("strips script/style end tags with whitespace or trailing junk", () => {
    expect(htmlToText("<script >evil()</script >keep")).toBe("keep");
    expect(htmlToText("<style >.a{}</style >keep")).toBe("keep");
    // CodeQL bad-tag-filter case: end tag with trailing whitespace/junk.
    expect(htmlToText("<script>evil()</script\t\n bar>keep")).toBe("keep");
  });

  it("decodes &amp; last so it does not double-unescape", () => {
    // "&amp;lt;" must become the literal "&lt;", not "<".
    expect(htmlToText("a &amp;lt; b")).toBe("a &lt; b");
  });
});

describe("extractLinkByText", () => {
  const base = "https://portal.example.com/leads/abc";

  it("returns the resolved href of the first anchor whose visible text contains the match (the motivating case)", () => {
    const html =
      '<div><a href="/claim?id=9">Some other link</a>' +
      '<a href="https://hmlt.co/claim/9">Call me to claim referral</a></div>';
    expect(extractLinkByText(html, "Call me to claim referral", base)).toBe(
      "https://hmlt.co/claim/9"
    );
  });

  it("matches case-insensitively and ignores nested tags in the visible text", () => {
    const html = '<a href="/x"><span>CALL ME</span> to <b>claim</b></a>';
    expect(extractLinkByText(html, "call me to claim", base)).toBe(
      "https://portal.example.com/x"
    );
  });

  it("resolves a relative href against the page's final URL", () => {
    const html = '<a href="next/step">Continue</a>';
    expect(extractLinkByText(html, "Continue", base)).toBe(
      "https://portal.example.com/leads/next/step"
    );
  });

  it("supports single-quoted and unquoted hrefs", () => {
    expect(extractLinkByText("<a href='/q'>Quote</a>", "Quote", base)).toBe(
      "https://portal.example.com/q"
    );
    expect(extractLinkByText("<a href=https://e.com/u >Unq</a>", "Unq", base)).toBe(
      "https://e.com/u"
    );
  });

  it("returns empty string when no anchor's text matches", () => {
    expect(extractLinkByText('<a href="/x">Nope</a>', "claim referral", base)).toBe("");
  });

  it("returns empty string for empty html or empty matchText", () => {
    expect(extractLinkByText("", "anything", base)).toBe("");
    expect(extractLinkByText('<a href="/x">Hi</a>', "   ", base)).toBe("");
  });

  it("skips anchors with no usable href and keeps scanning for a resolvable one", () => {
    const html =
      '<a href="">Claim it</a>' + '<a href="javascript:void(0)">Claim it</a>' + '<a href="/real">Claim it</a>';
    expect(extractLinkByText(html, "Claim it", base)).toBe("https://portal.example.com/real");
  });

  it("returns empty string when a relative href can't be resolved without a base", () => {
    expect(extractLinkByText('<a href="rel/path">Go</a>', "Go", "")).toBe("");
  });
});

describe("buildClassifyPrompt / parseClassifyChoice", () => {
  const categories = [
    { value: "wants_a_call", description: "asks to talk" },
    { value: "not_interested" }
  ];

  it("builds a strict one-of prompt including the reserved unclear fallback", () => {
    const prompt = buildClassifyPrompt(categories, "call me pls", "Why are they shopping?");
    expect(prompt).toContain('- "wants_a_call": asks to talk');
    expect(prompt).toContain('- "not_interested"');
    expect(prompt).toContain('"unclear"');
    expect(prompt).toContain("Context: Why are they shopping?");
    expect(prompt).toContain("call me pls");
    // No question → no Context line.
    expect(buildClassifyPrompt(categories, "hi")).not.toContain("Context:");
    // Long messages are clipped to the cap.
    expect(buildClassifyPrompt(categories, "x".repeat(9000)).length).toBeLessThan(6000);
  });

  it("parses the choice case-insensitively, returning the author's exact casing", () => {
    expect(parseClassifyChoice('{"category":"WANTS_A_CALL"}', categories)).toBe("wants_a_call");
    expect(parseClassifyChoice('```json\n{"category":"not_interested"}\n```', categories)).toBe(
      "not_interested"
    );
  });

  it("falls back to unclear on hallucinated values, missing keys, and junk", () => {
    expect(parseClassifyChoice('{"category":"maybe_later"}', categories)).toBe(CLASSIFY_UNCLEAR);
    expect(parseClassifyChoice('{"answer":"wants_a_call"}', categories)).toBe(CLASSIFY_UNCLEAR);
    expect(parseClassifyChoice("not json at all", categories)).toBe(CLASSIFY_UNCLEAR);
    expect(parseClassifyChoice('{"category":""}', categories)).toBe(CLASSIFY_UNCLEAR);
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
  it("rejects a bad trigger (missing / unknown channel / non-array conditions)", () => {
    expect(isExecutableDefinition({ ...valid, trigger: undefined })).toBe(false);
    expect(
      isExecutableDefinition({ ...valid, trigger: { channel: "carrier_pigeon", conditions: [] } })
    ).toBe(false);
    expect(
      isExecutableDefinition({ ...valid, trigger: { channel: "sms", conditions: "x" } })
    ).toBe(false);
  });
  it("validates the additional-triggers array (each member a valid trigger; no voice)", () => {
    expect(
      isExecutableDefinition({
        ...valid,
        triggers: [{ channel: "webhook", conditions: [] }, { channel: "manual" }]
      })
    ).toBe(true);
    // Non-array / invalid member / voice member → not executable.
    expect(isExecutableDefinition({ ...valid, triggers: "x" })).toBe(false);
    expect(
      isExecutableDefinition({ ...valid, triggers: [{ channel: "sms", conditions: "x" }] })
    ).toBe(false);
    expect(
      isExecutableDefinition({ ...valid, triggers: [{ channel: "voice", fromE164: "+1" }] })
    ).toBe(false);
  });
  it("flowTriggers returns the ordered set (primary first)", () => {
    expect(flowTriggers(valid)).toEqual([valid.trigger]);
    const multi = {
      ...valid,
      triggers: [{ channel: "manual" } as const]
    };
    expect(flowTriggers(multi)).toEqual([valid.trigger, { channel: "manual" }]);
  });
  it("accepts the non-SMS trigger channels", () => {
    expect(isExecutableDefinition({ ...valid, trigger: { channel: "manual" } })).toBe(true);
    expect(
      isExecutableDefinition({
        ...valid,
        trigger: { channel: "schedule", time: "08:30", timezone: "America/Phoenix" }
      })
    ).toBe(true);
    expect(
      isExecutableDefinition({ ...valid, trigger: { channel: "schedule", everyMinutes: 60 } })
    ).toBe(true);
    expect(
      isExecutableDefinition({
        ...valid,
        trigger: { channel: "email", connectionId: "abc", conditions: [] }
      })
    ).toBe(true);
    expect(
      isExecutableDefinition({ ...valid, trigger: { channel: "tenant_email", conditions: [] } })
    ).toBe(true);
    expect(
      isExecutableDefinition({ ...valid, trigger: { channel: "webhook", conditions: [] } })
    ).toBe(true);
    expect(
      isExecutableDefinition({
        ...valid,
        trigger: { channel: "calendar", on: "event_created", conditions: [] }
      })
    ).toBe(true);
    expect(
      isExecutableDefinition({
        ...valid,
        trigger: { channel: "calendar", on: "event_start", leadMinutes: 30, conditions: [] }
      })
    ).toBe(true);
  });
  it("rejects malformed schedule / email triggers", () => {
    // schedule: neither mode, both modes, or a half-configured daily mode
    expect(isExecutableDefinition({ ...valid, trigger: { channel: "schedule" } })).toBe(false);
    expect(
      isExecutableDefinition({
        ...valid,
        trigger: {
          channel: "schedule",
          time: "08:30",
          timezone: "America/Phoenix",
          everyMinutes: 60
        }
      })
    ).toBe(false);
    expect(
      isExecutableDefinition({ ...valid, trigger: { channel: "schedule", time: "08:30" } })
    ).toBe(false);
    // email: missing connectionId / non-array conditions
    expect(
      isExecutableDefinition({ ...valid, trigger: { channel: "email", conditions: [] } })
    ).toBe(false);
    expect(
      isExecutableDefinition({
        ...valid,
        trigger: { channel: "email", connectionId: "abc", conditions: "x" }
      })
    ).toBe(false);
    // tenant_email: non-array conditions
    expect(
      isExecutableDefinition({ ...valid, trigger: { channel: "tenant_email", conditions: "x" } })
    ).toBe(false);
    // webhook: non-array conditions
    expect(
      isExecutableDefinition({ ...valid, trigger: { channel: "webhook", conditions: "x" } })
    ).toBe(false);
    // calendar: non-array conditions, unknown mode, event_start without a lead
    expect(
      isExecutableDefinition({
        ...valid,
        trigger: { channel: "calendar", on: "event_created", conditions: "x" }
      })
    ).toBe(false);
    expect(
      isExecutableDefinition({
        ...valid,
        trigger: { channel: "calendar", on: "event_deleted", conditions: [] }
      })
    ).toBe(false);
    expect(
      isExecutableDefinition({
        ...valid,
        trigger: { channel: "calendar", on: "event_start", conditions: [] }
      })
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

describe("isE164", () => {
  it("accepts valid E.164 numbers", () => {
    expect(isE164("+16026866672")).toBe(true);
    expect(isE164("+447911123456")).toBe(true);
  });
  it("rejects malformed numbers", () => {
    expect(isE164("6026866672")).toBe(false);
    expect(isE164("+0123456789")).toBe(false);
    expect(isE164("+1")).toBe(false);
    expect(isE164("+1602686667a")).toBe(false);
  });
});

describe("parseRoutedAgent", () => {
  it("parses a name/phone object", () => {
    expect(parseRoutedAgent('{"name":"Dana","phone":"+16026866672"}')).toEqual({
      name: "Dana",
      phone: "+16026866672"
    });
  });
  it("tolerates fenced/prose-wrapped JSON", () => {
    const raw = 'Here you go:\n```json\n{"name":"Dana","phone":"+16026866672"}\n```';
    expect(parseRoutedAgent(raw)).toEqual({ name: "Dana", phone: "+16026866672" });
  });
  it("normalizes a loose North-American phone and trims the name", () => {
    expect(parseRoutedAgent('{"name":"  Dana  ","phone":"(602) 686-6672"}')).toEqual({
      name: "Dana",
      phone: "+16026866672"
    });
  });
  it("defaults a missing name to empty string", () => {
    expect(parseRoutedAgent('{"phone":"+16026866672"}')).toEqual({
      name: "",
      phone: "+16026866672"
    });
  });
  it("returns null for {none:true}", () => {
    expect(parseRoutedAgent('{"none":true}')).toBeNull();
  });
  it("returns null when no JSON / no usable phone is present", () => {
    expect(parseRoutedAgent("sorry, nobody is free")).toBeNull();
    expect(parseRoutedAgent('{"name":"Dana"}')).toBeNull();
    expect(parseRoutedAgent('{"name":"Dana","phone":"not-a-number"}')).toBeNull();
  });
});

describe("pickRosterAgent", () => {
  const roster = [
    { name: "Jason", phone: "+14807039575" },
    { name: "Gabby", phone: "+14807202013" },
    { name: "Dave", phone: "+16025245719" }
  ];

  it("picks the first member (callers pass rotation-ordered rows)", () => {
    expect(pickRosterAgent(roster, [])).toEqual({
      index: 0,
      agent: { name: "Jason", phone: "+14807039575" }
    });
  });

  it("skips members already tried for this run", () => {
    expect(pickRosterAgent(roster, ["+14807039575", "+14807202013"])).toEqual({
      index: 2,
      agent: { name: "Dave", phone: "+16025245719" }
    });
  });

  it("returns null when every member has been tried (owner fallback)", () => {
    expect(
      pickRosterAgent(roster, ["+14807039575", "+14807202013", "+16025245719"])
    ).toBeNull();
  });

  it("normalizes loose NANP phones and skips unusable ones", () => {
    const loose = [
      { name: "Broken", phone: "12" },
      { name: "Jason", phone: "480 703 9575" }
    ];
    expect(pickRosterAgent(loose, [])).toEqual({
      index: 1,
      agent: { name: "Jason", phone: "+14807039575" }
    });
  });

  it("never offers the lead their own number", () => {
    expect(pickRosterAgent(roster, [], "+14807039575")).toEqual({
      index: 1,
      agent: { name: "Gabby", phone: "+14807202013" }
    });
  });

  it("returns null for an empty roster", () => {
    expect(pickRosterAgent([], [])).toBeNull();
  });
});

describe("parseHmToMinutes", () => {
  it("parses padded and unpadded HH:MM", () => {
    expect(parseHmToMinutes("09:00")).toBe(540);
    expect(parseHmToMinutes("9:05")).toBe(545);
    expect(parseHmToMinutes("0:00")).toBe(0);
    expect(parseHmToMinutes("23:59")).toBe(1439);
    expect(parseHmToMinutes(" 12:30 ")).toBe(750);
  });

  it("rejects out-of-range and malformed values", () => {
    expect(parseHmToMinutes("24:00")).toBeNull();
    expect(parseHmToMinutes("12:60")).toBeNull();
    expect(parseHmToMinutes("noon")).toBeNull();
    expect(parseHmToMinutes("12-30")).toBeNull();
    expect(parseHmToMinutes("12:3")).toBeNull();
    expect(parseHmToMinutes("")).toBeNull();
  });
});

describe("localClock", () => {
  // 2026-06-11T06:23:00Z is a Thursday in UTC but still Wednesday night in
  // Phoenix (UTC-7, no DST) — the exact cross-midnight case time-off and
  // schedule checks must get right.
  const instant = new Date("2026-06-11T06:23:00Z");

  it("resolves the business-local date, weekday, and minutes", () => {
    expect(localClock(instant, "America/Phoenix")).toEqual({
      isoDate: "2026-06-10",
      weekday: "wed",
      minutes: 23 * 60 + 23
    });
  });

  it("defaults to UTC when the timezone is null, undefined, or blank", () => {
    const utc = { isoDate: "2026-06-11", weekday: "thu", minutes: 6 * 60 + 23 };
    expect(localClock(instant, null)).toEqual(utc);
    expect(localClock(instant, undefined)).toEqual(utc);
    expect(localClock(instant, "  ")).toEqual(utc);
  });

  it("falls back to UTC on an invalid IANA name instead of throwing (typos must never stop routing)", () => {
    expect(localClock(instant, "Not/AZone")).toEqual({
      isoDate: "2026-06-11",
      weekday: "thu",
      minutes: 6 * 60 + 23
    });
  });
});

describe("parseWeeklyWindows", () => {
  it("parses the stored jsonb shape into minute windows", () => {
    expect(
      parseWeeklyWindows({ mon: [["09:00", "17:00"]], sat: [["10:00", "12:00"], ["13:00", "15:00"]] })
    ).toEqual({
      mon: [[540, 1020]],
      sat: [[600, 720], [780, 900]]
    });
  });

  it("returns null for non-objects, arrays, and empty objects", () => {
    expect(parseWeeklyWindows(null)).toBeNull();
    expect(parseWeeklyWindows(undefined)).toBeNull();
    expect(parseWeeklyWindows("mon 9-5")).toBeNull();
    expect(parseWeeklyWindows([["09:00", "17:00"]])).toBeNull();
    expect(parseWeeklyWindows({})).toBeNull();
  });

  it("drops malformed windows (wrong shape, bad times, inverted ranges) and unknown day keys", () => {
    expect(
      parseWeeklyWindows({
        mon: [
          "not-a-window",
          ["09:00"],
          [42, "17:00"],
          ["09:00", 42],
          ["25:00", "26:00"],
          ["17:00", "09:00"],
          ["09:00", "09:00"],
          ["09:00", "17:00"]
        ],
        funday: [["09:00", "17:00"]],
        tue: "closed"
      })
    ).toEqual({ mon: [[540, 1020]] });
  });

  it("returns null when every entry is malformed", () => {
    expect(parseWeeklyWindows({ mon: [["17:00", "09:00"]] })).toBeNull();
  });
});

describe("isWithinWeeklyWindows", () => {
  const windows = { mon: [[540, 1020]] } as ReturnType<typeof parseWeeklyWindows> & object;

  it("is true inside a window (start inclusive, end exclusive)", () => {
    expect(isWithinWeeklyWindows(windows, { isoDate: "2026-06-08", weekday: "mon", minutes: 540 })).toBe(true);
    expect(isWithinWeeklyWindows(windows, { isoDate: "2026-06-08", weekday: "mon", minutes: 1019 })).toBe(true);
    expect(isWithinWeeklyWindows(windows, { isoDate: "2026-06-08", weekday: "mon", minutes: 1020 })).toBe(false);
    expect(isWithinWeeklyWindows(windows, { isoDate: "2026-06-08", weekday: "mon", minutes: 539 })).toBe(false);
  });

  it("is false on a day with no windows", () => {
    expect(isWithinWeeklyWindows(windows, { isoDate: "2026-06-09", weekday: "tue", minutes: 600 })).toBe(false);
  });
});

describe("filterRosterByAvailability", () => {
  const monMorning = { isoDate: "2026-06-08", weekday: "mon" as const, minutes: 600 };
  const member = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    phone_e164: `+1480555${id.padStart(4, "0")}`,
    ...extra
  });

  it("hard-skips members on time off (supersedes everything, including pinned routing upstream)", () => {
    const roster = [member("1"), member("2")];
    expect(filterRosterByAvailability(roster, new Set(["1"]), monMorning).map((m) => m.id)).toEqual([
      "2"
    ]);
  });

  it("hard-skips members outside their weekly schedule; no schedule = always available", () => {
    const roster = [
      member("works-now", { weekly_schedule: { mon: [["09:00", "17:00"]] } }),
      member("off-today", { weekly_schedule: { tue: [["09:00", "17:00"]] } }),
      member("no-schedule")
    ];
    expect(filterRosterByAvailability(roster, new Set(), monMorning).map((m) => m.id)).toEqual([
      "works-now",
      "no-schedule"
    ]);
  });

  it("treats an unparseable schedule as unset (owner typo must not bench an employee)", () => {
    const roster = [member("garbled", { weekly_schedule: { mon: [["17:00", "09:00"]] } })];
    expect(filterRosterByAvailability(roster, new Set(), monMorning).map((m) => m.id)).toEqual([
      "garbled"
    ]);
  });

  it("floats members inside a preferred window to the front, preserving rotation order otherwise", () => {
    const roster = [
      member("first-in-rotation"),
      member("prefers-now", { preferred_windows: { mon: [["09:00", "12:00"]] } }),
      member("prefers-later", { preferred_windows: { mon: [["18:00", "20:00"]] } })
    ];
    expect(filterRosterByAvailability(roster, new Set(), monMorning).map((m) => m.id)).toEqual([
      "prefers-now",
      "first-in-rotation",
      "prefers-later"
    ]);
  });

  it("returns an empty array when everyone is out (worker falls back to the owner)", () => {
    const roster = [
      member("away", { weekly_schedule: { tue: [["09:00", "17:00"]] } }),
      member("off")
    ];
    expect(filterRosterByAvailability(roster, new Set(["off"]), monMorning)).toEqual([]);
  });
});

describe("buildNowScope", () => {
  // 2026-06-17 18:00 UTC = 11:00 in America/Phoenix (UTC-7, no DST).
  const ms = Date.parse("2026-06-17T18:00:00Z");

  it("computes today/tomorrow date parts in the business timezone", () => {
    const now = buildNowScope(ms, "America/Phoenix");
    expect(now.today).toEqual({
      weekday: "Wednesday",
      month: "June",
      monthNum: "06",
      day: "17",
      dayOrdinal: "17th",
      year: "2026",
      iso: "2026-06-17"
    });
    expect(now.tomorrow.weekday).toBe("Thursday");
    expect(now.tomorrow.dayOrdinal).toBe("18th");
    expect(now.tomorrow.iso).toBe("2026-06-18");
    // Seven calendar days out from the 17th -> the 24th.
    expect(now.in7Days.weekday).toBe("Wednesday");
    expect(now.in7Days.dayOrdinal).toBe("24th");
    expect(now.in7Days.iso).toBe("2026-06-24");
    expect(now.afternoonTime).toBe("14:00");
  });

  it("rolls the date across a timezone's midnight", () => {
    // 06:30 UTC is still the prior evening in Phoenix (UTC-7) -> 23:30 on the 16th.
    const lateNight = Date.parse("2026-06-17T06:30:00Z");
    expect(buildNowScope(lateNight, "America/Phoenix").today.iso).toBe("2026-06-16");
  });

  it("produces correct ordinals (1st, 2nd, 3rd, 11th, 21st)", () => {
    expect(buildNowScope(Date.parse("2026-06-01T18:00:00Z"), "UTC").today.dayOrdinal).toBe("1st");
    expect(buildNowScope(Date.parse("2026-06-02T18:00:00Z"), "UTC").today.dayOrdinal).toBe("2nd");
    expect(buildNowScope(Date.parse("2026-06-03T18:00:00Z"), "UTC").today.dayOrdinal).toBe("3rd");
    expect(buildNowScope(Date.parse("2026-06-11T18:00:00Z"), "UTC").today.dayOrdinal).toBe("11th");
    expect(buildNowScope(Date.parse("2026-06-21T18:00:00Z"), "UTC").today.dayOrdinal).toBe("21st");
  });

  it("falls open to UTC on an invalid timezone", () => {
    const now = buildNowScope(ms, "Not/AZone");
    expect(now.today.iso).toBe("2026-06-17");
  });

  it("defaults to UTC when no timezone is given", () => {
    expect(buildNowScope(ms).today.iso).toBe("2026-06-17");
    expect(buildNowScope(ms, null).today.iso).toBe("2026-06-17");
    expect(buildNowScope(ms, "   ").today.iso).toBe("2026-06-17");
  });
});
