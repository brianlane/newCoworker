import { describe, expect, it } from "vitest";
import {
  AMD_RESOLUTION_GRACE_MS,
  AMD_RESOLUTION_MAX_AGE_MS,
  AMD_RESOLUTION_SETTINGS_KEY,
  decideAmdResolution,
  parseAmdResolutionConfig,
  readAmdResolutionConfig,
  type AmdResolutionConfig
} from "../supabase/functions/_shared/voice_amd_resolution.ts";

/**
 * The bounded-timeout decision for machine verdicts Telnyx never resolves
 * (greeting events stopped platform-wide on 2026-08-25). The bias under test
 * everywhere: anything uncertain SKIPS. Acting wrongly cuts a live call;
 * skipping costs one model-driven voicemail, which was the status quo.
 */

const ENABLED_FOR_AMY: AmdResolutionConfig = {
  enabled: true,
  allBusinesses: false,
  businessIds: new Set(["amy-biz"])
};

const NOW = Date.parse("2026-08-27T15:36:00.000Z");
const stampedAgo = (ms: number) => new Date(NOW - ms).toISOString();

function machineContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    machine_detected: true,
    machine_stamped_at: stampedAgo(AMD_RESOLUTION_GRACE_MS),
    voicemail: { script: "Call us back at 602-695-1142." },
    ...overrides
  };
}

describe("parseAmdResolutionConfig", () => {
  it("fails OFF for anything missing or malformed", () => {
    // The sweep forces irreversible call actions; a broken row must not
    // enroll anyone.
    for (const raw of [null, undefined, "on", 7, [], {}, { enabled: "true" }, { enabled: false }]) {
      expect(parseAmdResolutionConfig(raw).enabled).toBe(false);
    }
  });

  it("keeps only real business ids and reads the all_businesses switch", () => {
    const config = parseAmdResolutionConfig({
      enabled: true,
      business_ids: ["amy-biz", "", 42, null, "second-biz"],
      all_businesses: false
    });
    expect(config.enabled).toBe(true);
    expect(config.allBusinesses).toBe(false);
    expect([...config.businessIds]).toEqual(["amy-biz", "second-biz"]);
    expect(
      parseAmdResolutionConfig({ enabled: true, all_businesses: true }).allBusinesses
    ).toBe(true);
    // business_ids absent entirely: enabled but nobody enrolled.
    expect(parseAmdResolutionConfig({ enabled: true }).businessIds.size).toBe(0);
  });
});

describe("readAmdResolutionConfig", () => {
  function settingsSupabase(result: { data: unknown; error: { message: string } | null }) {
    return {
      from: (table: string) => {
        expect(table).toBe("admin_platform_settings");
        return {
          select: () => ({
            eq: (col: string, key: unknown) => {
              expect(col).toBe("key");
              expect(key).toBe(AMD_RESOLUTION_SETTINGS_KEY);
              return { maybeSingle: () => Promise.resolve(result) };
            }
          })
        };
      }
    };
  }

  it("reads the stored value", async () => {
    const config = await readAmdResolutionConfig(
      settingsSupabase({ data: { value: { enabled: true, business_ids: ["amy-biz"] } }, error: null })
    );
    expect(config.enabled).toBe(true);
    expect(config.businessIds.has("amy-biz")).toBe(true);
  });

  it("reads a missing row as disabled", async () => {
    const config = await readAmdResolutionConfig(settingsSupabase({ data: null, error: null }));
    expect(config.enabled).toBe(false);
  });

  it("reads a query error as disabled", async () => {
    const config = await readAmdResolutionConfig(
      settingsSupabase({ data: null, error: { message: "boom" } })
    );
    expect(config.enabled).toBe(false);
  });

  it("reads a thrown query as disabled", async () => {
    const config = await readAmdResolutionConfig({
      from: () => {
        throw new Error("no table");
      }
    });
    expect(config.enabled).toBe(false);
  });
});

describe("decideAmdResolution", () => {
  const decide = (
    context: Record<string, unknown>,
    config: AmdResolutionConfig = ENABLED_FOR_AMY,
    businessId = "amy-biz"
  ) => decideAmdResolution({ businessId, context, config, nowMs: NOW });

  it("skips everyone when disabled, and non-enrolled businesses when scoped", () => {
    expect(decide(machineContext(), { ...ENABLED_FOR_AMY, enabled: false })).toEqual({
      action: "skip",
      reason: "business_not_enrolled"
    });
    expect(decide(machineContext(), ENABLED_FOR_AMY, "other-biz")).toEqual({
      action: "skip",
      reason: "business_not_enrolled"
    });
    // all_businesses enrolls a business the id list does not name.
    expect(
      decide(machineContext(), { ...ENABLED_FOR_AMY, allBusinesses: true }, "other-biz").action
    ).toBe("speak");
  });

  it("acts only on a standing machine stamp", () => {
    expect(decide(machineContext({ machine_detected: false }))).toEqual({
      action: "skip",
      reason: "not_machine"
    });
    expect(decide({})).toEqual({ action: "skip", reason: "not_machine" });
  });

  it("never acts while screening says a live person is deciding", () => {
    // Belt and braces: the screening event also clears machine_detected, so
    // this only matters in the race window between the two writes.
    expect(decide(machineContext({ ios_screening: true }))).toEqual({
      action: "skip",
      reason: "screening"
    });
  });

  it("leaves a leg alone once anyone owns its voicemail", () => {
    expect(decide(machineContext({ voicemail_claimed: true }))).toEqual({
      action: "skip",
      reason: "already_resolved"
    });
    expect(
      decide(machineContext({ voicemail_speak_started_at: "2026-08-27T15:35:40.000Z" }))
    ).toEqual({ action: "skip", reason: "already_resolved" });
  });

  it("skips stamps with no usable timestamp (pre-sweep verdicts)", () => {
    expect(decide(machineContext({ machine_stamped_at: undefined }))).toEqual({
      action: "skip",
      reason: "no_stamp_time"
    });
    expect(decide(machineContext({ machine_stamped_at: "yesterday-ish" }))).toEqual({
      action: "skip",
      reason: "no_stamp_time"
    });
  });

  it("waits out the full grace window, then acts, then ages out", () => {
    // One tick inside the grace: every legitimate resolver (greeting beep,
    // screening, the model's claim) still has its turn.
    expect(decide(machineContext({ machine_stamped_at: stampedAgo(AMD_RESOLUTION_GRACE_MS - 1) })))
      .toEqual({ action: "skip", reason: "too_fresh" });
    // Exactly at the grace boundary: overdue, act.
    expect(decide(machineContext()).action).toBe("speak");
    // Exactly at the stale boundary still acts; one tick past is a dead leg.
    expect(
      decide(machineContext({ machine_stamped_at: stampedAgo(AMD_RESOLUTION_MAX_AGE_MS) })).action
    ).toBe("speak");
    expect(
      decide(machineContext({ machine_stamped_at: stampedAgo(AMD_RESOLUTION_MAX_AGE_MS + 1) }))
    ).toEqual({ action: "skip", reason: "too_old" });
  });

  it("speaks the trimmed script when one is configured", () => {
    expect(decide(machineContext({ voicemail: { script: "  read this  " } }))).toEqual({
      action: "speak",
      script: "read this"
    });
  });

  it("hangs up a scriptless machine leg (the pre-voicemail behavior)", () => {
    for (const voicemail of [undefined, {}, { script: "   " }, { script: 7 }]) {
      expect(decide(machineContext({ voicemail }))).toEqual({ action: "hangup" });
    }
  });
});
