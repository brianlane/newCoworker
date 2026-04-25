import { describe, expect, it } from "vitest";
import {
  planLifecycleAction,
  GRACE_WINDOW_MS,
  type LifecycleContext
} from "@/lib/billing/lifecycle";
import type { SubscriptionRow } from "@/lib/db/subscriptions";
import type { CustomerProfileRow } from "@/lib/db/customer-profiles";

function makeSub(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub-1",
    business_id: "biz-1",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_stripe_1",
    tier: "starter",
    status: "active",
    billing_period: "monthly",
    renewal_at: null,
    commitment_months: 1,
    stripe_current_period_start: "2026-04-01T00:00:00.000Z",
    stripe_current_period_end: "2026-05-01T00:00:00.000Z",
    stripe_subscription_cached_at: "2026-04-10T00:00:00.000Z",
    customer_profile_id: "prof-1",
    canceled_at: null,
    cancel_reason: null,
    grace_ends_at: null,
    wiped_at: null,
    vps_stopped_at: null,
    hostinger_billing_subscription_id: "hbs-1",
    cancel_at_period_end: false,
    stripe_refund_id: null,
    refund_amount_cents: null,
    created_at: "2026-04-01T00:00:00.000Z",
    ...overrides
  };
}

function makeProfile(overrides: Partial<CustomerProfileRow> = {}): CustomerProfileRow {
  return {
    id: "prof-1",
    normalized_email: "owner@example.com",
    stripe_customer_id: "cus_1",
    last_signup_ip: null,
    lifetime_subscription_count: 1,
    refund_used_at: null,
    first_paid_at: "2026-04-01T00:00:00.000Z",
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
    ...overrides
  };
}

function makeCtx(overrides: Partial<LifecycleContext> = {}): LifecycleContext {
  return {
    subscription: makeSub(),
    ownerEmail: "owner@example.com",
    ownerAuthUserId: "user-abc",
    profile: makeProfile(),
    virtualMachineId: 42,
    vpsHost: "1.2.3.4",
    lastInvoiceAmountCents: 1599,
    now: new Date("2026-04-15T00:00:00.000Z"),
    ...overrides
  };
}

