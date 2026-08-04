import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/stripe/client", () => ({
  // Priced to agree with the SMS 500 catalog default ($0.02/text = $10.00),
  // so a test can omit `resolvePrice` and exercise the real pricing guard.
  getStripe: vi.fn(() => ({
    prices: {
      retrieve: vi.fn(async () => ({
        unit_amount: 1_000,
        currency: "usd",
        active: true,
        type: "one_time"
      }))
    }
  })),
  createOffSessionPackCharge: vi.fn()
}));

const listCandidates = vi.fn();
const resumeStale = vi.fn();
const claim = vi.fn();
const settle = vi.fn();

vi.mock("@/lib/db/auto-reload", () => ({
  listAutoReloadCandidates: (...a: unknown[]) => listCandidates(...a),
  resumeStaleAutoReload: (...a: unknown[]) => resumeStale(...a),
  claimAutoReload: (...a: unknown[]) => claim(...a),
  settleAutoReload: (...a: unknown[]) => settle(...a)
}));

const voiceSnapshot = vi.fn();
const chatSnapshot = vi.fn();
const smsBonus = vi.fn();
const monthUsage = vi.fn();

vi.mock("@/lib/db/voice-usage", () => ({
  getVoiceBillingSnapshotForBusiness: (...a: unknown[]) => voiceSnapshot(...a)
}));
vi.mock("@/lib/db/chat-usage", () => ({
  getChatSpendSnapshotForBusiness: (...a: unknown[]) => chatSnapshot(...a),
  getSmsBonusTextsRemaining: (...a: unknown[]) => smsBonus(...a)
}));
vi.mock("@/lib/db/usage", () => ({
  getCalendarMonthUsageTotals: (...a: unknown[]) => monthUsage(...a)
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createOffSessionPackCharge } from "@/lib/stripe/client";
import { readRemainingUnits, sweepUsagePackAutoReloads } from "@/lib/billing/auto-reload-sweep";
import type { AutoReloadCandidate } from "@/lib/db/auto-reload";

/**
 * The sweep's decision matrix. The database-level guarantees (the atomic
 * claim, the concurrent double-charge guard, hysteresis against real balance
 * SQL) are proven in tests/worker-integration/auto-reload-sweep.itest.ts;
 * what lives here is every branch of the control flow.
 */

const OLD_ENV = process.env;
const rpc = vi.fn();

function candidate(over: Partial<AutoReloadCandidate> = {}): AutoReloadCandidate {
  return {
    businessId: "biz-1",
    category: "sms",
    packId: "texts_500",
    thresholdUnits: 100,
    monthlyLimitCents: null,
    cooldownMinutes: 120,
    ownerEmail: "owner@example.com",
    tier: "standard",
    enterpriseLimits: null,
    phone: "+14165550100",
    timezone: "America/Toronto",
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: "sub_1",
    stripePeriodStart: "2026-07-24T00:00:00Z",
    stripePaymentMethodId: "pm_1",
    ...over
  };
}

/** Price agrees with the catalog unless a test says otherwise. */
const okPrice = vi.fn(async (p: { catalogPriceCents: number }) => ({
  ok: true as const,
  amountCents: p.catalogPriceCents,
  currency: "usd"
}));

function deps(over: Record<string, unknown> = {}) {
  return {
    client: { rpc } as never,
    now: () => new Date("2026-08-03T12:00:00Z"),
    resolvePrice: okPrice as never,
    ...over
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...OLD_ENV };
  process.env.USAGE_PACK_AUTO_RELOAD_ENABLED = "1";
  process.env.STRIPE_SMS_BONUS_500_PRICE_ID = "price_s500";
  process.env.STRIPE_SMS_BONUS_2000_PRICE_ID = "price_s2000";
  process.env.STRIPE_VOICE_BONUS_30MIN_PRICE_ID = "price_v30";
  process.env.STRIPE_CHAT_CREDIT_5USD_PRICE_ID = "price_c5";

  vi.mocked(createSupabaseServiceClient).mockResolvedValue({ rpc } as never);
  resumeStale.mockResolvedValue({ ok: false, reason: "none" });
  claim.mockResolvedValue({ ok: true, eventId: 42, attemptKey: "biz-1:sms:9" });
  settle.mockResolvedValue({ ok: true, disabled: false });
  rpc.mockResolvedValue({ data: { ok: true }, error: null });
  vi.mocked(createOffSessionPackCharge).mockResolvedValue({ id: "pi_1" } as never);
  // Below threshold by default: 40 bonus texts, plan cap fully used.
  monthUsage.mockResolvedValue({ sms_sent: 999_999, calls_made: 0 });
  smsBonus.mockResolvedValue(40);
});

afterEach(() => {
  process.env = OLD_ENV;
});

describe("the platform kill switch", () => {
  it("does nothing at all when auto-reload is not enabled", async () => {
    delete process.env.USAGE_PACK_AUTO_RELOAD_ENABLED;
    const res = await sweepUsagePackAutoReloads(deps());
    expect(res).toMatchObject({ scanned: 0, charged: 0 });
    expect(listCandidates).not.toHaveBeenCalled();
  });
});

describe("the happy path", () => {
  it("charges, grants, and settles once", async () => {
    listCandidates.mockResolvedValue([candidate()]);
    const res = await sweepUsagePackAutoReloads(deps());

    expect(res).toMatchObject({ scanned: 1, charged: 1, granted: 1, failed: 0 });
    expect(claim).toHaveBeenCalledTimes(1);
    // The grant is keyed on the PaymentIntent, reusing the existing
    // idempotent RPC rather than a new grant path.
    expect(rpc).toHaveBeenCalledWith(
      "apply_sms_bonus_grant_from_checkout",
      expect.objectContaining({ p_checkout_session_id: "pi_pi_1", p_texts_purchased: 500 })
    );
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded", unitsGranted: 500 }),
      expect.anything()
    );
  });

  it("uses the default charge path when none is injected", async () => {
    listCandidates.mockResolvedValue([candidate()]);
    await sweepUsagePackAutoReloads(deps());
    expect(createOffSessionPackCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cus_1",
        paymentMethodId: "pm_1",
        checkoutKind: "sms_bonus_texts",
        unitKey: "smsTexts",
        unitValue: 500,
        eventId: 42
      })
    );
  });

  it("builds its own client when none is injected", async () => {
    listCandidates.mockResolvedValue([]);
    await sweepUsagePackAutoReloads({ resolvePrice: okPrice as never });
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });

  it("runs end to end on defaults alone, with no injected dependencies", async () => {
    // Exercises the real clock, the real pricing guard, and the real charge
    // path rather than the test seams, so the production wiring is covered.
    listCandidates.mockResolvedValue([candidate()]);
    const res = await sweepUsagePackAutoReloads();
    expect(res).toMatchObject({ charged: 1, granted: 1 });
  });

  it("omits the receipt email when the tenant has none on file", async () => {
    listCandidates.mockResolvedValue([candidate({ ownerEmail: null })]);
    await sweepUsagePackAutoReloads(deps());
    expect(createOffSessionPackCharge).toHaveBeenCalledWith(
      expect.objectContaining({ receiptEmail: undefined })
    );
  });
});

