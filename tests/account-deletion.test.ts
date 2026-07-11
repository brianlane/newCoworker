/**
 * Tests for the self-serve account-deletion lib: the impact preview
 * (business-scoped counts + release flags) and the subscription-state
 * eligibility gate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/db/telnyx-routes", () => ({ getTelnyxVoiceRouteForBusiness: vi.fn() }));

import {
  DELETE_CONFIRM_PHRASE,
  getAccountDeletionImpact,
  resolveAccountDeletionEligibility,
  resolveAccountDeletionEligibilityForRows
} from "@/lib/account/deletion";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusiness } from "@/lib/db/businesses";
import { getTelnyxVoiceRouteForBusiness } from "@/lib/db/telnyx-routes";

const BIZ = "11111111-1111-4111-8111-111111111111";

/**
 * Count-query mock: every `.from(t).select(..., {head, count}).eq(...)`
 * chain (optionally followed by `.neq(...)`) resolves with the count
 * configured for that table (or an error). The chain object is thenable so
 * both `await q` and `await q.neq(...)` work, mirroring supabase-js.
 */
function mockCountDb(
  countsByTable: Record<string, number | { error: string }>
) {
  const neqCalls: Array<{ table: string; column: string; value: string }> = [];
  const resolveFor = (table: string) => {
    const entry = countsByTable[table];
    if (entry !== undefined && typeof entry === "object") {
      return { count: null, error: { message: entry.error } };
    }
    return { count: entry ?? 0, error: null };
  };
  return {
    neqCalls,
    from: vi.fn((table: string) => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockImplementation(() => ({
          then: (onFulfilled: (v: unknown) => unknown) =>
            Promise.resolve(resolveFor(table)).then(onFulfilled),
          neq: vi.fn().mockImplementation((column: string, value: string) => {
            neqCalls.push({ table, column, value });
            return Promise.resolve(resolveFor(table));
          })
        }))
      })
    }))
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValue(null as never);
});

