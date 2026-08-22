import { describe, expect, it, vi } from "vitest";
import {
  ABANDONED_SIGNUP_MAX_DELETES_PER_RUN,
  ABANDONED_SIGNUP_MIN_AGE_MS,
  CUSTOMER_ACTIVITY_TABLES,
  classifyAbandonedSignup,
  loadAbandonedSignupFacts,
  sweepAbandonedSignups,
  type AbandonedSignupCandidate,
  type AbandonedSignupSweepDeps
} from "@/lib/onboarding/abandoned-signup-cleanup";
import type { BusinessRow } from "@/lib/db/businesses";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => {
    throw new Error("default client must not be used in tests");
  })
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const NOW = Date.parse("2026-08-22T00:00:00.000Z");
const LONG_AGO = new Date(NOW - ABANDONED_SIGNUP_MIN_AGE_MS - 1).toISOString();
const PENDING_ID = "a912aff5-dd87-49fb-ad6a-477acefb66c0";

function biz(overrides: Partial<BusinessRow> = {}): BusinessRow {
  return {
    id: PENDING_ID,
    name: "KIN Integrated Child Health",
    owner_email: `pending+${PENDING_ID}@onboarding.local`,
    tier: "standard",
    status: "offline",
    hostinger_vps_id: null,
    hostinger_subscription_id: null,
    admin_pinned: false,
    created_at: LONG_AGO,
    ...overrides
  } as BusinessRow;
}

function candidate(
  overrides: Partial<AbandonedSignupCandidate> = {}
): AbandonedSignupCandidate {
  return {
    business: biz(),
    subscriptions: [
      { status: "pending", stripe_customer_id: null, stripe_subscription_id: null }
    ],
    hasVpsRecord: false,
    hasWhiteGlove: false,
    hasCustomerActivity: false,
    ...overrides
  };
}

