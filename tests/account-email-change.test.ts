import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  moveBusinessesToNewOwnerEmail,
  reconcilePendingEmailChange,
  syncStripeCustomerEmails
} from "@/lib/account/email-change";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/stripe/client", () => ({
  getStripe: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe/client";
import { logger } from "@/lib/logger";

type PendingRow = { user_id: string; old_email: string };

function makeDb(opts: {
  pending?: PendingRow | null;
  selectError?: { message: string } | null;
  updateError?: { message: string } | null;
  updatedRows?: Array<{ id: string }> | null;
  alreadySynced?: { id: string } | null;
  /** Rows for the awaited businesses.select("id").eq("owner_email", ...) (stripe sync). */
  ownerBizRows?: Array<{ id: string }> | null;
  ownerBizError?: { message: string } | null;
  /** Rows for subscriptions.select("stripe_customer_id").in(...).not(...). */
  stripeSubs?: Array<{ stripe_customer_id: string | null }> | null;
  stripeSubsError?: { message: string } | null;
}) {
  // pending_email_changes.select().eq().maybeSingle()
  const pendingMaybeSingle = vi
    .fn()
    .mockResolvedValue({ data: opts.pending ?? null, error: opts.selectError ?? null });
  const pendingSelectEq = vi.fn().mockReturnValue({ maybeSingle: pendingMaybeSingle });
  const pendingSelect = vi.fn().mockReturnValue({ eq: pendingSelectEq });

  // pending_email_changes.delete().eq()
  const deleteEq = vi.fn().mockResolvedValue({ error: null });
  const del = vi.fn().mockReturnValue({ eq: deleteEq });

  // businesses.update().eq().select()
  // `=== undefined` (not ??) so a test can deliver an explicit null payload:
  // PostgREST returns data:null on some shapes, and the callers' `?? []`
  // fallbacks only get exercised if the mock can actually produce it.
  const updateSelect = vi.fn().mockResolvedValue({
    data: opts.updatedRows === undefined ? [] : opts.updatedRows,
    error: opts.updateError ?? null
  });
  const updateEq = vi.fn().mockReturnValue({ select: updateSelect });
  // businesses.update().ilike().select(), the immediate-effect admin path.
  const updateIlike = vi.fn().mockReturnValue({ select: updateSelect });
  const update = vi.fn().mockReturnValue({ eq: updateEq, ilike: updateIlike });

  // businesses.select().eq() is used two ways:
  //   - awaited directly (stripe-sync owner lookup) → must be thenable
  //   - .limit().maybeSingle() (already-synced probe)
  // Mirror the real PostgREST builder (thenable at every stage) by returning
  // an object that is BOTH awaitable and has .limit.
  const alreadyMaybeSingle = vi.fn().mockResolvedValue({ data: opts.alreadySynced ?? null, error: null });
  const alreadyLimit = vi.fn().mockReturnValue({ maybeSingle: alreadyMaybeSingle });
  const alreadyEq = vi.fn().mockReturnValue({
    limit: alreadyLimit,
    then(resolve: (v: unknown) => void) {
      // `=== undefined` (not ??) so a test can deliver an explicit null payload.
      resolve({
        data: opts.ownerBizRows === undefined ? [] : opts.ownerBizRows,
        error: opts.ownerBizError ?? null
      });
    }
  });
  const bizSelect = vi.fn().mockReturnValue({ eq: alreadyEq });

  // subscriptions.select().in().not()
  const subsNot = vi.fn().mockResolvedValue({
    data: opts.stripeSubs === undefined ? [] : opts.stripeSubs,
    error: opts.stripeSubsError ?? null
  });
  const subsIn = vi.fn().mockReturnValue({ not: subsNot });
  const subsSelect = vi.fn().mockReturnValue({ in: subsIn });

  const from = vi.fn((table: string) => {
    if (table === "pending_email_changes") return { select: pendingSelect, delete: del };
    if (table === "subscriptions") return { select: subsSelect };
    return { update, select: bizSelect };
  });

  return { db: { from }, from, update, updateEq, updateIlike, bizSelect, deleteEq, subsIn };
}

