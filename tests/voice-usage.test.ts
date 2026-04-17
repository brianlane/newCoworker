import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getVoiceBillingSnapshotForBusiness } from "@/lib/db/voice-usage";

function makeBusinessesResult(data: unknown, error: unknown = null) {
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data, error })
      })
    })
  };
}

function makeSubResult(data: unknown, error: unknown = null) {
  return {
    select: () => ({
      eq: () => ({
        order: () => ({
          limit: () => ({
            maybeSingle: async () => ({ data, error })
          })
        })
      })
    })
  };
}

function makeUsageResult(data: unknown | null) {
  return {
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data, error: null })
        })
      })
    })
  };
}

function makeResvResult(rows: unknown[]) {
  return {
    select: () => ({
      eq: () => ({
        eq: () => ({
          in: async () => ({ data: rows, error: null })
        })
      })
    })
  };
}

function makeBonusResult(rows: unknown[]) {
  return {
    select: () => ({
      eq: () => ({
        is: () => ({
          gt: async () => ({ data: rows, error: null })
        })
      })
    })
  };
}

function mockClient(
  tables: Record<
    string,
    | ReturnType<typeof makeBusinessesResult>
    | ReturnType<typeof makeSubResult>
    | ReturnType<typeof makeUsageResult>
    | ReturnType<typeof makeResvResult>
    | ReturnType<typeof makeBonusResult>
  >
) {
  return {
    from: (name: string) => {
      const h = tables[name];
      if (!h) throw new Error(`unexpected table ${name}`);
      return h;
    }
  } as Parameters<typeof getVoiceBillingSnapshotForBusiness>[1];
}

describe("getVoiceBillingSnapshotForBusiness", () => {
  beforeEach(() => {
    vi.mocked(createSupabaseServiceClient).mockReset();
  });

  it("returns null when business missing", async () => {
    const client = mockClient({
      businesses: makeBusinessesResult(null, null)
    });
    await expect(getVoiceBillingSnapshotForBusiness("b1", client)).resolves.toBeNull();
  });

  it("returns null on business query error", async () => {
    const client = mockClient({
      businesses: makeBusinessesResult(null, { message: "nope" })
    });
    await expect(getVoiceBillingSnapshotForBusiness("b1", client)).resolves.toBeNull();
  });

  it("returns null when subscription period missing", async () => {
    const client = mockClient({
      businesses: makeBusinessesResult({ tier: "starter", enterprise_limits: null }),
      subscriptions: makeSubResult({ stripe_current_period_start: null })
    });
    await expect(getVoiceBillingSnapshotForBusiness("b1", client)).resolves.toBeNull();
  });

  it("returns null on subscription query error", async () => {
    const client = mockClient({
      businesses: makeBusinessesResult({ tier: "starter", enterprise_limits: null }),
      subscriptions: makeSubResult(null, { message: "db" })
    });
    await expect(getVoiceBillingSnapshotForBusiness("b1", client)).resolves.toBeNull();
  });

  it("uses createSupabaseServiceClient when client omitted", async () => {
    const client = mockClient({
      businesses: makeBusinessesResult({ tier: "starter", enterprise_limits: null }),
      subscriptions: makeSubResult({ stripe_current_period_start: "2026-04-01T00:00:00.000Z" }),
      voice_billing_period_usage: makeUsageResult({
        tier_cap_seconds: 600,
        committed_included_seconds: 0
      }),
      voice_reservations: makeResvResult([]),
      voice_bonus_grants: makeBonusResult([])
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client as never);
    const snap = await getVoiceBillingSnapshotForBusiness("b1");
    expect(createSupabaseServiceClient).toHaveBeenCalled();
    expect(snap?.includedHeadroomSeconds).toBe(600);
  });

  it("uses enterprise_limits for tier cap fallback when usage row absent", async () => {
    const ent = { voiceIncludedSecondsPerStripePeriod: 99_999 };
    const client = mockClient({
      businesses: makeBusinessesResult({ tier: "enterprise", enterprise_limits: ent }),
      subscriptions: makeSubResult({ stripe_current_period_start: "2026-04-01T00:00:00.000Z" }),
      voice_billing_period_usage: makeUsageResult(null),
      voice_reservations: makeResvResult([]),
      voice_bonus_grants: makeBonusResult([])
    });
    const snap = await getVoiceBillingSnapshotForBusiness("b1", client);
    expect(snap?.tierCapSeconds).toBe(99_999);
    expect(snap?.includedHeadroomSeconds).toBe(99_999);
  });

  it("treats null tier as starter and null reservation/bonus rows as empty", async () => {
    const client = {
      from: (name: string) => {
        if (name === "businesses") {
          return makeBusinessesResult({ tier: null, enterprise_limits: null });
        }
        if (name === "subscriptions") {
          return makeSubResult({ stripe_current_period_start: "2026-04-01T00:00:00.000Z" });
        }
        if (name === "voice_billing_period_usage") {
          return makeUsageResult({
            tier_cap_seconds: 600,
            committed_included_seconds: 0
          });
        }
        if (name === "voice_reservations") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  in: async () => ({ data: null, error: null })
                })
              })
            })
          };
        }
        if (name === "voice_bonus_grants") {
          return {
            select: () => ({
              eq: () => ({
                is: () => ({
                  gt: async () => ({ data: null, error: null })
                })
              })
            })
          };
        }
        throw new Error(name);
      }
    } as Parameters<typeof getVoiceBillingSnapshotForBusiness>[1];
    const snap = await getVoiceBillingSnapshotForBusiness("b1", client);
    expect(snap?.reservedIncludedInflight).toBe(0);
    expect(snap?.bonusSecondsAvailable).toBe(0);
  });

  it("returns snapshot with headroom and bonus", async () => {
    const client = mockClient({
      businesses: makeBusinessesResult({ tier: "starter", enterprise_limits: null }),
      subscriptions: makeSubResult({ stripe_current_period_start: "2026-04-01T00:00:00.000Z" }),
      voice_billing_period_usage: makeUsageResult({
        tier_cap_seconds: 600,
        committed_included_seconds: 100
      }),
      voice_reservations: makeResvResult([
        { reserved_included_seconds: 60 },
        { reserved_included_seconds: 40 }
      ]),
      voice_bonus_grants: makeBonusResult([{ seconds_remaining: 120 }, {}])
    });

    const snap = await getVoiceBillingSnapshotForBusiness(
      "00000000-0000-4000-8000-000000000099",
      client
    );
    expect(snap).toEqual({
      stripePeriodStart: "2026-04-01T00:00:00.000Z",
      tierCapSeconds: 600,
      committedIncludedSeconds: 100,
      reservedIncludedInflight: 100,
      includedHeadroomSeconds: 400,
      bonusSecondsAvailable: 120
    });
  });

  it("coerces missing reserved_included_seconds to zero", async () => {
    const client = mockClient({
      businesses: makeBusinessesResult({ tier: "starter", enterprise_limits: null }),
      subscriptions: makeSubResult({ stripe_current_period_start: "2026-04-01T00:00:00.000Z" }),
      voice_billing_period_usage: makeUsageResult({
        tier_cap_seconds: 600,
        committed_included_seconds: 0
      }),
      voice_reservations: makeResvResult([{}]),
      voice_bonus_grants: makeBonusResult([])
    });
    const snap = await getVoiceBillingSnapshotForBusiness("b1", client);
    expect(snap?.reservedIncludedInflight).toBe(0);
  });
});
