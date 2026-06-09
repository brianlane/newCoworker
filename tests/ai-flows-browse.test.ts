import { describe, expect, it } from "vitest";
import {
  isUnsafeBrowseHost,
  normalizeBrowseUrl,
  parseRenderResponse
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