describe("classifyAbandonedSignup", () => {
  it("deletes a never-paid signup past the age threshold", () => {
    expect(classifyAbandonedSignup(candidate(), NOW)).toEqual({ deletable: true });
  });

  it("deletes a cart abandoned before any subscription row was written", () => {
    expect(classifyAbandonedSignup(candidate({ subscriptions: [] }), NOW)).toEqual({
      deletable: true
    });
  });

  // The load-bearing guard. Every sandbox, demo, and paying tenant carries a
  // real address, so this single check is what keeps them out of the sweep.
  it("spares any row whose owner email is a real address", () => {
    const sandbox = biz({
      id: "e2b7a1c4-0000-4000-8000-000000000001",
      name: "Zoom Review Sandbox (internal)",
      owner_email: "zoom.reviewer@newcoworker.com"
    });
    expect(classifyAbandonedSignup(candidate({ business: sandbox }), NOW)).toEqual({
      deletable: false,
      reason: "owner_claimed"
    });
  });

  // A sentinel built from a DIFFERENT business's id must not match: the guard
  // is self-referential precisely so a copied or guessed value cannot pass.
  it("spares a row carrying another business's sentinel", () => {
    const impostor = biz({
      owner_email: "pending+00000000-0000-4000-8000-000000000000@onboarding.local"
    });
    expect(classifyAbandonedSignup(candidate({ business: impostor }), NOW)).toEqual({
      deletable: false,
      reason: "owner_claimed"
    });
  });

  it.each(["online", "high_load", "wiped"] as const)(
    "spares a business in status %s",
    (status) => {
      expect(
        classifyAbandonedSignup(candidate({ business: biz({ status }) }), NOW)
      ).toEqual({ deletable: false, reason: "not_offline" });
    }
  );

  it("spares an admin-pinned business", () => {
    expect(
      classifyAbandonedSignup(candidate({ business: biz({ admin_pinned: true }) }), NOW)
    ).toEqual({ deletable: false, reason: "admin_pinned" });
  });

  it("treats a missing admin_pinned flag as not pinned", () => {
    const legacy = biz();
    delete (legacy as { admin_pinned?: boolean }).admin_pinned;
    expect(classifyAbandonedSignup(candidate({ business: legacy }), NOW)).toEqual({
      deletable: true
    });
  });

  it("spares a business pointing at a VM", () => {
    expect(
      classifyAbandonedSignup(
        candidate({ business: biz({ hostinger_vps_id: "1806097" }) }),
        NOW
      )
    ).toEqual({ deletable: false, reason: "vps_linked" });
  });

  // Hardware can be paid for before the VM id is stamped, so the billing
  // subscription is its own signal.
  it("spares a business with a Hostinger billing subscription but no VM id", () => {
    expect(
      classifyAbandonedSignup(
        candidate({ business: biz({ hostinger_subscription_id: "169rR3VOTEcjx7ysQ" }) }),
        NOW
      )
    ).toEqual({ deletable: false, reason: "vps_linked" });
  });

  it("spares a business with an SSH key or pooled box record", () => {
    expect(classifyAbandonedSignup(candidate({ hasVpsRecord: true }), NOW)).toEqual({
      deletable: false,
      reason: "vps_linked"
    });
  });

  it("spares a business whose subscription carries a Stripe customer", () => {
    expect(
      classifyAbandonedSignup(
        candidate({
          subscriptions: [
            {
              status: "pending",
              stripe_customer_id: "cus_UQWn2pHUJQWmRU",
              stripe_subscription_id: null
            }
          ]
        }),
        NOW
      )
    ).toEqual({ deletable: false, reason: "stripe_linked" });
  });

  it("spares a business whose subscription carries a Stripe subscription id", () => {
    expect(
      classifyAbandonedSignup(
        candidate({
          subscriptions: [
            {
              status: "pending",
              stripe_customer_id: null,
              stripe_subscription_id: "sub_1TRfjvFv205jOP2fzahmHdfT"
            }
          ]
        }),
        NOW
      )
    ).toEqual({ deletable: false, reason: "stripe_linked" });
  });

  // HQ's exact shape: billed outside Stripe, so it has an `active`
  // subscription with both Stripe ids null. A "no Stripe linkage" rule alone
  // would delete it.
  it.each(["active", "past_due", "canceled"] as const)(
    "spares a business with a %s subscription carrying no Stripe ids",
    (status) => {
      expect(
        classifyAbandonedSignup(
          candidate({
            subscriptions: [
              { status, stripe_customer_id: null, stripe_subscription_id: null }
            ]
          }),
          NOW
        )
      ).toEqual({ deletable: false, reason: "subscription_not_pending" });
    }
  );

  it("spares a business with a white-glove intake or offer attached", () => {
    expect(classifyAbandonedSignup(candidate({ hasWhiteGlove: true }), NOW)).toEqual({
      deletable: false,
      reason: "white_glove_attached"
    });
  });

  it("spares a business that has served a customer", () => {
    expect(
      classifyAbandonedSignup(candidate({ hasCustomerActivity: true }), NOW)
    ).toEqual({ deletable: false, reason: "customer_activity" });
  });

  it("spares a signup younger than the age threshold", () => {
    const fresh = biz({ created_at: new Date(NOW - 1000).toISOString() });
    expect(classifyAbandonedSignup(candidate({ business: fresh }), NOW)).toEqual({
      deletable: false,
      reason: "too_young"
    });
  });

  it("spares a signup exactly at the threshold and deletes one past it", () => {
    const atEdge = biz({
      created_at: new Date(NOW - ABANDONED_SIGNUP_MIN_AGE_MS).toISOString()
    });
    expect(classifyAbandonedSignup(candidate({ business: atEdge }), NOW)).toEqual({
      deletable: true
    });
  });

  it("keeps the threshold clear of the 72 hour onboarding-token TTL", () => {
    expect(ABANDONED_SIGNUP_MIN_AGE_MS).toBeGreaterThan(72 * 60 * 60 * 1000);
  });
});

