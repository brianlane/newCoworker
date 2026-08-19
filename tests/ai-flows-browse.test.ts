import { describe, expect, it } from "vitest";
import {
  decideForEach,
  encodeForEachProgress,
  forEachOutcomeVars,
  forEachProgressVar,
  forEachResultVars,
  isUnsafeBrowseHost,
  normalizeBrowseUrl,
  parseActionResponse,
  parseForEachProgress,
  parseRenderResponse,
  renderErrorFields,
  renderErrorKind,
  type ForEachSummary
} from "../supabase/functions/_shared/ai_flows/browse";

describe("isUnsafeBrowseHost", () => {
  it.each([
    ["localhost", true],
    ["api.localhost", true],
    ["metadata", true],
    ["metadata.google.internal", true],
    ["db.internal", true],
    ["::1", true],
    ["fd00::1", true],
    ["0.0.0.0", true],
    ["10.1.2.3", true],
    ["127.0.0.1", true],
    ["169.254.169.254", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["100.64.0.1", true],
    ["224.0.0.1", true],
    ["255.255.255.255", true],
    ["256.1.1.1", true],
    // not a 4-octet literal → treated as a (non-resolving) hostname, not unsafe
    ["1.2.3", false],
    // public / safe
    ["rfrl.to", false],
    ["www.referralexchange.com", false],
    ["8.8.8.8", false],
    ["172.15.0.1", false],
    ["172.32.0.1", false],
    ["100.63.0.1", false],
    ["100.128.0.1", false],
    ["192.167.0.1", false],
    ["169.253.0.1", false]
  ])("classifies %s unsafe=%s", (host, expected) => {
    expect(isUnsafeBrowseHost(host)).toBe(expected);
  });
});

describe("normalizeBrowseUrl", () => {
  it("returns a canonical https URL", () => {
    expect(normalizeBrowseUrl("https://rfrl.to/abc")).toBe("https://rfrl.to/abc");
  });
  it("allows http too", () => {
    expect(normalizeBrowseUrl("http://example.com/x")).toBe("http://example.com/x");
  });
  it("rejects unparseable input", () => {
    expect(normalizeBrowseUrl("not a url")).toBeNull();
  });
  it("rejects non-http(s) schemes", () => {
    expect(normalizeBrowseUrl("ftp://example.com")).toBeNull();
    expect(normalizeBrowseUrl("file:///etc/passwd")).toBeNull();
  });
  it("rejects unsafe hosts", () => {
    expect(normalizeBrowseUrl("http://169.254.169.254/latest/meta-data")).toBeNull();
    expect(normalizeBrowseUrl("http://localhost:3000")).toBeNull();
  });
});

describe("parseRenderResponse", () => {
  it("accepts a full contract body", () => {
    expect(
      parseRenderResponse(
        { finalUrl: "https://x.com/final", text: "hello", html: "<p>hello</p>" },
        "https://x.com/req"
      )
    ).toEqual({ finalUrl: "https://x.com/final", text: "hello", html: "<p>hello</p>" });
  });
  it("falls back to requestedUrl when finalUrl missing", () => {
    expect(parseRenderResponse({ text: "hi" }, "https://x.com/req")).toEqual({
      finalUrl: "https://x.com/req",
      text: "hi",
      html: ""
    });
  });
  it("accepts html-only bodies", () => {
    expect(parseRenderResponse({ html: "<p>x</p>" }, "https://x.com/req")).toEqual({
      finalUrl: "https://x.com/req",
      text: "",
      html: "<p>x</p>"
    });
  });
  it("carries a screenshotBase64 through when present", () => {
    expect(
      parseRenderResponse({ text: "hi", screenshotBase64: "aGVsbG8=" }, "https://x.com/req")
    ).toEqual({
      finalUrl: "https://x.com/req",
      text: "hi",
      html: "",
      screenshotBase64: "aGVsbG8="
    });
  });
  it("drops an empty or non-string screenshotBase64", () => {
    expect(parseRenderResponse({ text: "hi", screenshotBase64: "" }, "u")).toEqual({
      finalUrl: "u",
      text: "hi",
      html: ""
    });
    expect(parseRenderResponse({ text: "hi", screenshotBase64: 42 }, "u")).toEqual({
      finalUrl: "u",
      text: "hi",
      html: ""
    });
  });
  it("rejects non-object or empty bodies", () => {
    expect(parseRenderResponse(null, "u")).toBeNull();
    expect(parseRenderResponse("nope", "u")).toBeNull();
    expect(parseRenderResponse({}, "u")).toBeNull();
    expect(parseRenderResponse({ finalUrl: "x" }, "u")).toBeNull();
  });
});

describe("renderErrorKind", () => {
  it.each([
    ["login_failed", "login"],
    ["auth_config_error", "login"],
    ["action_failed", "action"],
    ["render_failed", "transient"],
    ["", "transient"],
    ["something_unknown", "transient"]
  ])("maps %s -> %s", (code, expected) => {
    expect(renderErrorKind(code)).toBe(expected);
  });
});

describe("renderErrorFields", () => {
  it("pulls string error + detail", () => {
    expect(renderErrorFields({ error: "action_failed", detail: "click timeout" })).toEqual({
      error: "action_failed",
      detail: "click timeout"
    });
  });
  it("treats a success body (no error) as empty", () => {
    expect(renderErrorFields({ finalUrl: "x", actionsCompleted: 3 })).toEqual({
      error: "",
      detail: ""
    });
  });
  it("ignores non-string error/detail", () => {
    expect(renderErrorFields({ error: 42, detail: { x: 1 } })).toEqual({ error: "", detail: "" });
  });
  it("returns empty for non-object bodies", () => {
    expect(renderErrorFields(null)).toEqual({ error: "", detail: "" });
    expect(renderErrorFields("nope")).toEqual({ error: "", detail: "" });
    expect(renderErrorFields(undefined)).toEqual({ error: "", detail: "" });
  });
});

describe("parseActionResponse", () => {
  it("accepts a full action-mode body", () => {
    expect(
      parseActionResponse(
        {
          finalUrl: "https://x.com/final",
          actionsCompleted: 3,
          text: "Lead accepted",
          html: "<p>Lead accepted</p>",
          screenshotBase64: "aGVsbG8="
        },
        "https://x.com/req"
      )
    ).toEqual({
      finalUrl: "https://x.com/final",
      actionsCompleted: 3,
      text: "Lead accepted",
      html: "<p>Lead accepted</p>",
      screenshotBase64: "aGVsbG8="
    });
  });
  it("falls back to requestedUrl and floors a fractional count", () => {
    expect(parseActionResponse({ actionsCompleted: 2.7 }, "https://x.com/req")).toEqual({
      finalUrl: "https://x.com/req",
      actionsCompleted: 2,
      text: "",
      html: ""
    });
  });
  it("defaults text/html to empty strings when the service omits them", () => {
    // An older render service (pre same-pass-extraction) returns no text/html;
    // a browse_action WITHOUT fields must still parse cleanly.
    expect(parseActionResponse({ actionsCompleted: 1 }, "u")).toEqual({
      finalUrl: "u",
      actionsCompleted: 1,
      text: "",
      html: ""
    });
  });
  it("drops empty/non-string screenshots", () => {
    expect(parseActionResponse({ actionsCompleted: 1, screenshotBase64: "" }, "u")).toEqual({
      finalUrl: "u",
      actionsCompleted: 1,
      text: "",
      html: ""
    });
    expect(parseActionResponse({ actionsCompleted: 1, screenshotBase64: 42 }, "u")).toEqual({
      finalUrl: "u",
      actionsCompleted: 1,
      text: "",
      html: ""
    });
  });
  it("rejects bodies without a valid actionsCompleted", () => {
    expect(parseActionResponse(null, "u")).toBeNull();
    expect(parseActionResponse("nope", "u")).toBeNull();
    expect(parseActionResponse({}, "u")).toBeNull();
    expect(parseActionResponse({ actionsCompleted: "3" }, "u")).toBeNull();
    expect(parseActionResponse({ actionsCompleted: -1 }, "u")).toBeNull();
    expect(parseActionResponse({ actionsCompleted: Number.NaN }, "u")).toBeNull();
  });

  it("parses a forEach loop summary", () => {
    expect(
      parseActionResponse(
        {
          finalUrl: "https://portal/leads",
          actionsCompleted: 12,
          forEach: { items: 3, succeeded: 2, failed: 1, errors: ["lead-3: select_option \"No\": timeout"] }
        },
        "u"
      )
    ).toEqual({
      finalUrl: "https://portal/leads",
      actionsCompleted: 12,
      text: "",
      html: "",
      forEach: { items: 3, succeeded: 2, failed: 1, remaining: 0, errors: ['lead-3: select_option "No": timeout'] }
    });
  });

  it("ignores a malformed forEach summary", () => {
    expect(
      parseActionResponse({ actionsCompleted: 1, forEach: { items: "x" } }, "u")
    ).toEqual({ finalUrl: "u", actionsCompleted: 1, text: "", html: "" });
  });

  it("defaults forEach errors to [] when absent or non-array", () => {
    expect(
      parseActionResponse({ actionsCompleted: 4, forEach: { items: 2, succeeded: 2, failed: 0 } }, "u")
    ).toEqual({
      finalUrl: "u",
      actionsCompleted: 4,
      text: "",
      html: "",
      forEach: { items: 2, succeeded: 2, failed: 0, remaining: 0, errors: [] }
    });
    expect(
      parseActionResponse(
        { actionsCompleted: 4, forEach: { items: 2, succeeded: 2, failed: 0, errors: "nope" } },
        "u"
      )
    ).toEqual({
      finalUrl: "u",
      actionsCompleted: 4,
      text: "",
      html: "",
      forEach: { items: 2, succeeded: 2, failed: 0, remaining: 0, errors: [] }
    });
  });

  it("filters non-string entries out of forEach errors", () => {
    expect(
      parseActionResponse(
        {
          actionsCompleted: 4,
          forEach: { items: 2, succeeded: 1, failed: 1, errors: ["real error", 42, null, "second"] }
        },
        "u"
      )
    ).toEqual({
      finalUrl: "u",
      actionsCompleted: 4,
      text: "",
      html: "",
      forEach: { items: 2, succeeded: 1, failed: 1, remaining: 0, errors: ["real error", "second"] }
    });
  });
});

/**
 * The chained-sweep contract: one capped render pass at a time, the worker
 * deferring between passes until the portal's "Needs Action" list is drained.
 *
 * The scenario these pin is Amy Laidlaw's weekly Clever sweep, 2026-08-19: 41
 * active deals stated, 30 rendered in the list, a 6-item cap, and an owner
 * alert claiming "about 35 still need you" derived from arithmetic instead of
 * from what the sweep did (2 updated, 4 card failures). Chaining replaces the
 * arithmetic: passes repeat until nothing is owed, and the flow reads the
 * measured `<id>_updated`/`<id>_left` vars.
 */
describe("parseForEach remaining", () => {
  it("parses the remaining count the capped pass reports", () => {
    expect(
      parseActionResponse(
        {
          actionsCompleted: 12,
          forEach: { items: 30, succeeded: 2, failed: 28, remaining: 24, errors: [] }
        },
        "u"
      )?.forEach
    ).toEqual({ items: 30, succeeded: 2, failed: 28, remaining: 24, errors: [] });
  });

  it("defaults remaining to 0 on an older render service that omits it", () => {
    expect(
      parseActionResponse(
        { actionsCompleted: 4, forEach: { items: 2, succeeded: 2, failed: 0 } },
        "u"
      )?.forEach?.remaining
    ).toBe(0);
  });

  it("clamps remaining to failed, since the service counts the capped tail inside failed", () => {
    expect(
      parseActionResponse(
        {
          actionsCompleted: 4,
          forEach: { items: 5, succeeded: 4, failed: 1, remaining: 9, errors: [] }
        },
        "u"
      )?.forEach?.remaining
    ).toBe(1);
  });

  it("treats a negative or non-numeric remaining as absent", () => {
    for (const bad of [-3, "24", null]) {
      expect(
        parseActionResponse(
          {
            actionsCompleted: 4,
            forEach: { items: 5, succeeded: 4, failed: 1, remaining: bad, errors: [] }
          },
          "u"
        )?.forEach?.remaining
      ).toBe(0);
    }
  });
});

describe("decideForEach", () => {
  const fe = (over: Partial<ForEachSummary>): ForEachSummary => ({
    items: 0,
    succeeded: 0,
    failed: 0,
    remaining: 0,
    errors: [],
    ...over
  });

  it("fails loudly when link collection itself broke", () => {
    expect(decideForEach(fe({ errors: ["bad selector"] }), null, 20)).toEqual({
      kind: "fail_collect",
      error: "bad selector"
    });
  });

  it("collection failure on a continuation pass still reports fail (the wrapper converts it)", () => {
    expect(
      decideForEach(fe({ errors: ["session expired"] }), { passes: 2, updated: 9, lastRemaining: 18 }, 20)
    ).toEqual({ kind: "fail_collect", error: "session expired" });
  });

  it("an empty list is a clean finish, not an error", () => {
    expect(decideForEach(fe({}), null, 20)).toEqual({
      kind: "done",
      passes: 1,
      updated: 0,
      left: 0,
      terminal: "list_drained"
    });
  });

  it("an empty list on a later pass keeps the cumulative total", () => {
    expect(decideForEach(fe({}), { passes: 6, updated: 36, lastRemaining: 5 }, 20)).toEqual({
      kind: "done",
      passes: 7,
      updated: 36,
      left: 0,
      terminal: "list_drained"
    });
  });

  it("a first pass where every attempted item failed stays a loud, run-failing error", () => {
    expect(
      decideForEach(
        fe({ items: 30, failed: 28, remaining: 24, errors: ["Provide Update: no matching control"] }),
        null,
        20
      )
    ).toEqual({
      kind: "fail_first_pass",
      attempted: 6,
      error: "Provide Update: no matching control"
    });
  });

  it("an all-failed first pass with no error detail still fails, with an empty reason", () => {
    expect(decideForEach(fe({ items: 4, failed: 4 }), null, 20)).toEqual({
      kind: "fail_first_pass",
      attempted: 4,
      error: ""
    });
  });

  it("continues when the cap truncated the list and the pass made progress", () => {
    expect(decideForEach(fe({ items: 30, succeeded: 6, failed: 24, remaining: 24 }), null, 20)).toEqual({
      kind: "continue",
      progress: { passes: 1, updated: 6, lastRemaining: 24 }
    });
  });

  it("accumulates the updated total across passes", () => {
    expect(
      decideForEach(
        fe({ items: 24, succeeded: 6, failed: 18, remaining: 18 }),
        { passes: 1, updated: 6, lastRemaining: 24 },
        20
      )
    ).toEqual({
      kind: "continue",
      progress: { passes: 2, updated: 12, lastRemaining: 18 }
    });
  });

  it("finishes when the final slice fits, counting real failures as left", () => {
    expect(
      decideForEach(
        fe({ items: 5, succeeded: 4, failed: 1, errors: ["Submit Update: timeout"] }),
        { passes: 6, updated: 36, lastRemaining: 5 },
        20
      )
    ).toEqual({
      kind: "done",
      passes: 7,
      updated: 40,
      left: 1,
      terminal: "list_drained"
    });
  });

  it("stops when a full continuation pass made no progress (a stuck head would loop forever)", () => {
    expect(
      decideForEach(
        fe({ items: 10, succeeded: 0, failed: 10, remaining: 4 }),
        { passes: 3, updated: 12, lastRemaining: 10 },
        20
      )
    ).toEqual({
      kind: "done",
      passes: 4,
      updated: 12,
      left: 10,
      terminal: "no_progress"
    });
  });

  it("stops at the pass cap even while progressing, and says so", () => {
    expect(
      decideForEach(
        fe({ items: 12, succeeded: 6, failed: 6, remaining: 6 }),
        { passes: 19, updated: 114, lastRemaining: 12 },
        20
      )
    ).toEqual({
      kind: "done",
      passes: 20,
      updated: 120,
      left: 6,
      terminal: "pass_cap"
    });
  });

  it("does not chain against an older render service that never reports remaining", () => {
    // failed includes what the old service capped, but remaining is 0, so the
    // decision is a single-pass finish with the miss counted in left.
    expect(decideForEach(fe({ items: 30, succeeded: 2, failed: 28 }), null, 20)).toEqual({
      kind: "done",
      passes: 1,
      updated: 2,
      left: 28,
      terminal: "list_drained"
    });
  });
});

describe("forEach progress var", () => {
  it("round-trips through the context var encoding", () => {
    const p = { passes: 3, updated: 17, lastRemaining: 9 };
    expect(parseForEachProgress(encodeForEachProgress(p))).toEqual(p);
  });

  it("names the var by step id, __-prefixed like other engine bookkeeping", () => {
    expect(forEachProgressVar("update_each")).toBe("__foreach_update_each");
  });

  it("rejects absent, malformed, or truncated state instead of throwing", () => {
    expect(parseForEachProgress(undefined)).toBeNull();
    expect(parseForEachProgress("")).toBeNull();
    expect(parseForEachProgress("not json")).toBeNull();
    expect(parseForEachProgress("null")).toBeNull();
    expect(parseForEachProgress('"str"')).toBeNull();
    expect(parseForEachProgress('{"passes":1,"updated":2}')).toBeNull();
    expect(parseForEachProgress('{"passes":-1,"updated":2,"lastRemaining":0}')).toBeNull();
    expect(parseForEachProgress('{"passes":"1","updated":2,"lastRemaining":0}')).toBeNull();
    expect(parseForEachProgress(7 as unknown as string)).toBeNull();
  });
});

describe("forEach outcome vars", () => {
  it("derives both names from the step id, the same names the authoring layer registers", () => {
    expect(forEachOutcomeVars("update_each")).toEqual(["update_each_updated", "update_each_left"]);
  });

  it("publishes the measured totals under those names", () => {
    expect(forEachResultVars("update_each", { updated: 39, left: 2 })).toEqual({
      update_each_updated: "39",
      update_each_left: "2"
    });
  });
});
