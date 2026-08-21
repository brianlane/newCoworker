import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  assertKeepHoursCoversEngineWindows,
  assertResidencyReplayCronScheduled,
  RESIDENCY_ENGINE_LOOKBACK_WINDOWS,
  RESIDENCY_MIN_KEEP_HOURS,
  ResidencyKeepWindowError,
  ResidencyReplayCronError
} from "@/lib/residency/keep-window";

const ROOT = join(__dirname, "..");
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
    for (const w of RESIDENCY_ENGINE_LOOKBACK_WINDOWS) {
      const src = readFileSync(join(ROOT, w.file), "utf8");
      const m = new RegExp(String.raw`\b${w.constant}\s*=\s*(\d+)`).exec(src);
      expect(m, `${w.constant} is gone from ${w.file}`).not.toBeNull();
      expect(Number(m?.[1]), `${w.constant} in ${w.file} moved but the floor did not`).toBe(
        w.hours
      );
    }
  });

  it("sets the floor to the widest window", () => {
    const widest = Math.max(...RESIDENCY_ENGINE_LOOKBACK_WINDOWS.map((w) => w.hours));
    expect(RESIDENCY_MIN_KEEP_HOURS).toBe(widest);
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
