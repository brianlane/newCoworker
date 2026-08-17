import { describe, it, expect } from "vitest";

import { isUpgradeSwitchDeletion } from "@/lib/billing/upgrade-switch";

const OLD = "sub_old";
const NEW = "sub_new";

describe("isUpgradeSwitchDeletion", () => {
  it("is TRUE mid-orchestration, when the old row still looks active", () => {
    // The case the old cancel_reason-only check missed entirely. The
    // orchestrator cancels the Stripe subscription at step 6 and only stamps
    // the row at step 8, so the webhook almost always lands here.
    expect(
      isUpgradeSwitchDeletion({
        deletedStripeSubscriptionId: OLD,
        deletedRow: { status: "active", cancel_reason: null },
        newestRow: { status: "active", stripe_subscription_id: NEW }
      })
    ).toBe(true);
  });

  it("is TRUE after the orchestrator has stamped the row", () => {
    // Late or replayed delivery, past step 8.
    expect(
      isUpgradeSwitchDeletion({
        deletedStripeSubscriptionId: OLD,
        deletedRow: { status: "canceled", cancel_reason: "upgrade_switch" },
        newestRow: null
      })
    ).toBe(true);
  });

  it("is FALSE for an ordinary cancellation", () => {
    // The newest row IS the row being deleted, so there is no replacement.
    expect(
      isUpgradeSwitchDeletion({
        deletedStripeSubscriptionId: OLD,
        deletedRow: { status: "active", cancel_reason: null },
        newestRow: { status: "active", stripe_subscription_id: OLD }
      })
    ).toBe(false);
  });

  it("is FALSE when the newest row is not active", () => {
    for (const status of ["canceled", "pending", "past_due"]) {
      expect(
        isUpgradeSwitchDeletion({
          deletedStripeSubscriptionId: OLD,
          deletedRow: { status: "active", cancel_reason: null },
          newestRow: { status, stripe_subscription_id: NEW }
        })
      ).toBe(false);
    }
  });

  it("is FALSE when the business has no rows at all", () => {
    expect(
      isUpgradeSwitchDeletion({
        deletedStripeSubscriptionId: OLD,
        deletedRow: { status: "active", cancel_reason: null },
        newestRow: null
      })
    ).toBe(false);
  });

  it("is FALSE when the newest row carries no Stripe id to compare", () => {
    // A pending row mid-signup has no Stripe id; it is not evidence of a
    // replacement, so fail toward treating this as a real cancellation.
    for (const stripe_subscription_id of [null, undefined]) {
      expect(
        isUpgradeSwitchDeletion({
          deletedStripeSubscriptionId: OLD,
          deletedRow: { status: "active", cancel_reason: null },
          newestRow: { status: "active", stripe_subscription_id }
        })
      ).toBe(false);
    }
  });

  it("is FALSE when the deleted row is gone and there is no replacement", () => {
    expect(
      isUpgradeSwitchDeletion({
        deletedStripeSubscriptionId: OLD,
        deletedRow: null,
        newestRow: null
      })
    ).toBe(false);
  });

  it("does not treat a plain canceled row as a switch", () => {
    // cancel_reason has to be the orchestrator's exact signature.
    expect(
      isUpgradeSwitchDeletion({
        deletedStripeSubscriptionId: OLD,
        deletedRow: { status: "canceled", cancel_reason: "customer_request" },
        newestRow: { status: "active", stripe_subscription_id: OLD }
      })
    ).toBe(false);
    expect(
      isUpgradeSwitchDeletion({
        deletedStripeSubscriptionId: OLD,
        deletedRow: { status: "canceled" },
        newestRow: null
      })
    ).toBe(false);
  });

  it("treats a returning tenant's late deletion event as a switch", () => {
    // A tenant who cancelled and later resubscribed is ACTIVE now. A stale
    // deletion for their old subscription must not disable anything.
    expect(
      isUpgradeSwitchDeletion({
        deletedStripeSubscriptionId: OLD,
        deletedRow: { status: "canceled", cancel_reason: "customer_request" },
        newestRow: { status: "active", stripe_subscription_id: NEW }
      })
    ).toBe(true);
  });
});
