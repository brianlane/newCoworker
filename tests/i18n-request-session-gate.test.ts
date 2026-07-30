import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard: anonymous marketing scrapes must not call getAuthUser from the
 * next-intl request config. The 2026-07-30 spike paid for auth on every GET.
 */
describe("i18n request session gate", () => {
  it("only looks up saved locale preference when an sb-* cookie exists", () => {
    const src = readFileSync(join(import.meta.dirname, "../src/i18n/request.ts"), "utf8");
    expect(src).toMatch(/hasSupabaseSessionCookie/);
    expect(src).toMatch(/startsWith\("sb-"\)/);
    expect(src).toMatch(/if \(hasSupabaseSessionCookie\(cookieStore\)\)/);
    // getAuthUser must sit inside the session gate, not at top level of the config.
    const gateIdx = src.indexOf("if (hasSupabaseSessionCookie(cookieStore))");
    const authIdx = src.indexOf("getAuthUser()");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(gateIdx);
  });
});
