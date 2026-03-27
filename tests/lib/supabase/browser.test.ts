import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSupabaseBrowserClient, resetSupabaseBrowserClientCache } from "@/lib/supabase/browser";

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
