import { describe, expect, it } from "vitest";
import { assertPublicSupabaseUrlIsNotAppOrigin } from "@/lib/supabase/validate-public-url";

describe("assertPublicSupabaseUrlIsNotAppOrigin", () => {
  it("does nothing when either URL is missing", () => {
    expect(() => assertPublicSupabaseUrlIsNotAppOrigin(undefined, "https://app.test")).not.toThrow();
    expect(() => assertPublicSupabaseUrlIsNotAppOrigin("https://x.supabase.co", undefined)).not.toThrow();
  });

  it("allows distinct hosts including www normalization", () => {
    expect(() =>
      assertPublicSupabaseUrlIsNotAppOrigin(
        "https://abc.supabase.co",
        "https://www.example.com",
      ),
    ).not.toThrow();
    expect(() =>
      assertPublicSupabaseUrlIsNotAppOrigin(
        "https://abc.supabase.co",
        "https://example.com",
      ),
    ).not.toThrow();
  });

  it("throws when app and Supabase URLs share the same hostname", () => {
    expect(() =>
      assertPublicSupabaseUrlIsNotAppOrigin(
        "https://www.example.com",
        "https://example.com",
      ),
    ).toThrow(/same hostname/);
  });
});
