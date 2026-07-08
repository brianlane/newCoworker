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
    contract_auto_renew: false,
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
    email_verified_at: null,
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
  it("produces refund + cancel + snapshot + backup + stop + auto-renew disable + grace update", () => {
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
      { type: "disable_billing_auto_renewal", hostingerBillingSubscriptionId: "hbs-1" }
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
      "send_refund_issued",
      "send_ops_vps_deletion_request"
    ]);
  });

  it("asks ops for the manual hPanel deletion with owner + refund context", () => {
    const res = planLifecycleAction(
      { type: "cancelWithRefund" },
      makeCtx({ ownerName: "Jane Doe" })
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.reason}`);
    const opsOp = res.plan.emailsToSend.find((e) => e.type === "send_ops_vps_deletion_request");
    expect(opsOp).toEqual({
      type: "send_ops_vps_deletion_request",
      businessId: "biz-1",
      virtualMachineId: 42,
      hostingerBillingSubscriptionId: "hbs-1",
      ownerName: "Jane Doe",
      ownerEmail: "owner@example.com",
      tier: "starter",
      signupDate: "2026-04-01T00:00:00.000Z",
      // This plan's own refund op may still be skipped at execution time
      // (zero-amount invoice), so the planner only reports refunds already
      // recorded on the row; the executor ORs in the live outcome.
      refundIssued: false,
      cancelReason: "user_refund",
      vmState: "VM stopped, auto-renew disabled"
    });
  });

  it("reports refundIssued in the ops email when the row already carries a Stripe refund", () => {
    const res = planLifecycleAction(
      { type: "cancelWithRefund" },
      makeCtx({ subscription: makeSub({ stripe_refund_id: "re_prior" }) })
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.reason}`);
    const opsOp = res.plan.emailsToSend.find((e) => e.type === "send_ops_vps_deletion_request");
    expect(opsOp).toEqual(expect.objectContaining({ refundIssued: true }));
  });

  it("skips the ops deletion email when neither VM nor billing id is known", () => {
    const res = planLifecycleAction(
      { type: "cancelWithRefund" },
      makeCtx({
        virtualMachineId: null,
        vpsHost: null,
        subscription: makeSub({ hostinger_billing_subscription_id: null })
      })
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.reason}`);
    expect(
      res.plan.emailsToSend.some((e) => e.type === "send_ops_vps_deletion_request")
    ).toBe(false);
  });

  it("passes the business timezone to the cancel confirmation email op", () => {
    const res = planLifecycleAction(
      { type: "cancelWithRefund" },
      makeCtx({ businessTimezone: "America/Phoenix" })
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.reason}`);
    const cancelOp = res.plan.emailsToSend.find((e) => e.type === "send_cancel_confirmation");
    expect(cancelOp).toEqual(expect.objectContaining({ timeZone: "America/Phoenix" }));
  });

  it("still snapshots/stops/disables Hostinger renewal when IP lookup fails", () => {
    const res = planLifecycleAction(
      { type: "cancelWithRefund" },
      makeCtx({ vpsHost: null })
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.reason}`);
    expect(res.plan.sshOps).toEqual([]);
    expect(res.plan.hostingerOps).toEqual([
      { type: "create_snapshot", virtualMachineId: 42 },
      { type: "stop_vm", virtualMachineId: 42 },
      { type: "disable_billing_auto_renewal", hostingerBillingSubscriptionId: "hbs-1" }
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

  it("defaults refund amounts to null/zero when invoice amount is unknown", () => {
    const res = planLifecycleAction(
      { type: "cancelWithRefund" },
      makeCtx({ lastInvoiceAmountCents: undefined })
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.reason}`);

    expect(res.plan.dbUpdates).toContainEqual(
      expect.objectContaining({
        type: "record_refund",
        amountCents: null
      })
    );
    expect(res.plan.emailsToSend).toContainEqual(
      expect.objectContaining({
        type: "send_refund_issued",
        amountCents: 0
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
      { type: "disable_billing_auto_renewal", hostingerBillingSubscriptionId: "hbs-1" }
    ]);
    expect(res.plan.sshOps).toEqual([]);
    // Ops email still goes out (billing sub still needs the manual delete)
    // and reports the missing VM.
    const opsOp = res.plan.emailsToSend.find((e) => e.type === "send_ops_vps_deletion_request");
    expect(opsOp).toEqual(
      expect.objectContaining({
        virtualMachineId: null,
        vmState: "no VM recorded, auto-renew disabled"
      })
    );
  });

  it("omits the auto-renew disable when no billing subscription id is known", () => {
    const ctx = makeCtx({
      subscription: makeSub({ hostinger_billing_subscription_id: null })
    });
    const res = planLifecycleAction({ type: "cancelWithRefund" }, ctx);
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    expect(res.plan.hostingerOps).toEqual([
      { type: "create_snapshot", virtualMachineId: 42 },
      { type: "stop_vm", virtualMachineId: 42 }
    ]);
    // Ops email still requested for the orphaned VM.
    const opsOp = res.plan.emailsToSend.find((e) => e.type === "send_ops_vps_deletion_request");
    expect(opsOp).toEqual(
      expect.objectContaining({
        hostingerBillingSubscriptionId: null,
        vmState: "VM stopped, no Hostinger billing id"
      })
    );
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

  it("passes the business timezone to the confirmation email op", () => {
    const res = planLifecycleAction(
      { type: "cancelAtPeriodEnd" },
      makeCtx({ businessTimezone: "America/Phoenix" })
    );
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    expect(res.plan.emailsToSend[0]).toEqual(
      expect.objectContaining({ type: "send_cancel_confirmation", timeZone: "America/Phoenix" })
    );
  });

  it("uses the request time as effective date when Stripe period end is missing", () => {
    const res = planLifecycleAction(
      { type: "cancelAtPeriodEnd" },
      makeCtx({ subscription: makeSub({ stripe_current_period_end: null }) })
    );
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    expect(res.plan.emailsToSend[0]).toEqual(
      expect.objectContaining({ effectiveAt: "2026-04-15T00:00:00.000Z" })
    );
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
      { type: "disable_billing_auto_renewal", hostingerBillingSubscriptionId: "hbs-1" }
    ]);
    const subUpdate = res.plan.dbUpdates[0] as {
      type: "update_subscription";
      patch: Record<string, unknown>;
    };
    expect(subUpdate.patch.cancel_reason).toBe("payment_failed");
    expect(res.plan.dbUpdates.find((op) => op.type === "mark_refund_used")).toBeUndefined();
    expect(res.plan.emailsToSend.map((e) => e.type)).toEqual([
      "send_cancel_confirmation",
      "send_ops_vps_deletion_request"
    ]);
    expect(
      res.plan.emailsToSend.find((e) => e.type === "send_ops_vps_deletion_request")
    ).toEqual(expect.objectContaining({ refundIssued: false, cancelReason: "payment_failed" }));
  });

  it("rejects on non-active subs", () => {
    const ctx = makeCtx({ subscription: makeSub({ status: "canceled" }) });
    expect(planLifecycleAction({ type: "autoCancelOnPaymentFailure" }, ctx)).toEqual({
      ok: false,
      reason: "subscription_not_active"
    });
  });

  it("allows non-refund cancellation when no customer profile is known", () => {
    const res = planLifecycleAction(
      { type: "autoCancelOnPaymentFailure" },
      makeCtx({
        subscription: makeSub({ customer_profile_id: null }),
        profile: null
      })
    );
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    expect(res.plan.dbUpdates).toContainEqual(
      expect.objectContaining({
        type: "update_subscription",
        patch: expect.objectContaining({ customer_profile_id: null })
      })
    );
  });
});