/** Chainable PostgREST fake: `.select(...).eq(...)` resolves to `{ data, count, error }`. */
function makeDb(handler: (table: string) => { count?: number | null; data?: unknown; error?: { message: string } | null }) {
  return {
    from(table: string) {
      const outcome = handler(table);
      const chain = {
        select: () => chain,
        eq: () => chain,
        then: (resolve: (v: unknown) => unknown) =>
          resolve({
            data: outcome.data ?? null,
            count: outcome.count ?? null,
            error: outcome.error ?? null
          })
      };
      return chain;
    }
  } as unknown as Parameters<typeof loadAbandonedSignupFacts>[1];
}

describe("loadAbandonedSignupFacts", () => {
  it("reports a clean abandoned cart", async () => {
    const db = makeDb((table) =>
      table === "subscriptions"
        ? { data: [{ status: "pending", stripe_customer_id: null, stripe_subscription_id: null }] }
        : { count: 0 }
    );
    await expect(loadAbandonedSignupFacts(PENDING_ID, db)).resolves.toEqual({
      subscriptions: [
        { status: "pending", stripe_customer_id: null, stripe_subscription_id: null }
      ],
      hasVpsRecord: false,
      hasWhiteGlove: false,
      hasCustomerActivity: false
    });
  });

  it("treats a null count and a null subscription list as empty", async () => {
    const db = makeDb(() => ({ count: null, data: null }));
    await expect(loadAbandonedSignupFacts(PENDING_ID, db)).resolves.toEqual({
      subscriptions: [],
      hasVpsRecord: false,
      hasWhiteGlove: false,
      hasCustomerActivity: false
    });
  });

  it.each([
    ["vps_ssh_keys", "hasVpsRecord"],
    ["vps_inventory", "hasVpsRecord"],
    ["white_glove_intakes", "hasWhiteGlove"],
    ["white_glove_offers", "hasWhiteGlove"]
  ])("flags %s as %s", async (table, flag) => {
    const db = makeDb((t) => (t === table ? { count: 1 } : { count: 0 }));
    const facts = await loadAbandonedSignupFacts(PENDING_ID, db);
    expect(facts[flag as "hasVpsRecord" | "hasWhiteGlove"]).toBe(true);
  });

  it.each(CUSTOMER_ACTIVITY_TABLES)("flags a row in %s as customer activity", async (table) => {
    const db = makeDb((t) => (t === table ? { count: 1 } : { count: 0 }));
    const facts = await loadAbandonedSignupFacts(PENDING_ID, db);
    expect(facts.hasCustomerActivity).toBe(true);
  });

  it("throws when the subscription read fails", async () => {
    const db = makeDb((t) =>
      t === "subscriptions" ? { error: { message: "boom" } } : { count: 0 }
    );
    await expect(loadAbandonedSignupFacts(PENDING_ID, db)).rejects.toThrow(
      "loadAbandonedSignupFacts(subscriptions): boom"
    );
  });

  it("throws when a count read fails", async () => {
    const db = makeDb((t) =>
      t === "vps_ssh_keys" ? { error: { message: "nope" } } : { count: 0, data: [] }
    );
    await expect(loadAbandonedSignupFacts(PENDING_ID, db)).rejects.toThrow(
      "countFor(vps_ssh_keys): nope"
    );
  });
});

function makeDeps(overrides: Partial<AbandonedSignupSweepDeps> = {}): AbandonedSignupSweepDeps {
  return {
    client: {} as never,
    listBusinesses: vi.fn(async () => [biz()]) as never,
    loadFacts: vi.fn(async () => ({
      subscriptions: [
        { status: "pending" as const, stripe_customer_id: null, stripe_subscription_id: null }
      ],
      hasVpsRecord: false,
      hasWhiteGlove: false,
      hasCustomerActivity: false
    })),
    deleteOnboardingDraft: vi.fn(async () => {}) as never,
    deleteBusiness: vi.fn(async () => {}) as never,
    now: () => NOW,
    ...overrides
  };
}

