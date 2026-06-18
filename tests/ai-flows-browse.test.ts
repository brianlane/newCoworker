import { describe, expect, it } from "vitest";
import {
  isUnsafeBrowseHost,
  normalizeBrowseUrl,
  parseActionResponse,
  parseRenderResponse,
  renderErrorFields,
  renderErrorKind
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
      forEach: { items: 3, succeeded: 2, failed: 1, errors: ['lead-3: select_option "No": timeout'] }
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
      forEach: { items: 2, succeeded: 2, failed: 0, errors: [] }
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
      forEach: { items: 2, succeeded: 2, failed: 0, errors: [] }
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
      forEach: { items: 2, succeeded: 1, failed: 1, errors: ["real error", "second"] }
    });
  });
});
