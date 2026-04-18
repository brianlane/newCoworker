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

  it("returns false when Authorization is empty", async () => {
    envGet.mockImplementation((key: string) =>
      key === "INTERNAL_CRON_SECRET" ? "sec" : undefined
    );
    expect(await assertCronAuth(req(""))).toBe(false);
  });

  it("returns false when Bearer token is empty after trim", async () => {
    envGet.mockImplementation((key: string) =>
      key === "INTERNAL_CRON_SECRET" ? "sec" : undefined
    );
    expect(await assertCronAuth(req("Bearer "))).toBe(false);
    expect(await assertCronAuth(req("Bearer    "))).toBe(false);
    expect(await assertCronAuth(req("bearer \t "))).toBe(false);
  });

  it("returns false when header has no Bearer prefix and trims to empty", async () => {
    envGet.mockImplementation((key: string) =>
      key === "INTERNAL_CRON_SECRET" ? "sec" : undefined
    );
    expect(await assertCronAuth(req("   "))).toBe(false);
    expect(await assertCronAuth(req("\t\n"))).toBe(false);
  });

  it("returns false when parsed token is empty (mock Request avoids header normalization)", async () => {
    envGet.mockImplementation((key: string) =>
      key === "INTERNAL_CRON_SECRET" ? "sec" : undefined
    );
    const fake = {
      headers: { get: (name: string) => (name.toLowerCase() === "authorization" ? "Bearer \t" : null) }
    } as unknown as Request;
    expect(await assertCronAuth(fake)).toBe(false);
  });

  it("falls back to SUPABASE_SERVICE_ROLE_KEY only when CRON_ALLOW_SERVICE_ROLE_BEARER=true", async () => {
    envGet.mockImplementation((key: string) => {
      if (key === "INTERNAL_CRON_SECRET") return undefined;
      if (key === "CRON_ALLOW_SERVICE_ROLE_BEARER") return "true";
      if (key === "SUPABASE_SERVICE_ROLE_KEY") return "service-key";
      return undefined;
    });
    expect(await assertCronAuth(req("Bearer service-key"))).toBe(true);
  });

  it("rejects service role bearer when INTERNAL_CRON_SECRET is unset and fallback flag is off", async () => {
    envGet.mockImplementation((key: string) => {
      if (key === "INTERNAL_CRON_SECRET") return undefined;
      if (key === "CRON_ALLOW_SERVICE_ROLE_BEARER") return undefined;
      if (key === "SUPABASE_SERVICE_ROLE_KEY") return "service-key";
      return undefined;
    });
    expect(await assertCronAuth(req("Bearer service-key"))).toBe(false);
  });

  it("treats whitespace-only INTERNAL_CRON_SECRET as unset (fallback to service role when allowed)", async () => {
    envGet.mockImplementation((key: string) => {
      if (key === "INTERNAL_CRON_SECRET") return "   \t";
      if (key === "CRON_ALLOW_SERVICE_ROLE_BEARER") return "true";
      if (key === "SUPABASE_SERVICE_ROLE_KEY") return "service-key";
      return undefined;
    });
    expect(await assertCronAuth(req("Bearer service-key"))).toBe(true);
  });

  it("returns false when fallback is allowed but SUPABASE_SERVICE_ROLE_KEY is empty", async () => {
    envGet.mockImplementation((key: string) => {
      if (key === "INTERNAL_CRON_SECRET") return undefined;
      if (key === "CRON_ALLOW_SERVICE_ROLE_BEARER") return "true";
      if (key === "SUPABASE_SERVICE_ROLE_KEY") return "";
      return undefined;
    });
    expect(await assertCronAuth(req("Bearer service-key"))).toBe(false);
  });

  it("treats CRON_ALLOW_SERVICE_ROLE_BEARER=TRUE as enabled", async () => {
    envGet.mockImplementation((key: string) => {
      if (key === "INTERNAL_CRON_SECRET") return undefined;
      if (key === "CRON_ALLOW_SERVICE_ROLE_BEARER") return "TRUE";
      if (key === "SUPABASE_SERVICE_ROLE_KEY") return "svc";
      return undefined;
    });
    expect(await assertCronAuth(req("Bearer svc"))).toBe(true);
  });

  it("trims CRON_ALLOW_SERVICE_ROLE_BEARER value", async () => {
    envGet.mockImplementation((key: string) => {
      if (key === "INTERNAL_CRON_SECRET") return undefined;
      if (key === "CRON_ALLOW_SERVICE_ROLE_BEARER") return "  true ";
      if (key === "SUPABASE_SERVICE_ROLE_KEY") return "svc";
      return undefined;
    });
    expect(await assertCronAuth(req("Bearer svc"))).toBe(true);
  });

  it("returns false when service role is whitespace-only under fallback", async () => {
    envGet.mockImplementation((key: string) => {
      if (key === "INTERNAL_CRON_SECRET") return undefined;
      if (key === "CRON_ALLOW_SERVICE_ROLE_BEARER") return "true";
      if (key === "SUPABASE_SERVICE_ROLE_KEY") return "  \t";
      return undefined;
    });
    expect(await assertCronAuth(req("Bearer x"))).toBe(false);
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

  it("returns false when global Deno is undefined", async () => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "Deno");
    expect(await assertCronAuth(req("Bearer any"))).toBe(false);
    vi.stubGlobal("Deno", { env: { get: envGet } });
  });

  it("returns false when Deno.env is missing", async () => {
    vi.stubGlobal("Deno", {} as { env?: { get: typeof envGet } });
    expect(await assertCronAuth(req("Bearer any"))).toBe(false);
    vi.stubGlobal("Deno", { env: { get: envGet } });
  });

  it("returns false when Deno.env is null", async () => {
    vi.stubGlobal("Deno", { env: null });
    expect(await assertCronAuth(req("Bearer any"))).toBe(false);
    vi.stubGlobal("Deno", { env: { get: envGet } });
  });

  it("treats null SUPABASE_SERVICE_ROLE_KEY as missing under fallback", async () => {
    envGet.mockImplementation((key: string) => {
      if (key === "INTERNAL_CRON_SECRET") return undefined;
      if (key === "CRON_ALLOW_SERVICE_ROLE_BEARER") return "true";
      if (key === "SUPABASE_SERVICE_ROLE_KEY") return null as unknown as string;
      return undefined;
    });
    expect(await assertCronAuth(req("Bearer x"))).toBe(false);
  });
});