describe("skips that must never charge", () => {
  it("skips a balance at or above the threshold", async () => {
    smsBonus.mockResolvedValue(500);
    listCandidates.mockResolvedValue([candidate({ thresholdUnits: 100 })]);
    const res = await sweepUsagePackAutoReloads(deps());
    expect(res).toMatchObject({ skipped: 1, charged: 0 });
    expect(claim).not.toHaveBeenCalled();
  });

  it("skips when the pack's price env is unset", async () => {
    delete process.env.STRIPE_SMS_BONUS_500_PRICE_ID;
    listCandidates.mockResolvedValue([candidate()]);
    const res = await sweepUsagePackAutoReloads(deps());
    expect(res.skipped).toBe(1);
    expect(claim).not.toHaveBeenCalled();
  });

  it("settles a resumed attempt as skipped when the pack vanished", async () => {
    delete process.env.STRIPE_SMS_BONUS_500_PRICE_ID;
    resumeStale.mockResolvedValue({ ok: true, eventId: 7, packId: "texts_500", amountCents: 1000 });
    listCandidates.mockResolvedValue([candidate()]);
    await sweepUsagePackAutoReloads(deps());
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 7, status: "skipped_pack_unavailable" }),
      expect.anything()
    );
  });

  it("skips a threshold the pack cannot clear, even though the route rejects it", async () => {
    // A catalog change can move a pack's size under an already-saved rule.
    listCandidates.mockResolvedValue([candidate({ thresholdUnits: 500 })]);
    const res = await sweepUsagePackAutoReloads(deps());
    expect(res.skipped).toBe(1);
    expect(claim).not.toHaveBeenCalled();
  });

  it("settles a resumed attempt when the threshold became unclearable", async () => {
    resumeStale.mockResolvedValue({ ok: true, eventId: 8, packId: "texts_500", amountCents: 1000 });
    listCandidates.mockResolvedValue([candidate({ thresholdUnits: 500 })]);
    await sweepUsagePackAutoReloads(deps());
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 8, failureCode: "threshold_not_below_pack" }),
      expect.anything()
    );
  });

  it("never charges on a price disagreement", async () => {
    // Nobody sees a checkout page here, so a drift would silently bill the
    // wrong amount on a schedule. Loud pause beats quiet overcharge.
    const mismatch = vi.fn(async () => ({
      ok: false as const,
      reason: "price_mismatch" as const,
      stripeCents: 1500,
      catalogCents: 1000
    }));
    listCandidates.mockResolvedValue([candidate()]);
    const res = await sweepUsagePackAutoReloads(deps({ resolvePrice: mismatch }));
    expect(res).toMatchObject({ skipped: 1, charged: 0 });
    expect(claim).not.toHaveBeenCalled();
  });

  it("skips a price failure with no amount fields", async () => {
    const inactive = vi.fn(async () => ({ ok: false as const, reason: "price_inactive" as const }));
    listCandidates.mockResolvedValue([candidate()]);
    const res = await sweepUsagePackAutoReloads(deps({ resolvePrice: inactive }));
    expect(res.skipped).toBe(1);
  });

  it("skips when there is no Stripe customer to charge", async () => {
    listCandidates.mockResolvedValue([candidate({ stripeCustomerId: null })]);
    const res = await sweepUsagePackAutoReloads(deps());
    expect(res.skipped).toBe(1);
    expect(claim).not.toHaveBeenCalled();
  });

  it("skips an unknown category defensively", async () => {
    listCandidates.mockResolvedValue([
      candidate({ category: "email" as unknown as AutoReloadCandidate["category"] })
    ]);
    const res = await sweepUsagePackAutoReloads(deps());
    expect(res.skipped).toBe(1);
  });

  it("skips when the claim is refused, which is the concurrent-sweep case", async () => {
    claim.mockResolvedValue({ ok: false, reason: "already_claimed" });
    listCandidates.mockResolvedValue([candidate()]);
    const res = await sweepUsagePackAutoReloads(deps());
    expect(res).toMatchObject({ skipped: 1, charged: 0 });
  });

  it("skips when the balance cannot be read", async () => {
    voiceSnapshot.mockResolvedValue(null);
    listCandidates.mockResolvedValue([
      candidate({ category: "voice", packId: "min_30", thresholdUnits: 900 })
    ]);
    const res = await sweepUsagePackAutoReloads(deps());
    expect(res.skipped).toBe(1);
  });
});

