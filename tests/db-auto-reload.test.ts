import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  claimAutoReload,
  disableAutoReloadForBusiness,
  disableAutoReloadForBusinessesByPaymentMethod,
  getAutoReloadCard,
  listAutoReloadCandidates,
  listFlaggedAutoReloadCandidates,
  reenableAutoReloadAfterCardAuthorized,
  listAutoReloadEvents,
  listAutoReloadRules,
  resumeStaleAutoReload,
  revokeAutoReloadCard,
  saveAutoReloadCard,
  settleAutoReload,
  upsertAutoReloadRule
} from "@/lib/db/auto-reload";

/**
 * Typed accessors for the auto-reload tables and RPCs. Every function has an
 * error path that must surface rather than silently return an empty result,
 * because a swallowed error here reads as "this tenant has no auto-reload"
 * and would silently stop charging (or, on the settle path, silently leave a
 * charge unsettled).
 */

const mockClientFactory = vi.mocked(createSupabaseServiceClient);

type QueryResult = { data?: unknown; error?: { message: string } | null };

/** Chainable supabase fake, matching tests/booking-page-db.test.ts. */
function fakeDb(results: QueryResult[]) {
  let call = 0;
  const next = () => results[Math.min(call++, results.length - 1)] ?? { data: null, error: null };
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, args: unknown[]) => calls.push({ method, args });

  function builder(): Record<string, unknown> {
    const b: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "order", "limit", "insert", "update", "upsert"]) {
      b[method] = vi.fn((...args: unknown[]) => {
        record(method, args);
        return b;
      });
    }
    b.maybeSingle = vi.fn(() => {
      record("maybeSingle", []);
      return Promise.resolve(next());
    });
    b.single = vi.fn(() => {
      record("single", []);
      return Promise.resolve(next());
    });
    b.then = (resolve: (v: QueryResult) => void) => {
      record("await", []);
      resolve(next());
    };
    return b;
  }

  const from = vi.fn(() => builder());
  const rpc = vi.fn(async (...args: unknown[]) => {
    record("rpc", args);
    return next();
  });
  return { client: { from, rpc } as never, from, rpc, calls };
}

const RULE_ROW = {
  business_id: "biz-1",
  category: "chat",
  enabled: true,
  pack_id: "usd_5",
  // bigint arrives as a string from PostgREST; the mapper must coerce.
  threshold_units: "2000000",
  monthly_limit_cents: 2_000,
  month_key: "2026-08",
  month_spent_cents: 500,
  month_charges: 1,
  cooldown_minutes: 120,
  last_attempt_at: "2026-08-03T00:00:00Z",
  last_success_at: "2026-08-03T00:00:00Z",
  consecutive_failures: 0,
  paused_at: null,
  paused_reason: null,
  disabled_reason: null
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listAutoReloadRules", () => {
  it("maps rows and coerces the bigint threshold", async () => {
    const { client } = fakeDb([{ data: [RULE_ROW], error: null }]);
    const rules = await listAutoReloadRules("biz-1", client);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.thresholdUnits).toBe(2_000_000);
    expect(typeof rules[0]!.thresholdUnits).toBe("number");
    expect(rules[0]!.category).toBe("chat");
    // Client passed in, so the factory is never consulted.
    expect(mockClientFactory).not.toHaveBeenCalled();
  });

  it("returns an empty list when there are no rows", async () => {
    const { client } = fakeDb([{ data: null, error: null }]);
    expect(await listAutoReloadRules("biz-1", client)).toEqual([]);
  });

  it("throws on error", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "boom" } }]);
    await expect(listAutoReloadRules("biz-1", client)).rejects.toThrow(/listAutoReloadRules: boom/);
  });

  it("builds its own client when none is given", async () => {
    const { client } = fakeDb([{ data: [], error: null }]);
    mockClientFactory.mockResolvedValue(client);
    await listAutoReloadRules("biz-1");
    expect(mockClientFactory).toHaveBeenCalledTimes(1);
  });
});