describe("planLifecycleAction: cancelWithRefund", () => {
  it("produces refund + cancel + snapshot + backup + stop + hostinger cancel + grace update", () => {
    const ctx = makeCtx();
    const res = planLifecycleAction({ type: "cancelWithRefund" }, ctx);
    if (!res.ok) throw new Error(`expected ok, got ${res.reason}`);
    const { plan } = res;

    expect(plan.stripeOps).toEqual([
      { type: "refund_latest_charge", stripeSubscriptionId: "sub_stripe_1", reason: "thirty_day_money_back" },
      { type: "cancel_subscription", stripeSubscriptionId: "sub_stripe_1", releaseSchedule: true }
    ]);
    expect(plan.sshOps).toEqual([
      { type: "backup_durable_data", businessId: "biz-1", vpsHost: "1.2.3.4" }
    ]);
    expect(plan.hostingerOps).toEqual([
      { type: "create_snapshot", virtualMachineId: 42 },
      { type: "stop_vm", virtualMachineId: 42 },
      { type: "cancel_billing_subscription", hostingerBillingSubscriptionId: "hbs-1" }
    ]);

    const subUpdate = plan.dbUpdates.find(
      (op) => op.type === "update_subscription" && op.subscriptionId === "sub-1"
    );
    if (!subUpdate || subUpdate.type !== "update_subscription") throw new Error("missing sub update");
    expect(subUpdate.patch.status).toBe("canceled");
    expect(subUpdate.patch.cancel_reason).toBe("user_refund");
    expect(subUpdate.patch.grace_ends_at).toBe(
      new Date(ctx.now!.getTime() + GRACE_WINDOW_MS).toISOString()
    );
    expect(subUpdate.patch.vps_stopped_at).toBe(ctx.now!.toISOString());

    expect(plan.dbUpdates.some((op) => op.type === "mark_refund_used")).toBe(true);
    expect(plan.dbUpdates.some((op) => op.type === "record_refund")).toBe(true);

    expect(plan.emailsToSend.map((e) => e.type)).toEqual([
      "send_cancel_confirmation",
      "send_refund_issued"
    ]);
  });

  it("still snapshots/stops/cancels Hostinger when IP lookup fails", () => {
    const res = planLifecycleAction(
      { type: "cancelWithRefund" },
      makeCtx({ vpsHost: null })
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.reason}`);
    expect(res.plan.sshOps).toEqual([]);
    expect(res.plan.hostingerOps).toEqual([
      { type: "create_snapshot", virtualMachineId: 42 },
      { type: "stop_vm", virtualMachineId: 42 },
      { type: "cancel_billing_subscription", hostingerBillingSubscriptionId: "hbs-1" }
    ]);
  });

  it("records refund bookkeeping against profile loaded from business when subscription is unlinked", () => {
    const res = planLifecycleAction(
      { type: "cancelWithRefund" },
      makeCtx({
        subscription: makeSub({ customer_profile_id: null }),
        profile: makeProfile({ id: "prof-from-business" })
      })
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.reason}`);

    const subUpdate = res.plan.dbUpdates.find((op) => op.type === "update_subscription");
    expect(subUpdate).toEqual(
      expect.objectContaining({
        patch: expect.objectContaining({ customer_profile_id: "prof-from-business" })
      })
    );
    expect(res.plan.dbUpdates).toContainEqual({
      type: "mark_refund_used",
      profileId: "prof-from-business",
      at: "2026-04-15T00:00:00.000Z"
    });
    expect(res.plan.dbUpdates).toContainEqual(
      expect.objectContaining({
        type: "record_refund",
        profileId: "prof-from-business",
        reason: "thirty_day_money_back"
      })
    );
  });

  it("rejects when subscription is not active", () => {
    const ctx = makeCtx({ subscription: makeSub({ status: "canceled" }) });
    const res = planLifecycleAction({ type: "cancelWithRefund" }, ctx);
    expect(res).toEqual({ ok: false, reason: "subscription_not_active" });
  });

  it("rejects when lifetime refund already used", () => {
    const ctx = makeCtx({
      profile: makeProfile({ refund_used_at: "2026-03-01T00:00:00.000Z" })
    });
    const res = planLifecycleAction({ type: "cancelWithRefund" }, ctx);
    expect(res).toEqual({ ok: false, reason: "refund_already_used" });
  });

  it("rejects when the 30-day window is closed", () => {
    const ctx = makeCtx({
      profile: makeProfile({ first_paid_at: "2025-01-01T00:00:00.000Z" })
    });
    const res = planLifecycleAction({ type: "cancelWithRefund" }, ctx);
    expect(res).toEqual({ ok: false, reason: "refund_window_closed" });
  });

  it("rejects when there is no Stripe subscription to cancel", () => {
    const ctx = makeCtx({
      subscription: makeSub({ stripe_subscription_id: null })
    });
    const res = planLifecycleAction({ type: "cancelWithRefund" }, ctx);
    expect(res).toEqual({ ok: false, reason: "no_stripe_subscription" });
  });

  it("rejects when profile is missing (pre-lifecycle sub)", () => {
    const ctx = makeCtx({ profile: null });
    const res = planLifecycleAction({ type: "cancelWithRefund" }, ctx);
    expect(res).toEqual({ ok: false, reason: "missing_context" });
  });

  it("omits snapshot + SSH ops when VM info is unknown", () => {
    const ctx = makeCtx({ virtualMachineId: null, vpsHost: null });
    const res = planLifecycleAction({ type: "cancelWithRefund" }, ctx);
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    expect(res.plan.hostingerOps).toEqual([
      { type: "cancel_billing_subscription", hostingerBillingSubscriptionId: "hbs-1" }
    ]);
    expect(res.plan.sshOps).toEqual([]);
  });
});

describe("planLifecycleAction: cancelAtPeriodEnd", () => {
  it("flips cancel_at_period_end and sends a confirmation email; no VM teardown", () => {
    const res = planLifecycleAction({ type: "cancelAtPeriodEnd" }, makeCtx());
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    expect(res.plan.stripeOps).toEqual([
      {
        type: "set_cancel_at_period_end",
        stripeSubscriptionId: "sub_stripe_1",
        cancelAtPeriodEnd: true
      }
    ]);
    expect(res.plan.hostingerOps).toEqual([]);
    expect(res.plan.sshOps).toEqual([]);
    const patch = (res.plan.dbUpdates[0] as { patch: Record<string, unknown> }).patch;
    expect(patch.cancel_at_period_end).toBe(true);
    expect(patch.cancel_reason).toBe("user_period_end");
    expect(res.plan.emailsToSend[0].type).toBe("send_cancel_confirmation");
  });

  it("rejects when sub is not active", () => {
    const ctx = makeCtx({ subscription: makeSub({ status: "pending" }) });
    expect(planLifecycleAction({ type: "cancelAtPeriodEnd" }, ctx)).toEqual({
      ok: false,
      reason: "subscription_not_active"
    });
  });

  it("rejects when Stripe subscription id is missing", () => {
    const ctx = makeCtx({ subscription: makeSub({ stripe_subscription_id: null }) });
    const res = planLifecycleAction({ type: "cancelAtPeriodEnd" }, ctx);
    expect(res).toEqual({ ok: false, reason: "no_stripe_subscription" });
  });
});

