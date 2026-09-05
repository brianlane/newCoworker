import { afterEach, describe, expect, it } from "vitest";
import { resendApiBase } from "../supabase/functions/_shared/resend_api_base";

/**
 * The Resend base-URL seam the worker-integration suite uses to route flow
 * emails at its fake app. Same contract as telnyxApiBase: real host unless
 * overridden, trailing slash trimmed, readable under Deno and Node.
 */
describe("resendApiBase (test-seam env override)", () => {
  afterEach(() => {
    delete process.env.RESEND_API_BASE;
    delete (globalThis as { Deno?: unknown }).Deno;
  });

  it("defaults to the real host and trims a trailing slash from an override", () => {
    expect(resendApiBase()).toBe("https://api.resend.com");
    process.env.RESEND_API_BASE = "http://127.0.0.1:8978/";
    expect(resendApiBase()).toBe("http://127.0.0.1:8978");
  });

  it("reads the override via the Deno global when present (edge runtime)", () => {
    (globalThis as { Deno?: unknown }).Deno = {
      env: { get: (name: string) => (name === "RESEND_API_BASE" ? "http://fake:1" : undefined) }
    };
    expect(resendApiBase()).toBe("http://fake:1");
    (globalThis as { Deno?: unknown }).Deno = { env: { get: () => undefined } };
    expect(resendApiBase()).toBe("https://api.resend.com");
  });
});