describe("upsertAutoReloadRule", () => {
  it("clears a recoverable pause on save", async () => {
    const { client, calls } = fakeDb([{ data: RULE_ROW, error: null }]);
    const rule = await upsertAutoReloadRule(
      "biz-1",
      {
        category: "chat",
        enabled: true,
        packId: "usd_5",
        thresholdUnits: 2_000_000,
        monthlyLimitCents: 2_000,
        cooldownMinutes: 120
      },
      client
    );
    expect(rule.packId).toBe("usd_5");
    const upsert = calls.find((c) => c.method === "upsert");
    const payload = upsert!.args[0] as Record<string, unknown>;
    // Saving settings IS the acknowledgement a 3DS or budget pause waits for.
    expect(payload.paused_at).toBeNull();
    expect(payload.paused_reason).toBeNull();
    expect(payload.threshold_units).toBe(2_000_000);
    expect(upsert!.args[1]).toEqual({ onConflict: "business_id,category" });
  });

  it("throws on error", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "nope" } }]);
    await expect(
      upsertAutoReloadRule(
        "biz-1",
        {
          category: "sms",
          enabled: false,
          packId: "texts_500",
          thresholdUnits: 100,
          monthlyLimitCents: null,
          cooldownMinutes: 120
        },
        client
      )
    ).rejects.toThrow(/upsertAutoReloadRule: nope/);
  });
});

describe("getAutoReloadCard", () => {
  const CARD_ROW = {
    business_id: "biz-1",
    stripe_payment_method_id: "pm_1",
    card_brand: "visa",
    card_last4: "4242",
    card_exp_month: 12,
    card_exp_year: 2030,
    consent_at: "2026-08-01T00:00:00Z",
    revoked_at: null
  };

  it("maps a row", async () => {
    const { client } = fakeDb([{ data: CARD_ROW, error: null }]);
    const card = await getAutoReloadCard("biz-1", client);
    expect(card).toMatchObject({ stripePaymentMethodId: "pm_1", cardLast4: "4242" });
  });

  it("returns null when no card is authorized", async () => {
    const { client } = fakeDb([{ data: null, error: null }]);
    expect(await getAutoReloadCard("biz-1", client)).toBeNull();
  });

  it("throws on error", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "bad" } }]);
    await expect(getAutoReloadCard("biz-1", client)).rejects.toThrow(/getAutoReloadCard: bad/);
  });
});

describe("saveAutoReloadCard", () => {
  it("clears a previous revoke so re-authorizing works", async () => {
    const { client, calls } = fakeDb([{ data: null, error: null }]);
    await saveAutoReloadCard(
      "biz-1",
      {
        stripePaymentMethodId: "pm_2",
        cardBrand: "visa",
        cardLast4: "4242",
        cardExpMonth: 1,
        cardExpYear: 2031,
        consentUserId: "user-1",
        consentIp: "203.0.113.4",
        consentTextVersion: "v1"
      },
      client
    );
    const payload = calls.find((c) => c.method === "upsert")!.args[0] as Record<string, unknown>;
    expect(payload.revoked_at).toBeNull();
    expect(payload.consent_user_id).toBe("user-1");
    expect(payload.consent_ip).toBe("203.0.113.4");
  });

  it("throws on error", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "denied" } }]);
    await expect(
      saveAutoReloadCard(
        "biz-1",
        {
          stripePaymentMethodId: "pm_2",
          cardBrand: null,
          cardLast4: null,
          cardExpMonth: null,
          cardExpYear: null,
          consentUserId: null,
          consentIp: null,
          consentTextVersion: "v1"
        },
        client
      )
    ).rejects.toThrow(/saveAutoReloadCard: denied/);
  });
});

describe("revokeAutoReloadCard", () => {
  it("only touches a card that is not already revoked", async () => {
    const { client, calls } = fakeDb([{ data: null, error: null }]);
    await revokeAutoReloadCard("biz-1", client);
    expect(calls.some((c) => c.method === "is" && c.args[0] === "revoked_at")).toBe(true);
  });

  it("throws on error", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "locked" } }]);
    await expect(revokeAutoReloadCard("biz-1", client)).rejects.toThrow(
      /revokeAutoReloadCard: locked/
    );
  });
});