describe("planLifecycleAction: undoCancelAtPeriodEnd / reactivate(undoPeriodEnd)", () => {
  it("requires cancel_at_period_end to be true", () => {
    const ctx = makeCtx({ subscription: makeSub({ cancel_at_period_end: false }) });
    expect(planLifecycleAction({ type: "undoCancelAtPeriodEnd" }, ctx)).toEqual({
      ok: false,
      reason: "subscription_not_cancel_at_period_end"
    });
  });

  it("clears cancel_at_period_end + canceled_at + reason", () => {
    const ctx = makeCtx({
      subscription: makeSub({
        cancel_at_period_end: true,
        cancel_reason: "user_period_end",
        canceled_at: "2026-04-10T00:00:00.000Z"
      })
    });
    const res = planLifecycleAction({ type: "undoCancelAtPeriodEnd" }, ctx);
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    expect(res.plan.stripeOps).toEqual([
      {
        type: "set_cancel_at_period_end",
        stripeSubscriptionId: "sub_stripe_1",
        cancelAtPeriodEnd: false
      }
    ]);
    const patch = (res.plan.dbUpdates[0] as { patch: Record<string, unknown> }).patch;
    expect(patch.cancel_at_period_end).toBe(false);
    expect(patch.cancel_reason).toBeNull();
    expect(patch.canceled_at).toBeNull();
  });

  it("reactivate(undoPeriodEnd) behaves identically", () => {
    const ctx = makeCtx({
      subscription: makeSub({
        cancel_at_period_end: true,
        cancel_reason: "user_period_end"
      })
    });
    const res = planLifecycleAction({ type: "reactivate", mode: "undoPeriodEnd" }, ctx);
    expect(res.ok).toBe(true);
  });
});

describe("planLifecycleAction: autoCancelOnPaymentFailure", () => {
  it("cancels like user_refund minus the refund op + stamps reason=payment_failed", () => {
    const res = planLifecycleAction({ type: "autoCancelOnPaymentFailure" }, makeCtx());
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    expect(res.plan.stripeOps.some((op) => op.type === "refund_latest_charge")).toBe(false);
    expect(res.plan.stripeOps.some((op) => op.type === "cancel_subscription")).toBe(true);
    expect(res.plan.hostingerOps).toEqual([
      { type: "create_snapshot", virtualMachineId: 42 },
      { type: "stop_vm", virtualMachineId: 42 },
      { type: "cancel_billing_subscription", hostingerBillingSubscriptionId: "hbs-1" }
    ]);
    const subUpdate = res.plan.dbUpdates[0] as {
      type: "update_subscription";
      patch: Record<string, unknown>;
    };
    expect(subUpdate.patch.cancel_reason).toBe("payment_failed");
    expect(res.plan.dbUpdates.find((op) => op.type === "mark_refund_used")).toBeUndefined();
    expect(res.plan.emailsToSend.map((e) => e.type)).toEqual(["send_cancel_confirmation"]);
  });

  it("rejects on non-active subs", () => {
    const ctx = makeCtx({ subscription: makeSub({ status: "canceled" }) });
    expect(planLifecycleAction({ type: "autoCancelOnPaymentFailure" }, ctx)).toEqual({
      ok: false,
      reason: "subscription_not_active"
    });
  });
});

describe("planLifecycleAction: adminForceCancel", () => {
  it("collapses grace to zero + appends wipe ops + deletes auth user + snapshot", () => {
    const res = planLifecycleAction({ type: "adminForceCancel" }, makeCtx());
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    const subUpdate = res.plan.dbUpdates[0] as {
      type: "update_subscription";
      patch: Record<string, unknown>;
    };
    expect(subUpdate.patch.cancel_reason).toBe("admin_force");
    expect(subUpdate.patch.grace_ends_at).toBe(subUpdate.patch.canceled_at);
    expect(subUpdate.patch.wiped_at).toBe(subUpdate.patch.canceled_at);
    expect(res.plan.dbUpdates.some((op) => op.type === "mark_business_wiped")).toBe(true);
    expect(res.plan.dbUpdates.some((op) => op.type === "delete_auth_user")).toBe(true);
    expect(res.plan.hostingerOps).toContainEqual({ type: "delete_snapshot", virtualMachineId: 42 });
  });

  it("omits delete_auth_user when no ownerAuthUserId is known", () => {
    const res = planLifecycleAction(
      { type: "adminForceCancel" },
      makeCtx({ ownerAuthUserId: undefined })
    );
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    expect(res.plan.dbUpdates.some((op) => op.type === "delete_auth_user")).toBe(false);
  });
});

