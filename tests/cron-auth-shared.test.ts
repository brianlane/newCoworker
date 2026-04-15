import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  assertCronAuth,
  sha256Utf8,
  timingSafeEqualBytes
} from "../supabase/functions/_shared/cron_auth";

describe("timingSafeEqualBytes", () => {
  it("returns false when lengths differ", () => {
    expect(timingSafeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1]))).toBe(false);
  });

  it("returns true when all bytes match", () => {
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it("returns false when a byte differs", () => {
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it("returns true for empty arrays", () => {
    expect(timingSafeEqualBytes(new Uint8Array([]), new Uint8Array([]))).toBe(true);
  });
});

describe("sha256Utf8", () => {
  it("matches known empty-string digest", async () => {
    const d = await sha256Utf8("");
    expect(Buffer.from(d).toString("hex")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("produces deterministic output for non-empty input", async () => {
    const a = await sha256Utf8("cron-secret");
    const b = await sha256Utf8("cron-secret");
    expect(timingSafeEqualBytes(a, b)).toBe(true);
    expect(a.length).toBe(32);
  });
});

describe("assertCronAuth", () => {
  const envGet = vi.fn<(key: string) => string | undefined>();

  beforeEach(() => {
    envGet.mockReset();
    vi.stubGlobal("Deno", { env: { get: envGet } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function req(authHeader: string | null): Request {
    if (authHeader == null) return new Request("http://localhost/");
    return new Request("http://localhost/", { headers: { Authorization: authHeader } });
  }

  it("returns false when no secret is configured", async () => {
    envGet.mockReturnValue(undefined);
    expect(await assertCronAuth(req("Bearer x"))).toBe(false);
  });

  it("returns false when INTERNAL_CRON_SECRET is empty and fallback is unset", async () => {
    envGet.mockImplementation((key: string) => {
      if (key === "INTERNAL_CRON_SECRET") return "";
      return undefined;
    });
    expect(await assertCronAuth(req("Bearer x"))).toBe(false);
  });

  it("accepts Bearer token matching INTERNAL_CRON_SECRET", async () => {
    envGet.mockImplementation((key: string) =>
      key === "INTERNAL_CRON_SECRET" ? "my-cron-secret" : undefined
    );
    expect(await assertCronAuth(req("Bearer my-cron-secret"))).toBe(true);
  });

  it("is case-insensitive on Bearer prefix", async () => {
    envGet.mockImplementation((key: string) =>
      key === "INTERNAL_CRON_SECRET" ? "tok" : undefined
    );
    expect(await assertCronAuth(req("bearer tok"))).toBe(true);
  });

  it("trims the token", async () => {
    envGet.mockImplementation((key: string) =>
      key === "INTERNAL_CRON_SECRET" ? "tok" : undefined
    );
    expect(await assertCronAuth(req("Bearer tok  "))).toBe(true);
  });

  it("returns false for wrong token", async () => {
    envGet.mockImplementation((key: string) =>
      key === "INTERNAL_CRON_SECRET" ? "correct" : undefined
    );
    expect(await assertCronAuth(req("Bearer wrong"))).toBe(false);
  });

  it("returns false when Authorization is missing", async () => {
    envGet.mockImplementation((key: string) =>
      key === "INTERNAL_CRON_SECRET" ? "sec" : undefined
    );
    expect(await assertCronAuth(req(null))).toBe(false);
  });

  it("falls back to SUPABASE_SERVICE_ROLE_KEY when INTERNAL_CRON_SECRET is unset", async () => {
    envGet.mockImplementation((key: string) => {
      if (key === "INTERNAL_CRON_SECRET") return undefined;
      if (key === "SUPABASE_SERVICE_ROLE_KEY") return "service-key";
      return undefined;
    });
    expect(await assertCronAuth(req("Bearer service-key"))).toBe(true);
  });

  it("prefers INTERNAL_CRON_SECRET over SUPABASE_SERVICE_ROLE_KEY", async () => {
    envGet.mockImplementation((key: string) => {
      if (key === "INTERNAL_CRON_SECRET") return "primary";
      if (key === "SUPABASE_SERVICE_ROLE_KEY") return "fallback";
      return undefined;
    });
    expect(await assertCronAuth(req("Bearer primary"))).toBe(true);
    expect(await assertCronAuth(req("Bearer fallback"))).toBe(false);
  });
});