describe("listAutoReloadEvents", () => {
  it("maps the ledger, tolerating nulls on an unsettled row", async () => {
    const { client } = fakeDb([
      {
        data: [
          {
            id: "12",
            category: "voice",
            pack_id: "min_30",
            amount_cents: 1_290,
            units_granted: null,
            status: "pending",
            failure_code: null,
            failure_message: null,
            stripe_payment_intent_id: null,
            created_at: "2026-08-03T00:00:00Z",
            settled_at: null
          }
        ],
        error: null
      }
    ]);
    const events = await listAutoReloadEvents("biz-1", 5, client);
    expect(events[0]).toMatchObject({
      id: 12,
      unitsGranted: null,
      status: "pending",
      settledAt: null
    });
  });

  it("maps a settled row's granted units", async () => {
    const { client } = fakeDb([
      {
        data: [
          {
            id: 13,
            category: "sms",
            pack_id: "texts_500",
            amount_cents: 1_000,
            units_granted: "500",
            status: "succeeded",
            failure_code: null,
            failure_message: null,
            stripe_payment_intent_id: "pi_1",
            created_at: "2026-08-03T00:00:00Z",
            settled_at: "2026-08-03T00:00:05Z"
          }
        ],
        error: null
      }
    ]);
    const events = await listAutoReloadEvents("biz-1", 5, client);
    expect(events[0]!.unitsGranted).toBe(500);
    expect(events[0]!.stripePaymentIntentId).toBe("pi_1");
  });

  it("returns an empty list and throws on error", async () => {
    const empty = fakeDb([{ data: null, error: null }]);
    expect(await listAutoReloadEvents("biz-1", 5, empty.client)).toEqual([]);
    const bad = fakeDb([{ data: null, error: { message: "gone" } }]);
    await expect(listAutoReloadEvents("biz-1", 5, bad.client)).rejects.toThrow(
      /listAutoReloadEvents: gone/
    );
  });
});

describe("listAutoReloadCandidates", () => {
  it("maps the prefilter rows", async () => {
    const { client } = fakeDb([
      {
        data: [
          {
            business_id: "biz-1",
            category: "voice",
            pack_id: "min_30",
            threshold_units: "900",
            monthly_limit_cents: 5_000,
            cooldown_minutes: 30,
            owner_email: "o@example.com",
            tier: "standard",
            enterprise_limits: null,
            phone: "+14165550100",
            timezone: "America/Toronto",
            stripe_customer_id: "cus_1",
            stripe_subscription_id: "sub_1",
            stripe_period_start: "2026-07-24T00:00:00Z",
            stripe_payment_method_id: "pm_1"
          }
        ],
        error: null
      }
    ]);
    const rows = await listAutoReloadCandidates(200, client);
    expect(rows[0]).toMatchObject({
      businessId: "biz-1",
      thresholdUnits: 900,
      monthlyLimitCents: 5_000,
      stripePaymentMethodId: "pm_1"
    });
  });

  it("tolerates every nullable column being null", async () => {
    const { client } = fakeDb([
      {
        data: [
          {
            business_id: "biz-2",
            category: "sms",
            pack_id: "texts_500",
            threshold_units: 100,
            monthly_limit_cents: null,
            cooldown_minutes: 120,
            owner_email: null,
            tier: null,
            enterprise_limits: undefined,
            phone: null,
            timezone: null,
            stripe_customer_id: null,
            stripe_subscription_id: null,
            stripe_period_start: null,
            stripe_payment_method_id: "pm_2"
          }
        ],
        error: null
      }
    ]);
    const rows = await listAutoReloadCandidates(10, client);
    expect(rows[0]).toMatchObject({
      monthlyLimitCents: null,
      ownerEmail: null,
      enterpriseLimits: null,
      stripePeriodStart: null
    });
  });

  it("returns empty and throws on error", async () => {
    const empty = fakeDb([{ data: null, error: null }]);
    expect(await listAutoReloadCandidates(10, empty.client)).toEqual([]);
    const bad = fakeDb([{ data: null, error: { message: "rpc down" } }]);
    await expect(listAutoReloadCandidates(10, bad.client)).rejects.toThrow(
      /listAutoReloadCandidates: rpc down/
    );
  });
});