describe("planLifecycleAction: periodEndReached", () => {
  it("tears down resources without trying to cancel Stripe again", () => {
    const res = planLifecycleAction(
      { type: "periodEndReached" },
      makeCtx({ subscription: makeSub({ cancel_at_period_end: true, cancel_reason: "user_period_end" }) })
    );
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    expect(res.plan.stripeOps).toEqual([]);
    expect(res.plan.sshOps).toEqual([
      { type: "backup_durable_data", businessId: "biz-1", vpsHost: "1.2.3.4" }
    ]);
    expect(res.plan.hostingerOps).toEqual([
      { type: "create_snapshot", virtualMachineId: 42 },
      { type: "stop_vm", virtualMachineId: 42 },
      { type: "cancel_billing_subscription", hostingerBillingSubscriptionId: "hbs-1" }
    ]);
    const subUpdate = res.plan.dbUpdates.find(
      (op) => op.type === "update_subscription"
    ) as { type: "update_subscription"; patch: Record<string, unknown> };
    expect(subUpdate.patch.status).toBe("canceled");
    expect(subUpdate.patch.cancel_reason).toBe("user_period_end");
    expect(subUpdate.patch.cancel_at_period_end).toBe(false);
  });

  it("rejects period-end teardown for rows that are not still pending period-end cancel", () => {
    const res = planLifecycleAction(
      { type: "periodEndReached" },
      makeCtx({ subscription: makeSub({ status: "pending" }) })
    );
    expect(res).toEqual({ ok: false, reason: "subscription_not_active" });

    const alreadyTornDown = planLifecycleAction(
      { type: "periodEndReached" },
      makeCtx({
        subscription: makeSub({
          status: "canceled",
          cancel_reason: "user_period_end",
          cancel_at_period_end: false
        })
      })
    );
    expect(alreadyTornDown).toEqual({ ok: false, reason: "subscription_not_active" });

    const notScheduled = planLifecycleAction(
      { type: "periodEndReached" },
      makeCtx({ subscription: makeSub({ status: "active", cancel_at_period_end: false }) })
    );
    expect(notScheduled).toEqual({
      ok: false,
      reason: "subscription_not_cancel_at_period_end"
    });
  });
});

describe("planLifecycleAction: graceExpiredWipe", () => {
  it("runs only when sub is canceled, grace passed, not wiped", () => {
    const base = {
      status: "canceled" as const,
      grace_ends_at: "2026-04-01T00:00:00.000Z",
      wiped_at: null
    };
    const res = planLifecycleAction(
      { type: "graceExpiredWipe" },
      makeCtx({
        subscription: makeSub(base)
      })
    );
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    expect(res.plan.hostingerOps).toEqual([{ type: "delete_snapshot", virtualMachineId: 42 }]);
    const updatedSub = res.plan.dbUpdates.find(
      (op) => op.type === "update_subscription"
    ) as { type: "update_subscription"; patch: Record<string, unknown> };
    expect(updatedSub.patch.wiped_at).toBeTruthy();
    expect(res.plan.dbUpdates.some((op) => op.type === "mark_business_wiped")).toBe(true);
    expect(res.plan.dbUpdates.some((op) => op.type === "delete_auth_user")).toBe(true);
  });

  it("rejects when grace hasn't passed yet", () => {
    const res = planLifecycleAction(
      { type: "graceExpiredWipe" },
      makeCtx({
        subscription: makeSub({
          status: "canceled",
          grace_ends_at: "2026-05-01T00:00:00.000Z",
          wiped_at: null
        })
      })
    );
    expect(res).toEqual({ ok: false, reason: "subscription_not_in_grace" });
  });

  it("rejects when already wiped", () => {
    const res = planLifecycleAction(
      { type: "graceExpiredWipe" },
      makeCtx({
        subscription: makeSub({
          status: "canceled",
          grace_ends_at: "2026-04-01T00:00:00.000Z",
          wiped_at: "2026-04-02T00:00:00.000Z"
        })
      })
    );
    expect(res).toEqual({ ok: false, reason: "subscription_not_in_grace" });
  });
});

describe("planLifecycleAction: undo/reactivate edge cases", () => {
  it("rejects undo when subscription is not active", () => {
    const res = planLifecycleAction(
      { type: "undoCancelAtPeriodEnd" },
      makeCtx({ subscription: makeSub({ status: "canceled", cancel_at_period_end: true }) })
    );
    expect(res).toEqual({ ok: false, reason: "subscription_not_active" });
  });

  it("rejects undo when the Stripe subscription id is missing", () => {
    const res = planLifecycleAction(
      { type: "undoCancelAtPeriodEnd" },
      makeCtx({
        subscription: makeSub({
          cancel_at_period_end: true,
          stripe_subscription_id: null
        })
      })
    );
    expect(res).toEqual({ ok: false, reason: "no_stripe_subscription" });
  });
});
