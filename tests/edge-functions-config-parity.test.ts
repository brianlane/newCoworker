/**
 * Every deployable edge function must have a `[functions.<name>]` entry in
 * supabase/config.toml with `verify_jwt = false`.
 *
 * Why this exists: the CI deploy path is a bare `supabase functions deploy`
 * (.github/scripts/supabase-deploy.sh), which takes `verify_jwt` from
 * config.toml and falls back to the CLI default (ON, in current versions)
 * when a function has no entry. Every function in this project authenticates
 * its own callers (cron bearer, Telnyx signature, webhook token), so a
 * gateway-level JWT check silently 401s real traffic before our code runs.
 * That exact failure shipped three times: voice-bridge-health-alerts (see the
 * config.toml header), then outreach-sweep (#972, every pg_cron tick 401'd
 * from 2026-07-28 to 2026-08-01 and Prospecting never discovered a single
 * prospect), then vps-orphan-sweep (#1049). This test turns the omission
 * into a red CI check instead of a silent production outage.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FUNCTIONS_DIR = join(process.cwd(), "supabase", "functions");
const CONFIG_PATH = join(process.cwd(), "supabase", "config.toml");

function deployableFunctions(): string[] {
  return readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    // Underscore-prefixed directories are shared modules, not functions
    // (same rule scripts/deploy-edge-functions.sh --all applies).
    .filter((name) => !name.startsWith("_"))
    .sort();
}

describe("supabase/config.toml covers every edge function", () => {
  const config = readFileSync(CONFIG_PATH, "utf8");

  it.each(deployableFunctions())("pins verify_jwt = false for %s", (name) => {
    const section = new RegExp(
      `^\\[functions\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*\\nverify_jwt = false$`,
      "m"
    );
    expect(config).toMatch(section);
  });

  it("finds a non-trivial set of functions (the directory scan is not broken)", () => {
    expect(deployableFunctions().length).toBeGreaterThan(30);
  });
});