describe("listFlaggedAutoReloadCandidates", () => {
  it("reads the queue RPC and maps rows the same way as the full scan", async () => {
    // Same mapper as listAutoReloadCandidates, so the fast path and the full
    // scan can never disagree about what a candidate is.
    const { client, calls } = fakeDb([
      {
        data: [
          {
            business_id: "biz-1",
            category: "sms",
            pack_id: "texts_500",
            threshold_units: "100",
            monthly_limit_cents: null,
            cooldown_minutes: 120,
            owner_email: "o@example.com",
            business_name: "Acme",
            tier: "standard",
            enterprise_limits: null,
            phone: null,
            timezone: null,
            stripe_customer_id: "cus_1",
            stripe_subscription_id: "sub_1",
            stripe_period_start: null,
            stripe_payment_method_id: "pm_1"
          }
        ],
        error: null
      }
    ]);
    const rows = await listFlaggedAutoReloadCandidates(50, client);
    expect(rows[0]).toMatchObject({
      businessId: "biz-1",
      thresholdUnits: 100,
      businessName: "Acme",
      stripePaymentMethodId: "pm_1"
    });
    expect(calls.find((c) => c.method === "rpc")!.args[0]).toBe(
      "usage_pack_auto_reload_flagged_candidates"
    );
  });

  it("returns empty and throws on error", async () => {
    const empty = fakeDb([{ data: null, error: null }]);
    expect(await listFlaggedAutoReloadCandidates(50, empty.client)).toEqual([]);
    const bad = fakeDb([{ data: null, error: { message: "rpc down" } }]);
    await expect(listFlaggedAutoReloadCandidates(50, bad.client)).rejects.toThrow(
      /listFlaggedAutoReloadCandidates: rpc down/
    );
  });
});

describe("claimAutoReload", () => {
  const params = {
    businessId: "biz-1",
    category: "sms" as const,
    packId: "texts_500",
    amountCents: 1_000,
    balanceUnits: 40,
    thresholdUnits: 100,
    platformMaxCents: 50_000,
    currency: "usd"
  };

  it("returns the claimed event id and stores the charge currency", async () => {
    const { client, calls } = fakeDb([
      { data: { ok: true, event_id: 7, attempt_key: "biz-1:sms:9" }, error: null }
    ]);
    expect(await claimAutoReload(params, client)).toEqual({
      ok: true,
      eventId: 7,
      attemptKey: "biz-1:sms:9"
    });
    // Stored on the event so a resumed retry replays identical parameters.
    const args = calls.find((c) => c.method === "rpc")!.args[1] as Record<string, unknown>;
    expect(args.p_currency).toBe("usd");
  });

  it("surfaces the refusal reason", async () => {
    const { client } = fakeDb([{ data: { ok: false, reason: "already_claimed" }, error: null }]);
    expect(await claimAutoReload(params, client)).toEqual({
      ok: false,
      reason: "already_claimed"
    });
  });

  it("falls back to unknown when the RPC returns nothing usable", async () => {
    const { client } = fakeDb([{ data: null, error: null }]);
    expect(await claimAutoReload(params, client)).toEqual({ ok: false, reason: "unknown" });
  });

  it("throws on error rather than reporting a refusal", async () => {
    // A transport failure must not be mistaken for "the claim was refused",
    // which would silently stop charging for every tenant.
    const { client } = fakeDb([{ data: null, error: { message: "timeout" } }]);
    await expect(claimAutoReload(params, client)).rejects.toThrow(/claimAutoReload: timeout/);
  });
});

