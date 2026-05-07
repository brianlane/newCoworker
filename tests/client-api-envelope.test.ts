import { describe, it, expect } from "vitest";
import { parseEnvelope } from "../src/lib/client/api-envelope";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("parseEnvelope", () => {
  it("returns success envelope for valid JSON success payload", async () => {
    const r = jsonResponse({ ok: true, data: { foo: 1 } });
    const parsed = await parseEnvelope<{ foo: number }>(r);
    expect(parsed).toEqual({ ok: true, data: { foo: 1 } });
  });

  it("returns error envelope for valid JSON error payload", async () => {
    const r = jsonResponse({
      ok: false,
      error: { code: "UNAUTHORIZED", message: "Nope" }
    });
    const parsed = await parseEnvelope(r);
    expect(parsed).toEqual({
      ok: false,
      error: { code: "UNAUTHORIZED", message: "Nope" }
    });
  });

  it("synthesises a 'taking longer than usual' INTERNAL_SERVER_ERROR for 5xx with non-JSON body", async () => {
    // The 502 case is the live trigger: Vercel returns an HTML error
    // page when the function exceeds maxDuration or upstream returns a
    // gateway error. Pre-fix the synthesised copy was the literal
    // "Unexpected server response", which left owners staring at a
    // dead-end string with no idea whether to retry. The new copy
    // makes the right action (retry in a moment) obvious.
    const r = new Response("<html>504 Gateway Timeout</html>", {
      status: 502,
      headers: { "Content-Type": "text/html" }
    });
    const parsed = await parseEnvelope(r);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(parsed.error.message).toMatch(/longer than usual/i);
    expect(parsed.error.message).not.toMatch(/unexpected/i);
  });

  it("synthesises 'taking longer than usual' for 500 with non-JSON body — same friendly copy across the 5xx range", async () => {
    const r = new Response("not-json", {
      status: 500,
      headers: { "Content-Type": "text/plain" }
    });
    const parsed = await parseEnvelope(r);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toMatch(/longer than usual/i);
  });

  it("synthesises INTERNAL_SERVER_ERROR with the 'taking longer' copy when body is empty (still a 5xx)", async () => {
    const r = new Response("", { status: 502 });
    const parsed = await parseEnvelope(r);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(parsed.error.message).toMatch(/longer than usual/i);
  });

  it("keeps the canonical 'Unexpected server response' copy for 4xx + non-JSON — different failure mode than a slow 5xx", async () => {
    // 4xx + non-JSON typically means a misconfigured proxy stripped a
    // valid JSON body, OR an upstream load balancer returned its own
    // HTML error page. Saying "your coworker is taking longer" there
    // would be misleading — the request is being rejected, not slow.
    const r = new Response("<html>403 Forbidden</html>", {
      status: 403,
      headers: { "Content-Type": "text/html" }
    });
    const parsed = await parseEnvelope(r);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(parsed.error.message).toMatch(/unexpected/i);
    expect(parsed.error.message).not.toMatch(/longer than usual/i);
  });
});