describe("planLifecycleAction: adminForceCancel", () => {
  it("collapses grace to zero + appends wipe ops + deletes auth user, retains backup + snapshot", () => {
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
    // Admin force-cancel must NOT wastefully delete the backup + snapshot it
    // just took — those are retained for audit/recovery.
    expect(res.plan.dbUpdates.some((op) => op.type === "delete_backup_artifact")).toBe(false);
    expect(res.plan.hostingerOps).toContainEqual({ type: "create_snapshot", virtualMachineId: 42 });
    expect(res.plan.hostingerOps).not.toContainEqual(
      expect.objectContaining({ type: "delete_snapshot" })
    );
    expect(res.plan.sshOps).toContainEqual({
      type: "backup_durable_data",
      businessId: "biz-1",
      vpsHost: "1.2.3.4"
    });
  });

  it("omits delete_auth_user when no ownerAuthUserId is known", () => {
    const res = planLifecycleAction(
      { type: "adminForceCancel" },
      makeCtx({ ownerAuthUserId: undefined })
    );
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    expect(res.plan.dbUpdates.some((op) => op.type === "delete_auth_user")).toBe(false);
  });

  it("omits snapshot creation when VM info is unknown but never emits delete_snapshot", () => {
    const res = planLifecycleAction(
      { type: "adminForceCancel" },
      makeCtx({ virtualMachineId: null, vpsHost: null })
    );
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    expect(res.plan.hostingerOps).not.toContainEqual(
      expect.objectContaining({ type: "delete_snapshot" })
    );
    expect(res.plan.hostingerOps).not.toContainEqual(
      expect.objectContaining({ type: "create_snapshot" })
    );
  });

  it("preserves the prior vps_stopped_at on idempotent retry when the VM is already gone", () => {
    const alreadyStopped = makeSub({
      vps_stopped_at: "2026-04-01T00:00:00.000Z"
    });
    const res = planLifecycleAction(
      { type: "adminForceCancel" },
      makeCtx({ subscription: alreadyStopped, virtualMachineId: null, vpsHost: null })
    );
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    const subUpdate = res.plan.dbUpdates.find(
      (op) => op.type === "update_subscription"
    ) as { type: "update_subscription"; patch: Record<string, unknown> };
    expect(subUpdate.patch.vps_stopped_at).toBe("2026-04-01T00:00:00.000Z");
  });

  it("releases the DID (terminal path) when the context carries one; omits when absent", () => {
    const withDid = planLifecycleAction(
      { type: "adminForceCancel" },
      makeCtx({ didE164: "+16025550100" })
    );
    if (!withDid.ok) throw new Error(`unexpected reject ${withDid.reason}`);
    expect(withDid.plan.telnyxOps).toEqual([
      { type: "release_did", e164: "+16025550100", businessId: "biz-1" }
    ]);

    const withoutDid = planLifecycleAction({ type: "adminForceCancel" }, makeCtx());
    if (!withoutDid.ok) throw new Error(`unexpected reject ${withoutDid.reason}`);
    expect(withoutDid.plan.telnyxOps).toEqual([]);
  });
});