describe("getAccountDeletionImpact", () => {
  it("returns null when the business does not exist", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null as never);
    const impact = await getAccountDeletionImpact(BIZ, mockCountDb({}) as never);
    expect(impact).toBeNull();
  });

  it("collects business-scoped counts plus DID and VPS flags", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Sunrise Realty",
      hostinger_vps_id: "163263"
    } as never);
    vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValue({
      to_e164: "+16025550100"
    } as never);
    const db = mockCountDb({
      contacts: 12,
      voice_call_transcripts: 3,
      sms_inbound_jobs: 40,
      sms_outbound_log: 55,
      email_log: 7,
      ai_flows: 2,
      ai_flow_team_members: 4,
      business_members: 2
    });

    const impact = await getAccountDeletionImpact(BIZ, db as never);

    // Revoked invites don't lose anything on delete — the members count
    // must exclude them, matching listAccessibleBusinesses.
    expect(db.neqCalls).toEqual([
      { table: "business_members", column: "status", value: "revoked" }
    ]);
    expect(impact).toEqual({
      businessName: "Sunrise Realty",
      counts: {
        contacts: 12,
        voiceTranscripts: 3,
        smsInbound: 40,
        smsOutbound: 55,
        emails: 7,
        aiflows: 2,
        employees: 4,
        dashboardMembers: 2
      },
      hasVps: true,
      didE164: "+16025550100"
    });
  });

  it("degrades failed counts to 0 instead of blocking the preview", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Acme",
      hostinger_vps_id: null
    } as never);
    const db = mockCountDb({
      contacts: { error: "relation missing" },
      email_log: 9
    });

    const impact = await getAccountDeletionImpact(BIZ, db as never);

    expect(impact?.counts.contacts).toBe(0);
    expect(impact?.counts.emails).toBe(9);
    expect(impact?.hasVps).toBe(false);
    expect(impact?.didE164).toBeNull();
  });

  it("tolerates a DID lookup failure (display-only)", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Acme",
      hostinger_vps_id: null
    } as never);
    vi.mocked(getTelnyxVoiceRouteForBusiness).mockRejectedValue(new Error("db down"));

    const impact = await getAccountDeletionImpact(BIZ, mockCountDb({}) as never);

    expect(impact?.didE164).toBeNull();
  });

  it("falls back to the service client when none is provided", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Acme",
      hostinger_vps_id: null
    } as never);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(mockCountDb({}) as never);

    const impact = await getAccountDeletionImpact(BIZ);

    expect(impact?.businessName).toBe("Acme");
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("resolveAccountDeletionEligibility", () => {
  const NOW = new Date("2026-07-10T00:00:00Z");
  const base = { grace_ends_at: null, wiped_at: null, stripe_subscription_id: null };

  it("allows deletion when there is no subscription row (never paid)", () => {
    expect(resolveAccountDeletionEligibility(null)).toEqual({ eligible: true });
  });

  it("allows deletion for pending and fully-canceled subscriptions", () => {
    expect(resolveAccountDeletionEligibility({ status: "pending", ...base }, NOW)).toEqual({
      eligible: true
    });
    expect(resolveAccountDeletionEligibility({ status: "canceled", ...base }, NOW)).toEqual({
      eligible: true
    });
  });

  it("refuses active subscriptions (cancellation lifecycle owns teardown)", () => {
    expect(resolveAccountDeletionEligibility({ status: "active", ...base }, NOW)).toEqual({
      eligible: false,
      reason: "active_subscription"
    });
  });

  it("refuses past_due subscriptions (billing must resolve first)", () => {
    expect(resolveAccountDeletionEligibility({ status: "past_due", ...base }, NOW)).toEqual({
      eligible: false,
      reason: "past_due_subscription"
    });
  });

  it("refuses canceled subscriptions still inside the retention grace window", () => {
    expect(
      resolveAccountDeletionEligibility(
        { ...base, status: "canceled", grace_ends_at: "2026-07-20T00:00:00Z" },
        NOW
      )
    ).toEqual({ eligible: false, reason: "canceled_in_grace" });
  });

  it("refuses non-canceled rows that already carry a Stripe subscription id (checkout in flight)", () => {
    expect(
      resolveAccountDeletionEligibility(
        { ...base, status: "pending", stripe_subscription_id: "sub_123" },
        NOW
      )
    ).toEqual({ eligible: false, reason: "checkout_in_flight" });
    // Fully-canceled rows keep their Stripe id but are still deletable —
    // the cancellation lifecycle already tore Stripe down.
    expect(
      resolveAccountDeletionEligibility(
        { ...base, status: "canceled", stripe_subscription_id: "sub_123" },
        NOW
      )
    ).toEqual({ eligible: true });
  });

  it("allows deletion once the grace window has elapsed or the wipe already ran", () => {
    expect(
      resolveAccountDeletionEligibility(
        { ...base, status: "canceled", grace_ends_at: "2026-07-01T00:00:00Z" },
        NOW
      )
    ).toEqual({ eligible: true });
    expect(
      resolveAccountDeletionEligibility(
        {
          ...base,
          status: "canceled",
          grace_ends_at: "2026-07-20T00:00:00Z",
          wiped_at: "2026-07-05T00:00:00Z"
        },
        NOW
      )
    ).toEqual({ eligible: true });
  });

  it("defaults `now` to the wallclock when omitted", () => {
    expect(
      resolveAccountDeletionEligibility({
        ...base,
        status: "canceled",
        grace_ends_at: "2999-01-01T00:00:00Z"
      })
    ).toEqual({ eligible: false, reason: "canceled_in_grace" });
  });
});

describe("resolveAccountDeletionEligibilityForRows", () => {
  const NOW = new Date("2026-07-10T00:00:00Z");
  const base = { grace_ends_at: null, wiped_at: null, stripe_subscription_id: null };

  it("is eligible for an empty row set (never had a subscription)", () => {
    expect(resolveAccountDeletionEligibilityForRows([], NOW)).toEqual({ eligible: true });
  });

  it("refuses when ANY row blocks — an active row shadowed by a newer pending row still gates", () => {
    expect(
      resolveAccountDeletionEligibilityForRows(
        [
          { ...base, status: "pending" },
          { ...base, status: "active" }
        ],
        NOW
      )
    ).toEqual({ eligible: false, reason: "active_subscription" });
  });

  it("is eligible when every row is non-blocking", () => {
    expect(
      resolveAccountDeletionEligibilityForRows(
        [
          { ...base, status: "pending" },
          { ...base, status: "canceled", stripe_subscription_id: "sub_1" }
        ],
        NOW
      )
    ).toEqual({ eligible: true });
  });

  it("defaults `now` to the wallclock when omitted", () => {
    expect(
      resolveAccountDeletionEligibilityForRows([
        { ...base, status: "canceled", grace_ends_at: "2999-01-01T00:00:00Z" }
      ])
    ).toEqual({ eligible: false, reason: "canceled_in_grace" });
  });
});

describe("DELETE_CONFIRM_PHRASE", () => {
  it("is the literal BizBlasts-style phrase the UI and route both check", () => {
    expect(DELETE_CONFIRM_PHRASE).toBe("DELETE");
  });
});