describe("resuming a stale attempt", () => {
  it("reuses the same event id, so the Stripe idempotency key is unchanged", async () => {
    // A new event row would mean a new key, and Stripe would create a second
    // PaymentIntent for a charge that may already have succeeded.
    resumeStale.mockResolvedValue({ ok: true, eventId: 99, packId: "texts_500", amountCents: 1000 });
    listCandidates.mockResolvedValue([candidate()]);
    const res = await sweepUsagePackAutoReloads(deps());

    expect(claim).not.toHaveBeenCalled();
    expect(createOffSessionPackCharge).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 99 })
    );
    expect(res.charged).toBe(1);
  });
});

describe("charge failures", () => {
  it("records a hard decline as failed", async () => {
    listCandidates.mockResolvedValue([candidate()]);
    const charge = vi.fn(async () => ({
      ok: false as const,
      error: { code: "card_declined", decline_code: "do_not_honor", message: "declined" }
    }));
    const res = await sweepUsagePackAutoReloads(deps({ charge }));
    expect(res).toMatchObject({ failed: 1, charged: 0, granted: 0 });
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", failureKind: "hard_decline" }),
      expect.anything()
    );
  });

  it("records a bank challenge as requires_action, not a decline", async () => {
    listCandidates.mockResolvedValue([candidate()]);
    const charge = vi.fn(async () => ({
      ok: false as const,
      error: { code: "authentication_required", message: "3DS" }
    }));
    await sweepUsagePackAutoReloads(deps({ charge }));
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ status: "requires_action", failureKind: "requires_action" }),
      expect.anything()
    );
  });

  it("records a thrown Stripe error from the default charge path", async () => {
    vi.mocked(createOffSessionPackCharge).mockRejectedValue({
      code: "card_declined",
      message: "nope"
    });
    listCandidates.mockResolvedValue([candidate()]);
    const res = await sweepUsagePackAutoReloads(deps());
    expect(res.failed).toBe(1);
  });
});