describe("sweepAbandonedSignups", () => {
  it("deletes the draft before the business, and reports the row", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      deleteOnboardingDraft: vi.fn(async () => {
        order.push("draft");
      }) as never,
      deleteBusiness: vi.fn(async () => {
        order.push("business");
      }) as never
    });

    const result = await sweepAbandonedSignups(deps);

    expect(order).toEqual(["draft", "business"]);
    expect(result.deleted).toEqual([
      { id: PENDING_ID, name: "KIN Integrated Child Health", createdAt: LONG_AGO }
    ]);
    expect(result.scanned).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.cappedAtLimit).toBe(false);
    expect(result.dryRun).toBe(false);
  });

  it("deletes nothing in dry-run mode but still reports the row", async () => {
    const deps = makeDeps({ dryRun: true });
    const result = await sweepAbandonedSignups(deps);

    expect(result.deleted).toHaveLength(1);
    expect(result.dryRun).toBe(true);
    expect(deps.deleteBusiness).not.toHaveBeenCalled();
    expect(deps.deleteOnboardingDraft).not.toHaveBeenCalled();
  });

  // The pre-filter is what keeps a fleet of paying tenants from costing one
  // fact fan-out each.
  it("skips claimed rows without loading any facts", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn(async () => [
        biz({ id: "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d", owner_email: "newcoworkerteam@gmail.com" })
      ]) as never
    });

    const result = await sweepAbandonedSignups(deps);

    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual([
      { id: "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d", reason: "owner_claimed" }
    ]);
    expect(deps.loadFacts).not.toHaveBeenCalled();
  });

  it("reports the skip reason for a candidate the guards spare", async () => {
    const deps = makeDeps({
      loadFacts: vi.fn(async () => ({
        subscriptions: [],
        hasVpsRecord: true,
        hasWhiteGlove: false,
        hasCustomerActivity: false
      }))
    });

    const result = await sweepAbandonedSignups(deps);

    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual([{ id: PENDING_ID, reason: "vps_linked" }]);
  });

  it("caps deletions per run and flags that it stopped early", async () => {
    const rows = [1, 2, 3].map((n) =>
      biz({
        id: `0000000${n}-0000-4000-8000-00000000000${n}`,
        owner_email: `pending+0000000${n}-0000-4000-8000-00000000000${n}@onboarding.local`
      })
    );
    const deps = makeDeps({
      listBusinesses: vi.fn(async () => rows) as never,
      maxDeletes: 2
    });

    const result = await sweepAbandonedSignups(deps);

    expect(result.deleted).toHaveLength(2);
    expect(result.cappedAtLimit).toBe(true);
    expect(deps.deleteBusiness).toHaveBeenCalledTimes(2);
  });

  it("records an error and keeps going when one row fails", async () => {
    const rows = [
      biz({
        id: "00000001-0000-4000-8000-000000000001",
        owner_email: "pending+00000001-0000-4000-8000-000000000001@onboarding.local"
      }),
      biz()
    ];
    const deps = makeDeps({
      listBusinesses: vi.fn(async () => rows) as never,
      deleteBusiness: vi.fn(async (id: string) => {
        if (id === "00000001-0000-4000-8000-000000000001") throw new Error("delete failed");
      }) as never
    });

    const result = await sweepAbandonedSignups(deps);

    expect(result.errors).toEqual([
      { businessId: "00000001-0000-4000-8000-000000000001", message: "delete failed" }
    ]);
    expect(result.deleted).toEqual([
      { id: PENDING_ID, name: "KIN Integrated Child Health", createdAt: LONG_AGO }
    ]);
  });

  it("stringifies a non-Error thrown by a row", async () => {
    const deps = makeDeps({
      loadFacts: vi.fn(async () => {
        throw "kaboom";
      })
    });

    const result = await sweepAbandonedSignups(deps);

    expect(result.errors).toEqual([{ businessId: PENDING_ID, message: "kaboom" }]);
  });

  it("defaults the clock and the batch cap when they are not injected", async () => {
    const deps = makeDeps({ now: undefined, maxDeletes: undefined });
    const result = await sweepAbandonedSignups(deps);

    // LONG_AGO is measured against the frozen NOW, and real time is later
    // still, so the row stays deletable under the real clock.
    expect(result.deleted).toHaveLength(1);
    expect(ABANDONED_SIGNUP_MAX_DELETES_PER_RUN).toBeGreaterThan(0);
  });
});
