import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { readSupabaseEnv } from "@/lib/supabase/env";
import { getSupabaseClient } from "@/lib/supabase/client";

describe("supabase env", () => {
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: "https://mock.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service"
  };

  it("reads environment variables", () => {
    expect(readSupabaseEnv(env as unknown as NodeJS.ProcessEnv)).toEqual({
      url: env.NEXT_PUBLIC_SUPABASE_URL,
      anonKey: "anon",
      serviceRoleKey: "service"
    });
  });

  it("throws for missing values", () => {
    expect(() => readSupabaseEnv({} as unknown as NodeJS.ProcessEnv)).toThrow("Missing Supabase environment variables");
  });

  describe("getSupabaseClient", () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
      process.env = {
        ...OLD_ENV,
        NEXT_PUBLIC_SUPABASE_URL: "https://mock.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon_key"
      };
    });

    afterEach(() => {
      process.env = OLD_ENV;
    });

    it("creates a supabase client without service role key", () => {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      const client = getSupabaseClient();
      expect(client).toBeTruthy();
    });

    it("throws when public env vars are missing", () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      expect(() => getSupabaseClient()).toThrow("Missing Supabase public environment variables");
    });
  });
});