describe("charged but the grant did not land", () => {
  it("still settles as succeeded with the failure recorded", async () => {
    // The money left the account. Marking the attempt failed would let the
    // next tick charge again; the ledger has to say charged-not-granted.
    rpc.mockResolvedValue({ data: null, error: { message: "rpc exploded" } });
    listCandidates.mockResolvedValue([candidate()]);
    const res = await sweepUsagePackAutoReloads(deps());

    expect(res).toMatchObject({ charged: 1, granted: 0 });
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
        unitsGranted: null,
        failureCode: "grant_failed"
      }),
      expect.anything()
    );
  });

  it("treats an RPC that returns ok:false as a failed grant", async () => {
    rpc.mockResolvedValue({ data: { ok: false, reason: "no_active_subscription" }, error: null });
    listCandidates.mockResolvedValue([candidate()]);
    const res = await sweepUsagePackAutoReloads(deps());
    expect(res).toMatchObject({ charged: 1, granted: 0 });
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ failureMessage: "no_active_subscription" }),
      expect.anything()
    );
  });

  it("treats an empty RPC payload as granted", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    listCandidates.mockResolvedValue([candidate()]);
    const res = await sweepUsagePackAutoReloads(deps());
    expect(res.granted).toBe(1);
  });

  it("records a null failure message when the RPC refuses without a reason", async () => {
    rpc.mockResolvedValue({ data: { ok: false }, error: null });
    listCandidates.mockResolvedValue([candidate()]);
    await sweepUsagePackAutoReloads(deps());
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "grant_failed", failureMessage: null }),
      expect.anything()
    );
  });
});

