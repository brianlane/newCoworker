import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clearStaleSupabaseAuthCookies,
  getSupabaseBrowserClient,
  resetSupabaseBrowserClientCache
} from "@/lib/supabase/browser";

describe("getSupabaseBrowserClient", () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  beforeEach(() => {
    resetSupabaseBrowserClientCache();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
  });

  it("returns a Supabase client with correct configuration", () => {
    const client = getSupabaseBrowserClient();
    expect(client).toBeDefined();
    expect(client.auth).toBeDefined();
  });

  it("returns the same instance on subsequent calls (caching)", () => {
    const client1 = getSupabaseBrowserClient();
    const client2 = getSupabaseBrowserClient();
    expect(client1).toBe(client2);
  });

  it("throws when URL is empty string", () => {
    resetSupabaseBrowserClientCache();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-key";
    expect(() => getSupabaseBrowserClient()).toThrow(
      "Missing Supabase URL environment variable"
    );
  });

  it("throws when anon key is empty string", () => {
    resetSupabaseBrowserClientCache();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "";
    expect(() => getSupabaseBrowserClient()).toThrow(
      "Missing Supabase anon key environment variable"
    );
  });

  it("throws when both are empty strings", () => {
    resetSupabaseBrowserClientCache();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "";
    expect(() => getSupabaseBrowserClient()).toThrow(
      "Missing Supabase URL environment variable"
    );
  });
});

/**
 * Test harness that simulates `document.cookie` semantics enough for the
 * scrubber: each assignment with `Max-Age=0` (or a 1970 expires) removes the
 * matching cookie name from the store; reads return the current store.
 */
function installFakeDocument(initialCookies: string[]): {
  getCookies: () => string[];
  uninstall: () => void;
} {
  const store = new Map<string, string>();
  for (const raw of initialCookies) {
    const eq = raw.indexOf("=");
    const name = eq >= 0 ? raw.slice(0, eq) : raw;
    const value = eq >= 0 ? raw.slice(eq + 1) : "";
    store.set(name, value);
  }

  const fakeDocument = {
    get cookie() {
      return Array.from(store.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    },
    set cookie(input: string) {
      const firstSemi = input.indexOf(";");
      const head = firstSemi >= 0 ? input.slice(0, firstSemi) : input;
      const eq = head.indexOf("=");
      if (eq < 0) return;
      const name = head.slice(0, eq).trim();
      const value = head.slice(eq + 1);
      const isExpiry =
        /max-age\s*=\s*0\b/i.test(input) ||
        /expires\s*=.*1970/i.test(input);
      if (isExpiry) {
        store.delete(name);
      } else {
        store.set(name, value);
      }
    }
  };

  const original = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = fakeDocument;

  return {
    getCookies: () =>
      Array.from(store.entries()).map(([k, v]) => (v ? `${k}=${v}` : k)),
    uninstall: () => {
      if (original === undefined) {
        delete (globalThis as { document?: unknown }).document;
      } else {
        (globalThis as { document?: unknown }).document = original;
      }
    }
  };
}

describe("clearStaleSupabaseAuthCookies", () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  beforeEach(() => {
    resetSupabaseBrowserClientCache();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it("no-ops when document is undefined (server context)", async () => {
    const original = (globalThis as { document?: unknown }).document;
    delete (globalThis as { document?: unknown }).document;
    try {
      await expect(clearStaleSupabaseAuthCookies()).resolves.toBeUndefined();
    } finally {
      if (original !== undefined) {
        (globalThis as { document?: unknown }).document = original;
      }
    }
  });

  it("removes all sb-* cookies and leaves unrelated cookies alone", async () => {
    const harness = installFakeDocument([
      "sb-abc-auth-token.0=chunk0",
      "sb-abc-auth-token.1=chunk1",
      "sb-abc-auth-token-code-verifier=verifier-abc",
      "sb-xyz-auth-token=stale-from-prior-project",
      "_vercel_jwt=should-stay",
      "ph_id=analytics"
    ]);

    try {
      await clearStaleSupabaseAuthCookies();
      const remaining = harness.getCookies().map((c) => c.split("=")[0]);
      expect(remaining).not.toContain("sb-abc-auth-token.0");
      expect(remaining).not.toContain("sb-abc-auth-token.1");
      expect(remaining).not.toContain("sb-abc-auth-token-code-verifier");
      expect(remaining).not.toContain("sb-xyz-auth-token");
      expect(remaining).toContain("_vercel_jwt");
      expect(remaining).toContain("ph_id");
    } finally {
      harness.uninstall();
    }
  });

  it("falls back to the manual scrub when the SDK signOut throws", async () => {
    // Force the SDK lookup to fail so we exercise the catch branch. Empty
    // env vars cause `getSupabaseBrowserClient` to throw synchronously.
    resetSupabaseBrowserClientCache();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "";

    const harness = installFakeDocument([
      "sb-abc-auth-token.0=chunk0",
      "other=ok"
    ]);

    try {
      await expect(clearStaleSupabaseAuthCookies()).resolves.toBeUndefined();
      const remaining = harness.getCookies().map((c) => c.split("=")[0]);
      expect(remaining).not.toContain("sb-abc-auth-token.0");
      expect(remaining).toContain("other");
    } finally {
      harness.uninstall();
    }
  });

  it("ignores empty entries in the cookie string", async () => {
    // Trailing or duplicate separators can produce empty entries when split,
    // and a bare cookie name with no `=` is also legal — both must not throw.
    const harness = installFakeDocument([]);
    const fakeDoc = (globalThis as { document?: { cookie: string } }).document!;
    // Seed an unparseable cookie string: leading separator + bare name.
    Object.defineProperty(fakeDoc, "cookie", {
      configurable: true,
      get: () => "; sb-bare; sb-abc-auth-token.0=chunk",
      set: () => {
        // Discard writes — this test only exercises the reader / split logic.
      }
    });

    try {
      await expect(clearStaleSupabaseAuthCookies()).resolves.toBeUndefined();
    } finally {
      harness.uninstall();
    }
  });
});
