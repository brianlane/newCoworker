/**
 * POST /api/security/csp-report, the hard-capped sink for
 * Content-Security-Policy-Report-Only violations.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { POST } from "@/app/api/security/csp-report/route";
import { logger } from "@/lib/logger";

function reportRequest(body: string, ip = "203.0.113.1"): Request {
  return new Request("https://www.newcoworker.com/api/security/csp-report", {
    method: "POST",
    headers: {
      "content-type": "application/csp-report",
      "x-forwarded-for": ip,
      "user-agent": "Mozilla/5.0 (test)"
    },
    body
  });
}

const VIOLATION = JSON.stringify({
  "csp-report": {
    "document-uri": "https://www.newcoworker.com/",
    "violated-directive": "script-src",
    "blocked-uri": "inline"
  }
});

describe("POST /api/security/csp-report", () => {
  let ipCounter = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    // The limiter keeps module-level state across tests, so give each test its
    // own IP rather than reaching into that state.
    ipCounter++;
  });

  const ip = () => `198.51.100.${ipCounter}`;

  it("answers 204 and logs the violation", async () => {
    const res = await POST(reportRequest(VIOLATION, ip()));

    expect(res.status).toBe(204);
    expect(logger.warn).toHaveBeenCalledOnce();
    const context = vi.mocked(logger.warn).mock.calls[0][1] as Record<string, unknown>;
    expect(String(context.report)).toContain("script-src");
    expect(context.userAgent).toBe("Mozilla/5.0 (test)");
  });

  it("unwraps the csp-report envelope but also takes a bare report", async () => {
    await POST(reportRequest(JSON.stringify({ "violated-directive": "style-src" }), ip()));

    const context = vi.mocked(logger.warn).mock.calls[0][1] as Record<string, unknown>;
    expect(String(context.report)).toContain("style-src");
  });

  it("swallows a malformed body rather than erroring", async () => {
    const res = await POST(reportRequest("not json at all", ip()));

    expect(res.status).toBe(204);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("ignores an empty body", async () => {
    const res = await POST(reportRequest("", ip()));

    expect(res.status).toBe(204);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("truncates an oversized report instead of logging it whole", async () => {
    const huge = JSON.stringify({
      "csp-report": { "document-uri": "x".repeat(5_000) }
    });

    await POST(reportRequest(huge, ip()));

    const context = vi.mocked(logger.warn).mock.calls[0][1] as Record<string, unknown>;
    expect(String(context.report).length).toBeLessThanOrEqual(2_000);
  });

  it("drops reports past the per-IP budget, still answering 204", async () => {
    const addr = ip();
    for (let i = 0; i < 10; i++) await POST(reportRequest(VIOLATION, addr));
    expect(logger.warn).toHaveBeenCalledTimes(10);

    const res = await POST(reportRequest(VIOLATION, addr));

    expect(res.status).toBe(204);
    // Still 10: the eleventh was dropped before any work was done.
    expect(logger.warn).toHaveBeenCalledTimes(10);
  });

  it("copes with a request that carries no user-agent", async () => {
    const res = await POST(
      new Request("https://www.newcoworker.com/api/security/csp-report", {
        method: "POST",
        headers: { "x-forwarded-for": ip() },
        body: VIOLATION
      })
    );

    expect(res.status).toBe(204);
    const context = vi.mocked(logger.warn).mock.calls[0][1] as Record<string, unknown>;
    expect(context.userAgent).toBeNull();
  });
});