describe("one tenant cannot stall the batch", () => {
  it("records the error and keeps going", async () => {
    listCandidates.mockResolvedValue([
      candidate({ businessId: "biz-bad" }),
      candidate({ businessId: "biz-good" })
    ]);
    resumeStale.mockImplementation(async (businessId: string) => {
      if (businessId === "biz-bad") throw new Error("db blew up");
      return { ok: false, reason: "none" };
    });

    const res = await sweepUsagePackAutoReloads(deps());
    expect(res.errors).toEqual([
      { businessId: "biz-bad", category: "sms", message: "db blew up" }
    ]);
    expect(res.charged).toBe(1);
  });

  it("records a non-Error throw", async () => {
    listCandidates.mockResolvedValue([candidate()]);
    resumeStale.mockRejectedValue("plain string");
    const res = await sweepUsagePackAutoReloads(deps());
    expect(res.errors[0]!.message).toBe("plain string");
  });

  it("chunks a batch larger than the concurrency size", async () => {
    listCandidates.mockResolvedValue(
      Array.from({ length: 23 }, (_, i) => candidate({ businessId: `biz-${i}` }))
    );
    const res = await sweepUsagePackAutoReloads(deps());
    expect(res.scanned).toBe(23);
    expect(res.charged).toBe(23);
  });
});

describe("readRemainingUnits", () => {
  const db = { rpc } as never;

  it("adds included headroom to the purchased voice pool", async () => {
    voiceSnapshot.mockResolvedValue({ includedHeadroomSeconds: 300, bonusSecondsAvailable: 600 });
    expect(await readRemainingUnits(candidate({ category: "voice" }), db)).toBe(900);
  });

  it("returns null when the voice snapshot is unavailable", async () => {
    voiceSnapshot.mockResolvedValue(null);
    expect(await readRemainingUnits(candidate({ category: "voice" }), db)).toBeNull();
  });

  it("adds plan remaining to the SMS pack balance", async () => {
    monthUsage.mockResolvedValue({ sms_sent: 100, calls_made: 0 });
    smsBonus.mockResolvedValue(40);
    // Standard cap is 3000: 2900 plan remaining plus 40 purchased.
    expect(await readRemainingUnits(candidate({ category: "sms" }), db)).toBe(2_940);
  });

  it("floors plan remaining at zero when usage overshot the cap", async () => {
    monthUsage.mockResolvedValue({ sms_sent: 999_999, calls_made: 0 });
    smsBonus.mockResolvedValue(40);
    expect(await readRemainingUnits(candidate({ category: "sms" }), db)).toBe(40);
  });

  it("returns null for an uncapped enterprise plan", async () => {
    // An infinite plan cap can never be crossed, so a threshold on remaining
    // capacity is meaningless rather than merely large.
    expect(
      await readRemainingUnits(
        candidate({ category: "sms", tier: "enterprise", enterpriseLimits: {} }),
        db
      )
    ).toBeNull();
  });

  it("measures chat as headroom under the effective cap", async () => {
    chatSnapshot.mockResolvedValue({ effectiveCapMicros: 10_000_000, spendMicros: 9_000_000 });
    expect(await readRemainingUnits(candidate({ category: "chat" }), db)).toBe(1_000_000);
  });

  it("floors chat headroom at zero when spend overshot the cap", async () => {
    chatSnapshot.mockResolvedValue({ effectiveCapMicros: 10_000_000, spendMicros: 12_000_000 });
    expect(await readRemainingUnits(candidate({ category: "chat" }), db)).toBe(0);
  });

  it("defaults a missing tier rather than throwing", async () => {
    chatSnapshot.mockResolvedValue({ effectiveCapMicros: 5_000_000, spendMicros: 0 });
    expect(await readRemainingUnits(candidate({ category: "chat", tier: null }), db)).toBe(
      5_000_000
    );
    monthUsage.mockResolvedValue({ sms_sent: 0, calls_made: 0 });
    smsBonus.mockResolvedValue(0);
    // Starter cap (100/month) applies when the tier is unknown.
    expect(await readRemainingUnits(candidate({ category: "sms", tier: null }), db)).toBe(100);
  });
});