describe("DID retention through non-terminal cancels", () => {
  it("never releases the DID on grace-window cancels — a reactivating tenant keeps their number", () => {
    // Every non-terminal action must leave the number rented so the tenant's
    // business line survives the 30-day grace window.
    const didCtx = { didE164: "+16025550100" };
    const refund = planLifecycleAction({ type: "cancelWithRefund" }, makeCtx(didCtx));
    if (!refund.ok) throw new Error(`unexpected reject ${refund.reason}`);
    expect(refund.plan.telnyxOps).toEqual([]);

    const periodEnd = planLifecycleAction({ type: "cancelAtPeriodEnd" }, makeCtx(didCtx));
    if (!periodEnd.ok) throw new Error(`unexpected reject ${periodEnd.reason}`);
    expect(periodEnd.plan.telnyxOps).toEqual([]);

    const paymentFailed = planLifecycleAction(
      { type: "autoCancelOnPaymentFailure" },
      makeCtx(didCtx)
    );
    if (!paymentFailed.ok) throw new Error(`unexpected reject ${paymentFailed.reason}`);
    expect(paymentFailed.plan.telnyxOps).toEqual([]);

    const undo = planLifecycleAction(
      { type: "undoCancelAtPeriodEnd" },
      makeCtx({ ...didCtx, subscription: makeSub({ cancel_at_period_end: true }) })
    );
    if (!undo.ok) throw new Error(`unexpected reject ${undo.reason}`);
    expect(undo.plan.telnyxOps).toEqual([]);

    const reached = planLifecycleAction(
      { type: "periodEndReached" },
      makeCtx({
        ...didCtx,
        subscription: makeSub({ cancel_at_period_end: true, cancel_reason: "user_period_end" })
      })
    );
    if (!reached.ok) throw new Error(`unexpected reject ${reached.reason}`);
    expect(reached.plan.telnyxOps).toEqual([]);
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
      { type: "disable_billing_auto_renewal", hostingerBillingSubscriptionId: "hbs-1" }
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
      wiped_at: null,
      cancel_reason: "payment_failed" as const
    };
    const res = planLifecycleAction(
      { type: "graceExpiredWipe" },
      makeCtx({
        subscription: makeSub(base)
      })
    );
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    // Backstop teardown: for cancel paths that bypassed
    // cancel-with-refund / autoCancel (e.g. manual Stripe Dashboard
    // cancel, autoCancel fire-and-forget dispatch failing), the VM is
    // still running and Hostinger is still billing at grace-end. The
    // sweep must stop the VM and disable Hostinger auto-renewal here;
    // otherwise the tenant's VPS keeps charging indefinitely.
    expect(res.plan.hostingerOps).toEqual([
      { type: "stop_vm", virtualMachineId: 42 },
      { type: "disable_billing_auto_renewal", hostingerBillingSubscriptionId: "hbs-1" },
      { type: "delete_snapshot", virtualMachineId: 42 }
    ]);
    const updatedSub = res.plan.dbUpdates.find(
      (op) => op.type === "update_subscription"
    ) as { type: "update_subscription"; patch: Record<string, unknown> };
    expect(updatedSub.patch.wiped_at).toBeTruthy();
    expect(res.plan.dbUpdates.some((op) => op.type === "mark_business_wiped")).toBe(true);
    expect(res.plan.dbUpdates.some((op) => op.type === "delete_auth_user")).toBe(true);
    // Wipe re-requests the manual hPanel deletion.
    const opsOp = res.plan.emailsToSend.find((e) => e.type === "send_ops_vps_deletion_request");
    expect(opsOp).toEqual(
      expect.objectContaining({
        virtualMachineId: 42,
        hostingerBillingSubscriptionId: "hbs-1",
        refundIssued: false,
        cancelReason: "payment_failed",
        vmState: "grace expired — VM stopped, snapshot deleted, auto-renew disabled"
      })
    );
  });

  it("reports refundIssued when an earlier cancel-with-refund stamped stripe_refund_id", () => {
    const res = planLifecycleAction(
      { type: "graceExpiredWipe" },
      makeCtx({
        subscription: makeSub({
          status: "canceled",
          grace_ends_at: "2026-04-01T00:00:00.000Z",
          wiped_at: null,
          cancel_reason: "user_refund",
          stripe_refund_id: "re_123"
        })
      })
    );
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    const opsOp = res.plan.emailsToSend.find((e) => e.type === "send_ops_vps_deletion_request");
    expect(opsOp).toEqual(
      expect.objectContaining({ refundIssued: true, cancelReason: "user_refund" })
    );
  });

  it("releases the DID at wipe time (grace over, nobody can reactivate); omits when absent", () => {
    const wipeSub = makeSub({
      status: "canceled",
      grace_ends_at: "2026-04-01T00:00:00.000Z",
      wiped_at: null,
      cancel_reason: "payment_failed"
    });
    const withDid = planLifecycleAction(
      { type: "graceExpiredWipe" },
      makeCtx({ subscription: wipeSub, didE164: "+16025550100" })
    );
    if (!withDid.ok) throw new Error(`unexpected reject ${withDid.reason}`);
    expect(withDid.plan.telnyxOps).toEqual([
      { type: "release_did", e164: "+16025550100", businessId: "biz-1" }
    ]);

    const withoutDid = planLifecycleAction(
      { type: "graceExpiredWipe" },
      makeCtx({ subscription: wipeSub })
    );
    if (!withoutDid.ok) throw new Error(`unexpected reject ${withoutDid.reason}`);
    expect(withoutDid.plan.telnyxOps).toEqual([]);
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

  it("wipes backup without VM or auth delete when optional context is missing", () => {
    const res = planLifecycleAction(
      { type: "graceExpiredWipe" },
      makeCtx({
        virtualMachineId: null,
        ownerAuthUserId: undefined,
        subscription: makeSub({
          status: "canceled",
          grace_ends_at: "2026-04-01T00:00:00.000Z",
          wiped_at: null,
          // No Hostinger billing to cancel either — we expect a
          // completely empty hostingerOps list.
          hostinger_billing_subscription_id: null
        })
      })
    );
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    expect(res.plan.hostingerOps).toEqual([]);
    expect(res.plan.dbUpdates).toContainEqual({ type: "delete_backup_artifact", businessId: "biz-1" });
    expect(res.plan.dbUpdates.some((op) => op.type === "delete_auth_user")).toBe(false);
  });

  it("emits stop_vm + disable_billing_auto_renewal backstop when cancel path skipped VPS teardown", () => {
    // Regression test for the screenshot-reported bug:
    // `customer.subscription.deleted` fallback stamps `grace_ends_at` but
    // does not stop the VM or cancel Hostinger billing. If the normal
    // cancel path (cancelWithRefund / autoCancelOnPaymentFailure) was
    // bypassed (manual Stripe Dashboard cancel, autoCancel dispatch
    // failing), the VPS keeps running and Hostinger keeps billing
    // indefinitely. The grace-expired sweep must be the backstop.
    const res = planLifecycleAction(
      { type: "graceExpiredWipe" },
      makeCtx({
        subscription: makeSub({
          status: "canceled",
          grace_ends_at: "2026-04-01T00:00:00.000Z",
          wiped_at: null,
          hostinger_billing_subscription_id: "hbs-backstop",
          // vps_stopped_at is intentionally null: the cancel path
          // skipped teardown entirely, so the VM is still running.
          vps_stopped_at: null
        })
      })
    );
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    const opTypes = res.plan.hostingerOps.map((op) => op.type);
    expect(opTypes).toContain("stop_vm");
    expect(opTypes).toContain("disable_billing_auto_renewal");
    // Order matters: stop the VM first so we never disable renewal on a
    // still-running instance generating work.
    expect(opTypes.indexOf("stop_vm")).toBeLessThan(
      opTypes.indexOf("disable_billing_auto_renewal")
    );
  });

  it("stamps wiped_at BEFORE delete_backup_artifact so a partial-execute crash can't strand the row in a 'data gone but not wiped' state", () => {
    // Regression: `runResubscribeFromCheckout` (in the change-plan
    // orchestrator) keys both its pre-flight `isCanceledInGrace`
    // guard and its final `updateSubscriptionIfNotWiped` write on
    // `wiped_at`. If the planner ran `delete_backup_artifact` first
    // and the executor crashed (Vercel timeout, transient Supabase
    // Storage error, executor exception) before stamping `wiped_at`,
    // a customer who reactivated during that window could pass both
    // guards, get provisioned, see `restoreBusinessData` throw "no
    // backup recorded" (currently caught + logged), and end up with
    // an empty workspace they were charged for — silent data loss.
    // Reordering closes that race because a partial-execute now
    // leaves `wiped_at` stamped, so resubscribe aborts loudly.
    const res = planLifecycleAction(
      { type: "graceExpiredWipe" },
      makeCtx({
        ownerAuthUserId: "auth-1",
        subscription: makeSub({
          status: "canceled",
          grace_ends_at: "2026-04-01T00:00:00.000Z",
          wiped_at: null
        })
      })
    );
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);

    const dbTypes = res.plan.dbUpdates.map((op) => op.type);
    const wipedAtIdx = res.plan.dbUpdates.findIndex(
      (op) =>
        op.type === "update_subscription" &&
        (op as { patch?: { wiped_at?: unknown } }).patch?.wiped_at !== undefined
    );
    const deleteBackupIdx = dbTypes.indexOf("delete_backup_artifact");

    expect(wipedAtIdx).toBeGreaterThanOrEqual(0);
    expect(deleteBackupIdx).toBeGreaterThanOrEqual(0);
    expect(wipedAtIdx).toBeLessThan(deleteBackupIdx);
  });

  it("omits stop_vm + disable_billing_auto_renewal when VM id and billing id are missing", () => {
    const res = planLifecycleAction(
      { type: "graceExpiredWipe" },
      makeCtx({
        virtualMachineId: null,
        subscription: makeSub({
          status: "canceled",
          grace_ends_at: "2026-04-01T00:00:00.000Z",
          wiped_at: null,
          hostinger_billing_subscription_id: null
        })
      })
    );
    if (!res.ok) throw new Error(`unexpected reject ${res.reason}`);
    expect(res.plan.hostingerOps).toEqual([]);
  });
});

