import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  assertKeepHoursCoversEngineWindows,
  assertResidencyReplayCronScheduled,
  RESIDENCY_ENGINE_LOOKBACK_WINDOWS,
  RESIDENCY_MIN_KEEP_HOURS,
  RESIDENCY_WINDOWS_ACCEPTING_TRUNCATION,
  ResidencyKeepWindowError,
  ResidencyReplayCronError
} from "@/lib/residency/keep-window";

const ROOT = join(__dirname, "..");

/** The 8 tables residency_purge_business() deletes from. */
const PURGED_TABLE_RE =
  /\.from\(["'`](email_log|sms_outbound_log|voice_call_transcripts|voice_call_transcript_turns|voice_outbound_dial_log|notifications|scheduled_sms|sms_owner_reply_prompts)["'`]\)/;
const MIGRATION = join(
  ROOT,
  "supabase",
  "migrations",
  "20260822233041_residency_purge_keep_floor_and_replay_cron_check.sql"
);

describe("residency keep-window floor", () => {
  it("pins every declared window to the constant the engine actually uses", () => {
    // Lockstep. Widening a window in the Deno source without moving the floor
    // would silently reopen the gap this floor exists to close.
    for (const w of [
      ...RESIDENCY_ENGINE_LOOKBACK_WINDOWS,
      ...RESIDENCY_WINDOWS_ACCEPTING_TRUNCATION
    ]) {
      const src = readFileSync(join(ROOT, w.file), "utf8");
      const m = new RegExp(String.raw`\b${w.constant}\s*=\s*(\d+)`).exec(src);
      expect(m, `${w.constant} is gone from ${w.file}`).not.toBeNull();
      expect(Number(m?.[1]), `${w.constant} in ${w.file} moved but the floor did not`).toBe(
        w.literal
      );
    }
  });

  it("sets the floor to the widest window it covers", () => {
    const widest = Math.max(...RESIDENCY_ENGINE_LOOKBACK_WINDOWS.map((w) => w.hours));
    expect(RESIDENCY_MIN_KEEP_HOURS).toBe(widest);
  });

  it("keeps the covered and truncation-accepting lists honest about each other", () => {
    // Anything at or under the floor belongs in the COVERED list: parking it
    // under "accepts truncation" would excuse a window that is not actually
    // losing anything, and hide it from the floor calculation if it later grew.
    for (const w of RESIDENCY_WINDOWS_ACCEPTING_TRUNCATION) {
      expect(
        w.hours,
        `${w.constant} fits under the floor, so it is covered, not truncated`
      ).toBeGreaterThan(RESIDENCY_MIN_KEEP_HOURS);
      expect(w.why.trim().length, `${w.constant}: needs a reason, not a shrug`).toBeGreaterThan(40);
    }
    for (const w of RESIDENCY_ENGINE_LOOKBACK_WINDOWS) {
      expect(
        w.hours,
        `${w.constant} is wider than the floor, so it cannot claim to be covered`
      ).toBeLessThanOrEqual(RESIDENCY_MIN_KEEP_HOURS);
    }
  });

  it("finds no fixed engine window over a purged table that is unaccounted for", () => {
    // The inventory claims completeness, so prove it rather than asserting
    // it. Bugbot caught two missing entries on the first pass; this is the
    // check that would have caught them first.
    const declared = new Set<string>(
      [...RESIDENCY_ENGINE_LOOKBACK_WINDOWS, ...RESIDENCY_WINDOWS_ACCEPTING_TRUNCATION].map(
        (w) => w.constant as string
      )
    );
    const EDGE_SHARED = join(ROOT, "supabase", "functions", "_shared");
    const files = readdirSync(EDGE_SHARED, { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => join(e.parentPath, e.name));
    const unaccounted: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // Only modules that actually read a purged table can truncate.
      if (!PURGED_TABLE_RE.test(src)) continue;
      for (const m of src.matchAll(/^export const ([A-Z_]*(?:HOURS|DAYS))\s*=\s*(\d+)/gm)) {
        if (!declared.has(m[1])) unaccounted.push(`${m[1]} (${file.replace(ROOT + "/", "")})`);
      }
    }
    expect(
      unaccounted.sort(),
      "a fixed lookback window in a module that reads a purged table, missing from both lists. " +
        "Add it to RESIDENCY_ENGINE_LOOKBACK_WINDOWS if the floor covers it, or to " +
        "RESIDENCY_WINDOWS_ACCEPTING_TRUNCATION with the reason it may lose rows."
    ).toEqual([]);
  });

  it("keeps the SQL floor in lockstep with the TypeScript one", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const m = /if p_keep_hours < (\d+) then/.exec(sql);
    expect(m, "the RPC no longer enforces a floor").not.toBeNull();
    expect(
      Number(m?.[1]),
      "the RPC floor and RESIDENCY_MIN_KEEP_HOURS disagree; the RPC is callable without the wrapper"
    ).toBe(RESIDENCY_MIN_KEEP_HOURS);
  });

  it("refuses a purge that would cut inside an engine window", () => {
    for (const bad of [0, 1, 24, 71]) {
      expect(() => assertKeepHoursCoversEngineWindows(bad)).toThrow(ResidencyKeepWindowError);
    }
    // The message must name what breaks, not just that it refused.
    expect(() => assertKeepHoursCoversEngineWindows(24)).toThrow(
      /CONTACT_TIMELINE_LOOKBACK_HOURS=72h/
    );
  });

  it("refuses a non-integer keep-hours rather than coercing it", () => {
    expect(() => assertKeepHoursCoversEngineWindows(Number.NaN)).toThrow(ResidencyKeepWindowError);
    expect(() => assertKeepHoursCoversEngineWindows(72.5)).toThrow(ResidencyKeepWindowError);
  });

  it("allows the default and anything wider", () => {
    for (const ok of [72, 73, 720]) {
      expect(() => assertKeepHoursCoversEngineWindows(ok)).not.toThrow();
    }
  });
});

describe("residency replay-cron precondition", () => {
  const clientReturning = (data: unknown, error: { message: string } | null = null) => ({
    rpc: vi.fn(async () => ({ data, error }))
  });

  it("lets a flip through when the cron is active", async () => {
    const db = clientReturning(true);
    await expect(assertResidencyReplayCronScheduled(db, "dual")).resolves.toBeUndefined();
    expect(db.rpc).toHaveBeenCalledWith("residency_replay_cron_active");
  });

  it("blocks dual and vps when the cron is not active", async () => {
    for (const mode of ["dual", "vps"]) {
      await expect(assertResidencyReplayCronScheduled(clientReturning(false), mode)).rejects.toThrow(
        ResidencyReplayCronError
      );
    }
  });

  it("fails CLOSED when the check itself errors", async () => {
    // Wrongly allowing builds a journal that never drains and is found late,
    // by hand. Wrongly blocking stops a rare maintenance action with a
    // message naming the fix.
    const db = clientReturning(null, { message: "permission denied for schema cron" });
    await expect(assertResidencyReplayCronScheduled(db, "dual")).rejects.toThrow(
      /permission denied for schema cron/
    );
  });

  it("never blocks turning residency OFF", async () => {
    // Same posture as the tier gate: a tenant must never be wedged forward.
    const db = clientReturning(false);
    await expect(assertResidencyReplayCronScheduled(db, "supabase")).resolves.toBeUndefined();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("points at the runbook step that fixes it", async () => {
    await expect(assertResidencyReplayCronScheduled(clientReturning(false), "dual")).rejects.toThrow(
      /edge-residency-replay/
    );
  });
});