function makeStripe(opts: { updateError?: unknown } = {}) {
  const update = opts.updateError
    ? vi.fn().mockRejectedValue(opts.updateError)
    : vi.fn().mockResolvedValue({});
  return { stripe: { customers: { update } }, update };
}

const PENDING: PendingRow = {
  user_id: "user-1",
  old_email: "old@test.com"
};

describe("reconcilePendingEmailChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns early without a db call when userId is missing", async () => {
    await reconcilePendingEmailChange("", "new@test.com");
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("returns early without a db call when email is missing", async () => {
    await reconcilePendingEmailChange("user-1", null);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("does nothing when there is no pending row", async () => {
    const { db, update } = makeDb({ pending: null });
    await reconcilePendingEmailChange("user-1", "new@test.com", db as never);
    expect(update).not.toHaveBeenCalled();
  });

  it("does nothing when the pending select errors", async () => {
    const { db, update } = makeDb({ pending: PENDING, selectError: { message: "boom" } });
    await reconcilePendingEmailChange("user-1", "new@test.com", db as never);
    expect(update).not.toHaveBeenCalled();
  });

  it("does not update or delete when the live email still equals old_email (unconfirmed)", async () => {
    const { db, update, deleteEq } = makeDb({ pending: PENDING });
    await reconcilePendingEmailChange("user-1", "old@test.com", db as never);
    expect(update).not.toHaveBeenCalled();
    expect(deleteEq).not.toHaveBeenCalled();
  });

  it("syncs to whatever confirmed email differs from old_email, even if not the latest new_email", async () => {
    // User superseded A->B with A->C, then confirmed the older B link; the live
    // email (B) is neither old_email (A) nor the latest recorded target, but the
    // business must still follow it.
    const { db, update, updateEq, deleteEq } = makeDb({
      pending: PENDING,
      updatedRows: [{ id: "biz-1" }]
    });
    await reconcilePendingEmailChange("user-1", "superseded@test.com", db as never);
    expect(update).toHaveBeenCalledWith({ owner_email: "superseded@test.com" });
    expect(updateEq).toHaveBeenCalledWith("owner_email", "old@test.com");
    expect(deleteEq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("keeps the pending row when the owner_email update fails", async () => {
    const { db, update, deleteEq } = makeDb({ pending: PENDING, updateError: { message: "db down" } });
    await reconcilePendingEmailChange("user-1", "NEW@test.com", db as never);
    expect(update).toHaveBeenCalledWith({ owner_email: "NEW@test.com" });
    expect(deleteEq).not.toHaveBeenCalled();
  });

  it("updates every business under the old email and deletes the pending row on success", async () => {
    const { db, update, updateEq, deleteEq } = makeDb({
      pending: PENDING,
      updatedRows: [{ id: "biz-1" }, { id: "biz-2" }]
    });
    await reconcilePendingEmailChange("user-1", "new@test.com", db as never);
    expect(update).toHaveBeenCalledWith({ owner_email: "new@test.com" });
    expect(updateEq).toHaveBeenCalledWith("owner_email", "old@test.com");
    expect(deleteEq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("keeps the pending row when zero businesses matched and none are on the new email yet", async () => {
    const { db, deleteEq, bizSelect } = makeDb({ pending: PENDING, updatedRows: [], alreadySynced: null });
    await reconcilePendingEmailChange("user-1", "new@test.com", db as never);
    expect(bizSelect).toHaveBeenCalled();
    expect(deleteEq).not.toHaveBeenCalled();
  });

  it("clears the pending row when a prior run already synced businesses to the new email", async () => {
    const { db, deleteEq } = makeDb({ pending: PENDING, updatedRows: [], alreadySynced: { id: "biz-1" } });
    await reconcilePendingEmailChange("user-1", "new@test.com", db as never);
    expect(deleteEq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("falls back to the service client when none is provided", async () => {
    const { db, update, deleteEq } = makeDb({ pending: PENDING, updatedRows: [{ id: "biz-1" }] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await reconcilePendingEmailChange("user-1", "new@test.com");
    expect(createSupabaseServiceClient).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ owner_email: "new@test.com" });
    expect(deleteEq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("updates the Stripe customer email after a successful sync", async () => {
    const { db, deleteEq } = makeDb({
      pending: PENDING,
      updatedRows: [{ id: "biz-1" }],
      ownerBizRows: [{ id: "biz-1" }],
      stripeSubs: [{ stripe_customer_id: "cus_123" }]
    });
    const { stripe, update: stripeUpdate } = makeStripe();
    await reconcilePendingEmailChange("user-1", "new@test.com", db as never, stripe as never);
    expect(deleteEq).toHaveBeenCalledWith("user_id", "user-1");
    expect(stripeUpdate).toHaveBeenCalledWith("cus_123", { email: "new@test.com" });
  });
});

describe("syncStripeCustomerEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("warns and returns when the business lookup errors", async () => {
    const { db } = makeDb({ ownerBizError: { message: "biz boom" } });
    const { stripe, update } = makeStripe();
    await syncStripeCustomerEmails("new@test.com", db as never, stripe as never);
    expect(update).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "email-change: stripe sync business lookup failed",
      { error: "biz boom" }
    );
  });

  it("returns without touching subscriptions when the owner has no businesses", async () => {
    const { db, subsIn } = makeDb({ ownerBizRows: [] });
    const { stripe, update } = makeStripe();
    await syncStripeCustomerEmails("new@test.com", db as never, stripe as never);
    expect(subsIn).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("treats a null businesses payload as no businesses", async () => {
    const { db, subsIn } = makeDb({ ownerBizRows: null });
    const { stripe } = makeStripe();
    await syncStripeCustomerEmails("new@test.com", db as never, stripe as never);
    expect(subsIn).not.toHaveBeenCalled();
  });

  it("warns and returns when the subscriptions lookup errors", async () => {
    const { db } = makeDb({
      ownerBizRows: [{ id: "biz-1" }],
      stripeSubsError: { message: "subs boom" }
    });
    const { stripe, update } = makeStripe();
    await syncStripeCustomerEmails("new@test.com", db as never, stripe as never);
    expect(update).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "email-change: stripe sync subscription lookup failed",
      { error: "subs boom" }
    );
  });

  it("returns when no subscription has a Stripe customer", async () => {
    const { db } = makeDb({
      ownerBizRows: [{ id: "biz-1" }],
      stripeSubs: [{ stripe_customer_id: null }]
    });
    const { stripe, update } = makeStripe();
    await syncStripeCustomerEmails("new@test.com", db as never, stripe as never);
    expect(update).not.toHaveBeenCalled();
  });

  it("treats a null subscriptions payload as no customers", async () => {
    const { db } = makeDb({ ownerBizRows: [{ id: "biz-1" }], stripeSubs: null });
    const { stripe, update } = makeStripe();
    await syncStripeCustomerEmails("new@test.com", db as never, stripe as never);
    expect(update).not.toHaveBeenCalled();
  });

  it("updates each distinct Stripe customer once", async () => {
    const { db } = makeDb({
      ownerBizRows: [{ id: "biz-1" }, { id: "biz-2" }],
      stripeSubs: [
        { stripe_customer_id: "cus_a" },
        { stripe_customer_id: "cus_a" },
        { stripe_customer_id: "cus_b" }
      ]
    });
    const { stripe, update } = makeStripe();
    await syncStripeCustomerEmails("new@test.com", db as never, stripe as never);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith("cus_a", { email: "new@test.com" });
    expect(update).toHaveBeenCalledWith("cus_b", { email: "new@test.com" });
  });

  it("falls back to getStripe() and logs an Error when the client is unavailable", async () => {
    const { db } = makeDb({
      ownerBizRows: [{ id: "biz-1" }],
      stripeSubs: [{ stripe_customer_id: "cus_a" }]
    });
    vi.mocked(getStripe).mockImplementationOnce(() => {
      throw new Error("STRIPE_SECRET_KEY is not configured");
    });
    await syncStripeCustomerEmails("new@test.com", db as never);
    expect(getStripe).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("email-change: stripe customer email sync failed", {
      error: "STRIPE_SECRET_KEY is not configured"
    });
  });

  it("logs a stringified non-Error when a Stripe update rejects", async () => {
    const { db } = makeDb({
      ownerBizRows: [{ id: "biz-1" }],
      stripeSubs: [{ stripe_customer_id: "cus_a" }]
    });
    const { stripe } = makeStripe({ updateError: "stripe down" });
    await syncStripeCustomerEmails("new@test.com", db as never, stripe as never);
    expect(logger.warn).toHaveBeenCalledWith("email-change: stripe customer email sync failed", {
      error: "stripe down"
    });
  });
});

/**
 * The immediate-effect variant, for an admin in view-as renaming a tenant's
 * login. There is no confirmation link to wait on (the admin cannot click the
 * tenant's), so the auth email and businesses.owner_email move in one request.
 */
describe("moveBusinessesToNewOwnerEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("moves every business off the old email and reports the count", async () => {
    // Count matters to the caller's response: an owner can hold several
    // businesses under one owner_email and all of them must follow the login.
    const { db, updateIlike, update } = makeDb({
      updatedRows: [{ id: "biz-1" }, { id: "biz-2" }],
      ownerBizRows: [{ id: "biz-1" }],
      stripeSubs: [{ stripe_customer_id: "cus_a" }]
    });
    const { stripe, update: stripeUpdate } = makeStripe();
    const moved = await moveBusinessesToNewOwnerEmail(
      "old@test.com",
      "new@test.com",
      db as never,
      stripe as never
    );
    expect(moved).toBe(2);
    expect(update).toHaveBeenCalledWith({ owner_email: "new@test.com" });
    expect(updateIlike).toHaveBeenCalledWith("owner_email", "old@test.com");
    // Follow-through: receipts and the billing portal stop pointing at the
    // abandoned address.
    expect(stripeUpdate).toHaveBeenCalledWith("cus_a", { email: "new@test.com" });
  });

  it("matches case-insensitively and escapes LIKE metacharacters", async () => {
    // owner_email keeps signup casing while auth emails are lowercased, hence
    // ilike. An email like a_b@x.com must not wildcard-match a1b@x.com.
    const { db, updateIlike } = makeDb({ updatedRows: [{ id: "biz-1" }] });
    await moveBusinessesToNewOwnerEmail("a_b%c@test.com", "new@test.com", db as never);
    expect(updateIlike).toHaveBeenCalledWith("owner_email", "a\\_b\\%c@test.com");
  });

  it("returns 0 when the owner had no business rows", async () => {
    // Legitimate: a login can exist with no business yet.
    const { db } = makeDb({ updatedRows: [] });
    expect(
      await moveBusinessesToNewOwnerEmail("old@test.com", "new@test.com", db as never)
    ).toBe(0);
  });

  it("treats a null payload as zero rows moved", async () => {
    const { db } = makeDb({ updatedRows: null });
    expect(
      await moveBusinessesToNewOwnerEmail("old@test.com", "new@test.com", db as never)
    ).toBe(0);
  });

  it("throws when the update fails", async () => {
    // Deliberately NOT swallowed: the caller has already moved the auth email
    // by this point, so a failure here means the login and its businesses are
    // out of step and the operator has to know.
    const { db } = makeDb({ updateError: { message: "constraint violated" } });
    await expect(
      moveBusinessesToNewOwnerEmail("old@test.com", "new@test.com", db as never)
    ).rejects.toThrow("moveBusinessesToNewOwnerEmail: constraint violated");
  });

  it("resolves its own service client when none is passed", async () => {
    const { db } = makeDb({ updatedRows: [{ id: "biz-1" }] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await moveBusinessesToNewOwnerEmail("old@test.com", "new@test.com")).toBe(1);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});