describe("planLifecycleAction: return_vps_to_pool (fleet economics Phase B)", () => {
  function poolOp(plan: { ok: true; plan: { dbUpdates: unknown[] } } | { ok: false; reason: string }) {
    if (!plan.ok) throw new Error(`unexpected reject ${plan.reason}`);
    return plan.plan.dbUpdates.find(
      (op) => (op as { type: string }).type === "return_vps_to_pool"
    ) as
      | {
          type: "return_vps_to_pool";
          virtualMachineId: number;
          plan: string;
          hostingerBillingSubscriptionId: string | null;
          notes: string;
        }
      | undefined;
  }

  it("cancel-with-refund returns the box to the pool using the vps_size pin", () => {
    const res = planLifecycleAction(
      { type: "cancelWithRefund" },
      makeCtx({ vpsSize: "kvm8" })
    );
    const op = poolOp(res);
    expect(op).toEqual({
      type: "return_vps_to_pool",
      virtualMachineId: 42,
      plan: "kvm8",
      hostingerBillingSubscriptionId: "hbs-1",
      notes: expect.stringContaining("returned by user_refund cancel of business biz-1")
    });
  });

  it("prefers an explicit kvm2 pin over the tier default", () => {
    const res = planLifecycleAction(
      { type: "cancelWithRefund" },
      makeCtx({ vpsSize: "kvm2", subscription: makeSub({ tier: "standard" }) })
    );
    expect(poolOp(res)?.plan).toBe("kvm2");
  });

  it("keeps a kvm4 pin as the pool label (escalated mid-size box)", () => {
    const res = planLifecycleAction(
      { type: "cancelWithRefund" },
      makeCtx({ vpsSize: "kvm4", subscription: makeSub({ tier: "standard" }) })
    );
    expect(poolOp(res)?.plan).toBe("kvm4");
  });

  it("labels an unpinned starter box kvm2 (historical pre-inventory hardware, NOT the new kvm1 default)", () => {
    // Every kvm1-era box gets a vps_inventory row (with its real plan) at
    // purchase/adopt time, so this fallback only ever fires for
    // pre-inventory starter boxes — which are all kvm2 hardware.
    const res = planLifecycleAction({ type: "cancelWithRefund" }, makeCtx());
    expect(poolOp(res)?.plan).toBe("kvm2");
  });

  it("falls back to kvm8 for non-starter tiers when the pin is corrupt", () => {
    const res = planLifecycleAction(
      { type: "cancelWithRefund" },
      makeCtx({ vpsSize: "kvm999", subscription: makeSub({ tier: "standard" }) })
    );
    expect(poolOp(res)?.plan).toBe("kvm8");
  });

  it("omits the pool op when the business has no VM", () => {
    const res = planLifecycleAction(
      { type: "cancelWithRefund" },
      makeCtx({ virtualMachineId: null, vpsHost: null })
    );
    expect(poolOp(res)).toBeUndefined();
  });

  it("grace-expired wipe also pools the box (manual-Stripe-cancel backstop)", () => {
    const res = planLifecycleAction(
      { type: "graceExpiredWipe" },
      makeCtx({
        vpsSize: "kvm2",
        subscription: makeSub({
          status: "canceled",
          grace_ends_at: "2026-04-01T00:00:00.000Z",
          wiped_at: null,
          cancel_reason: "payment_failed"
        })
      })
    );
    const op = poolOp(res);
    expect(op).toEqual(
      expect.objectContaining({
        virtualMachineId: 42,
        plan: "kvm2",
        notes: expect.stringContaining("returned by grace-expired wipe of business biz-1")
      })
    );
  });

  it("grace-expired wipe omits the pool op when there is no VM", () => {
    const res = planLifecycleAction(
      { type: "graceExpiredWipe" },
      makeCtx({
        virtualMachineId: null,
        vpsHost: null,
        subscription: makeSub({
          status: "canceled",
          grace_ends_at: "2026-04-01T00:00:00.000Z",
          wiped_at: null
        })
      })
    );
    expect(poolOp(res)).toBeUndefined();
  });
});

