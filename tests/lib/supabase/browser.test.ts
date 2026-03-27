import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

describe("getSupabaseBrowserClient", () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  beforeEach(() => {
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

  it("uses the provided environment variables", () => {
    const client = getSupabaseBrowserClient();
    expect(client).toBeDefined();
  });

  it("throws when URL is empty string", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "";
    expect(() => getSupabaseBrowserClient()).toThrow(
      "Missing Supabase URL environment variable"
    );
  });

  it("throws when anon key is empty string", () => {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "";
    expect(() => getSupabaseBrowserClient()).toThrow(
      "Missing Supabase anon key environment variable"
    );
  });

  it("throws when both are empty strings", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "";
    expect(() => getSupabaseBrowserClient()).toThrow(
      "Missing Supabase URL environment variable"
    );
  });
});
