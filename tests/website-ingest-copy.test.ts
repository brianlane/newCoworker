import { describe, expect, it } from "vitest";
import {
  WEBSITE_INGEST_ERROR_COPY,
  websiteIngestErrorMessage
} from "../src/lib/website-ingest-copy";

describe("websiteIngestErrorMessage", () => {
  it("prefers server-provided detail when present", () => {
    expect(
      websiteIngestErrorMessage("fetch_failed", "Gemini said: rate limited")
    ).toBe("Gemini said: rate limited");
  });

  it("trims surrounding whitespace on detail", () => {
    expect(websiteIngestErrorMessage("fetch_failed", "   hi   ")).toBe("hi");
  });

  it("falls back to canned copy when detail is null", () => {
    expect(websiteIngestErrorMessage("fetch_failed", null)).toBe(
      WEBSITE_INGEST_ERROR_COPY.fetch_failed
    );
  });

  it("falls back to canned copy when detail is undefined", () => {
    expect(websiteIngestErrorMessage("blocked_by_robots", undefined)).toBe(
      WEBSITE_INGEST_ERROR_COPY.blocked_by_robots
    );
  });

  it("falls back to canned copy when detail is empty or whitespace", () => {
    expect(websiteIngestErrorMessage("empty_content", "")).toBe(
      WEBSITE_INGEST_ERROR_COPY.empty_content
    );
    expect(websiteIngestErrorMessage("empty_content", "   ")).toBe(
      WEBSITE_INGEST_ERROR_COPY.empty_content
    );
  });

  it("maps each known WebsiteIngestError code to copy (never a bare enum)", () => {
    const codes: Array<keyof typeof WEBSITE_INGEST_ERROR_COPY> = [
      "invalid_url",
      "private_address",
      "dns_failure",
      "blocked_by_robots",
      "fetch_failed",
      "empty_content",
      "summarizer_unavailable",
      "summarizer_failed"
    ];
    for (const code of codes) {
      const msg = websiteIngestErrorMessage(code, null);
      expect(msg).toBe(WEBSITE_INGEST_ERROR_COPY[code]);
      expect(msg).not.toBe(code);
      expect(msg.length).toBeGreaterThan(10);
    }
  });

  it("returns a generic message for unknown error codes", () => {
    expect(websiteIngestErrorMessage("something_new", null)).toBe(
      "Re-crawl could not find public pages."
    );
  });

  it("returns a generic message when both error and detail are missing", () => {
    expect(websiteIngestErrorMessage(undefined, undefined)).toBe(
      "Re-crawl could not find public pages."
    );
    expect(websiteIngestErrorMessage(null, null)).toBe(
      "Re-crawl could not find public pages."
    );
  });
});
