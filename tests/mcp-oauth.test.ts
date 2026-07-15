import { afterEach, describe, expect, it } from "vitest";

import { supabaseAuthIssuer } from "@/lib/mcp/oauth";

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
});

describe("supabaseAuthIssuer", () => {
  it("appends /auth/v1 to the project URL", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
    expect(supabaseAuthIssuer()).toBe("https://proj.supabase.co/auth/v1");
  });

  it("strips trailing slashes first", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co//";
    expect(supabaseAuthIssuer()).toBe("https://proj.supabase.co/auth/v1");
  });

  it("throws when the env var is missing", () => {
    expect(() => supabaseAuthIssuer()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});