describe("planLifecycleAction: provider axis (BYOS / OVH skip Hostinger lifecycle)", () => {
  it("byos cancel keeps the SSH backup but emits no Hostinger ops, pool return, or hPanel email", () => {
    const ctx = makeCtx({
      vpsProvider: "byos",
      // A BYOS row can still carry a numeric-looking box id and a billing
      // id from a past life — the provider gate must win over presence.
      virtualMachineId: 42
    });
    const res = planLifecycleAction({ type: "cancelWithRefund" }, ctx);
    if (!res.ok) throw new Error(`expected ok, got ${res.reason}`);
    const { plan } = res;

    // Customer-owned box: nothing Hostinger-side to snapshot/stop/bill.
    expect(plan.hostingerOps).toEqual([]);
    // The box is still reachable, so the durable-data backup still runs.
    expect(plan.sshOps).toEqual([
      { type: "backup_durable_data", businessId: "biz-1", vpsHost: "1.2.3.4" }
    ]);
    // A customer-owned box must never enter the Hostinger reuse pool.
    expect(plan.dbUpdates.some((op) => op.type === "return_vps_to_pool")).toBe(false);
    // No hPanel entry exists — no ops deletion request.
    expect(plan.emailsToSend.map((e) => e.type)).toEqual([
      "send_cancel_confirmation",
      "send_refund_issued"
    ]);
    // No VM was stopped, so the plan must not claim one was.
    const subUpdate = plan.dbUpdates.find(
      (op) => op.type === "update_subscription"
    ) as { type: "update_subscription"; patch: Record<string, unknown> };
    expect(subUpdate.patch.vps_stopped_at).toBeNull();
  });

  it("ovh grace-expired wipe still wipes centrally but skips every Hostinger op", () => {
    const res = planLifecycleAction(
      { type: "graceExpiredWipe" },
      makeCtx({
        vpsProvider: "ovh",
        subscription: makeSub({
          status: "canceled",
          grace_ends_at: "2026-04-01T00:00:00.000Z",
          wiped_at: null,
          cancel_reason: "payment_failed"
        })
      })
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.reason}`);
    expect(res.plan.hostingerOps).toEqual([]);
    expect(res.plan.dbUpdates.some((op) => op.type === "return_vps_to_pool")).toBe(false);
    expect(
      res.plan.emailsToSend.some((e) => e.type === "send_ops_vps_deletion_request")
    ).toBe(false);
    // The central wipe itself is provider-independent.
    const subUpdate = res.plan.dbUpdates.find(
      (op) => op.type === "update_subscription"
    ) as { type: "update_subscription"; patch: Record<string, unknown> };
    expect(subUpdate.patch.wiped_at).toBeTruthy();
    expect(res.plan.dbUpdates.some((op) => op.type === "mark_business_wiped")).toBe(true);
    expect(res.plan.dbUpdates).toContainEqual({
      type: "delete_backup_artifact",
      businessId: "biz-1"
    });
  });

  it("byos grace-expired wipe emits the on-box wipe op (and skips it when the host is unknown)", () => {
    const wipeSub = makeSub({
      status: "canceled",
      grace_ends_at: "2026-04-01T00:00:00.000Z",
      wiped_at: null,
      cancel_reason: "user_period_end"
    });

    const withHost = planLifecycleAction(
      { type: "graceExpiredWipe" },
      makeCtx({ vpsProvider: "byos", vpsHost: "203.0.113.7", subscription: wipeSub })
    );
    if (!withHost.ok) throw new Error(`expected ok, got ${withHost.reason}`);
    expect(withHost.plan.sshOps).toContainEqual({
      type: "wipe_byos_box",
      businessId: "biz-1",
      vpsHost: "203.0.113.7"
    });
    // Hostinger teardown stays skipped for a customer-owned box.
    expect(withHost.plan.hostingerOps).toEqual([]);

    // Unknown host (box unreachable): no wipe op this tick — the sweep
    // retries idempotently on the next one.
    const noHost = planLifecycleAction(
      { type: "graceExpiredWipe" },
      makeCtx({ vpsProvider: "byos", vpsHost: null, subscription: wipeSub })
    );
    if (!noHost.ok) throw new Error(`expected ok, got ${noHost.reason}`);
    expect(noHost.plan.sshOps.some((op) => op.type === "wipe_byos_box")).toBe(false);

    // OVH boxes are platform-owned — terminated provider-side, never wiped
    // over SSH like a customer box.
    const ovh = planLifecycleAction(
      { type: "graceExpiredWipe" },
      makeCtx({ vpsProvider: "ovh", vpsHost: "203.0.113.8", subscription: wipeSub })
    );
    if (!ovh.ok) throw new Error(`expected ok, got ${ovh.reason}`);
    expect(ovh.plan.sshOps.some((op) => op.type === "wipe_byos_box")).toBe(false);
  });

  it("a corrupt provider value resolves to hostinger (full lifecycle preserved)", () => {
    const res = planLifecycleAction(
      { type: "cancelWithRefund" },
      makeCtx({ vpsProvider: "garbage" })
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.reason}`);
    expect(res.plan.hostingerOps.map((op) => op.type)).toEqual([
      "create_snapshot",
      "stop_vm",
      "disable_billing_auto_renewal"
    ]);
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