describe("resumeStaleAutoReload", () => {
  it("returns the resumed attempt so the same idempotency key is reused", async () => {
    // Pack and currency come back from the EVENT, not the rule: a resumed
    // charge has to replay the original parameters, or Stripe rejects the
    // reused idempotency key and the grant could disagree with the charge.
    const { client } = fakeDb([
      {
        data: {
          ok: true,
          event_id: 4,
          pack_id: "min_30",
          amount_cents: 1_290,
          currency: "cad"
        },
        error: null
      }
    ]);
    expect(await resumeStaleAutoReload("biz-1", "voice", client)).toEqual({
      ok: true,
      eventId: 4,
      packId: "min_30",
      amountCents: 1_290,
      currency: "cad"
    });
  });

  it("falls back to USD when an older pending row has no currency", async () => {
    const { client } = fakeDb([
      { data: { ok: true, event_id: 5, pack_id: "min_30", amount_cents: 1_290 }, error: null }
    ]);
    const res = await resumeStaleAutoReload("biz-1", "voice", client);
    expect(res).toMatchObject({ ok: true, currency: "usd" });
  });

  it("reports no stale attempt, and an abandoned one", async () => {
    const none = fakeDb([{ data: { ok: false, reason: "none" }, error: null }]);
    expect(await resumeStaleAutoReload("biz-1", "voice", none.client)).toEqual({
      ok: false,
      reason: "none"
    });
    const abandoned = fakeDb([{ data: { ok: false, reason: "abandoned" }, error: null }]);
    expect(await resumeStaleAutoReload("biz-1", "voice", abandoned.client)).toEqual({
      ok: false,
      reason: "abandoned"
    });
    const empty = fakeDb([{ data: null, error: null }]);
    expect(await resumeStaleAutoReload("biz-1", "voice", empty.client)).toEqual({
      ok: false,
      reason: "unknown"
    });
  });

  it("throws on error", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "nope" } }]);
    await expect(resumeStaleAutoReload("biz-1", "voice", client)).rejects.toThrow(
      /resumeStaleAutoReload: nope/
    );
  });
});

describe("settleAutoReload", () => {
  it("passes every field through and reports a disable", async () => {
    const { client, calls } = fakeDb([{ data: { ok: true, disabled: true }, error: null }]);
    const res = await settleAutoReload(
      {
        eventId: 9,
        status: "failed",
        failureKind: "hard_decline",
        failureCode: "do_not_honor",
        failureMessage: "declined"
      },
      client
    );
    expect(res).toMatchObject({ ok: true, disabled: true });
    const args = calls.find((c) => c.method === "rpc")!.args[1] as Record<string, unknown>;
    expect(args.p_failure_kind).toBe("hard_decline");
    expect(args.p_units_granted).toBeNull();
    expect(args.p_grant_source_id).toBeNull();
  });

  it("defaults the optional fields to null on a success", async () => {
    const { client, calls } = fakeDb([{ data: { ok: true, disabled: false }, error: null }]);
    await settleAutoReload(
      { eventId: 9, status: "succeeded", unitsGranted: 500, grantSourceId: "pi_abc" },
      client
    );
    const args = calls.find((c) => c.method === "rpc")!.args[1] as Record<string, unknown>;
    expect(args.p_units_granted).toBe(500);
    expect(args.p_grant_source_id).toBe("pi_abc");
    expect(args.p_failure_kind).toBeNull();
  });

  it("reports a refusal reason and throws on error", async () => {
    const refused = fakeDb([{ data: { ok: false, reason: "already_settled" }, error: null }]);
    expect(await settleAutoReload({ eventId: 9, status: "succeeded" }, refused.client)).toEqual({
      ok: false,
      disabled: false,
      reason: "already_settled"
    });
    const empty = fakeDb([{ data: null, error: null }]);
    expect(await settleAutoReload({ eventId: 9, status: "succeeded" }, empty.client)).toMatchObject({
      ok: false,
      disabled: false
    });
    const bad = fakeDb([{ data: null, error: { message: "boom" } }]);
    await expect(
      settleAutoReload({ eventId: 9, status: "succeeded" }, bad.client)
    ).rejects.toThrow(/settleAutoReload: boom/);
  });
});

