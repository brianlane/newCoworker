import { describe, expect, it } from "vitest";
import { readSupabaseEnv } from "@/lib/supabase/env";
import { getSupabaseClient } from "@/lib/supabase/client";

describe("supabase env", () => {
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: "https://mock.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service"
  };

  it("reads environment variables", () => {
    expect(readSupabaseEnv(env)).toEqual({
      url: env.NEXT_PUBLIC_SUPABASE_URL,
      anonKey: "anon",
      serviceRoleKey: "service"
    });
  });

  it("throws for missing values", () => {
    expect(() => readSupabaseEnv({})).toThrow("Missing Supabase environment variables");
  });

  it("creates a supabase client", () => {
    const client = getSupabaseClient(env);
    expect(client).toBeTruthy();
  });
});
