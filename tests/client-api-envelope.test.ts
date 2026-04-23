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

  it("synthesises INTERNAL_SERVER_ERROR when body is not JSON", async () => {
    const r = new Response("not-json", {
      status: 500,
      headers: { "Content-Type": "text/plain" }
    });
    const parsed = await parseEnvelope(r);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(parsed.error.message).toMatch(/unexpected/i);
  });

  it("synthesises INTERNAL_SERVER_ERROR when body is empty", async () => {
    const r = new Response("", { status: 502 });
    const parsed = await parseEnvelope(r);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});