describe("disableAutoReloadForBusinessesByPaymentMethod", () => {
  it("disables and revokes every business that authorized the detached card", async () => {
    // Stripe's payment_method.detached event does not name a business, so the
    // card table is the only lookup. Without this the sweep would keep trying
    // a card that no longer exists and burn a failure strike every tick.
    const { client, calls } = fakeDb([
      { data: [{ business_id: "biz-1" }, { business_id: "biz-2" }], error: null },
      { data: 1, error: null },
      { data: null, error: null },
      { data: 1, error: null },
      { data: null, error: null }
    ]);
    expect(await disableAutoReloadForBusinessesByPaymentMethod("pm_gone", client)).toBe(2);

    const rpcCalls = calls.filter((c) => c.method === "rpc");
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0]!.args[1]).toMatchObject({
      p_business_id: "biz-1",
      p_reason: "card_detached"
    });
  });

  it("is a no-op when the card was never authorized here", async () => {
    const { client, calls } = fakeDb([{ data: [], error: null }]);
    expect(await disableAutoReloadForBusinessesByPaymentMethod("pm_unknown", client)).toBe(0);
    expect(calls.filter((c) => c.method === "rpc")).toHaveLength(0);
  });

  it("tolerates a null lookup result", async () => {
    const { client } = fakeDb([{ data: null, error: null }]);
    expect(await disableAutoReloadForBusinessesByPaymentMethod("pm_null", client)).toBe(0);
  });

  it("throws on error", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "lookup failed" } }]);
    await expect(
      disableAutoReloadForBusinessesByPaymentMethod("pm_x", client)
    ).rejects.toThrow(/disableAutoReloadForBusinessesByPaymentMethod: lookup failed/);
  });
});

describe("disableAutoReloadForBusiness", () => {
  it("returns how many rules were disabled", async () => {
    const { client } = fakeDb([{ data: 3, error: null }]);
    expect(await disableAutoReloadForBusiness("biz-1", "dispute", client)).toBe(3);
  });

  it("coerces a null count to zero", async () => {
    const { client } = fakeDb([{ data: null, error: null }]);
    expect(await disableAutoReloadForBusiness("biz-1", "dispute", client)).toBe(0);
  });

  it("throws on error", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "denied" } }]);
    await expect(disableAutoReloadForBusiness("biz-1", "dispute", client)).rejects.toThrow(
      /disableAutoReloadForBusiness: denied/
    );
  });
});

describe("reenableAutoReloadAfterCardAuthorized", () => {
  it("restores only rules switched off because the card went away", async () => {
    // Replacing a card can emit payment_method.detached for the OLD method
    // before setup Checkout completes for the new one. Without this a tenant
    // who did exactly the right thing ends up silently switched off.
    const { client, calls } = fakeDb([{ data: [{ category: "sms" }], error: null }]);
    expect(await reenableAutoReloadAfterCardAuthorized("biz-1", client)).toBe(1);

    const eqArgs = calls.filter((c) => c.method === "eq").map((c) => c.args);
    // Scoped to the marker only the detach handler sets, so a rule disabled
    // for declines, a dispute, or a cancellation stays off.
    expect(eqArgs).toContainEqual(["disabled_reason", "card_detached"]);

    const payload = calls.find((c) => c.method === "update")!.args[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      enabled: true,
      disabled_reason: null,
      paused_reason: null,
      consecutive_failures: 0
    });
  });

  it("returns zero when nothing was disabled that way", async () => {
    const { client } = fakeDb([{ data: [], error: null }]);
    expect(await reenableAutoReloadAfterCardAuthorized("biz-1", client)).toBe(0);
    const nullish = fakeDb([{ data: null, error: null }]);
    expect(await reenableAutoReloadAfterCardAuthorized("biz-1", nullish.client)).toBe(0);
  });

  it("throws on error", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "denied" } }]);
    await expect(reenableAutoReloadAfterCardAuthorized("biz-1", client)).rejects.toThrow(
      /reenableAutoReloadAfterCardAuthorized: denied/
    );
  });
});
