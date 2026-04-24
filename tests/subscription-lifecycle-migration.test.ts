import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("subscription lifecycle migration", () => {
  it("does not merge distinct customer profiles by IP alone", () => {
    const sql = readFileSync(
      "supabase/migrations/20260501000000_subscription_lifecycle.sql",
      "utf8"
    );

    expect(sql).toMatch(/where last_signup_ip = p_last_signup_ip\s+and normalized_email is null/i);
  });
});
