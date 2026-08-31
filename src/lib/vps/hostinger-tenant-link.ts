/**
 * How a Hostinger billing subscription maps onto a New Coworker tenant.
 *
 * Two columns can carry the id, and they are not always both filled:
 *
 *   - `subscriptions.hostinger_billing_subscription_id` is what term-renewal,
 *     change-plan, and `debug/audit-fleet-terms.ts` join on. Stripe-paid
 *     provision stamps it. A stripeless row (HQ, skip-payment) used to leave
 *     it null even when the box was assigned.
 *   - `vps_inventory.hostinger_billing_subscription_id` is stamped at adopt /
 *     purchase time and is the inventory's own join.
 *
 * Prefer the subscription row when it has the id. Fall back to an assigned
 * inventory row so a prepaid internal box (HQ, paid through 2027-09-05) is
 * not reported as UNLINKED.
 */

export type HostingerLinkSubscription = {
  id: string;
  business_id: string;
  status: string;
  stripe_subscription_id: string | null;
  hostinger_billing_subscription_id: string | null;
  created_at?: string;
};

export type HostingerLinkInventory = {
  vm_id: number;
  state: string;
  assigned_business_id: string | null;
  hostinger_billing_subscription_id: string | null;
};

function isLiveSubscriptionStatus(status: string): boolean {
  return status === "active" || status === "past_due";
}

/** A live row whose Hostinger billing id was never stamped. Pending carts are not this. */
export function isLiveRowMissingHostingerBillingId(
  row: Pick<HostingerLinkSubscription, "status" | "hostinger_billing_subscription_id">
): boolean {
  return isLiveSubscriptionStatus(row.status) && !row.hostinger_billing_subscription_id;
}

/**
 * Business that owns this Hostinger billing subscription, or null when
 * neither the subscription table nor assigned inventory knows it.
 */
export function businessIdForHostingerBillingSub(
  hostingerBillingSubscriptionId: string,
  args: {
    subscriptions: ReadonlyArray<Pick<HostingerLinkSubscription, "business_id" | "hostinger_billing_subscription_id">>;
    inventory: ReadonlyArray<
      Pick<HostingerLinkInventory, "state" | "assigned_business_id" | "hostinger_billing_subscription_id">
    >;
  }
): string | null {
  for (const row of args.subscriptions) {
    if (row.hostinger_billing_subscription_id === hostingerBillingSubscriptionId) {
      return row.business_id;
    }
  }
  for (const row of args.inventory) {
    if (
      row.state === "assigned" &&
      row.assigned_business_id &&
      row.hostinger_billing_subscription_id === hostingerBillingSubscriptionId
    ) {
      return row.assigned_business_id;
    }
  }
  return null;
}

export type ReconcileStampPlan = {
  kind: "stamp";
  businessId: string;
  subscriptionId: string;
  hostingerBillingSubscriptionId: string;
  vmId: number;
};

export type ReconcileCancelPlan = {
  kind: "cancel_pending";
  businessId: string;
  subscriptionId: string;
};

export type ReconcileSkip = {
  kind: "skip";
  businessId: string | null;
  reason: string;
};

export type ReconcilePlan = ReconcileStampPlan | ReconcileCancelPlan;

/**
 * Live (active/past_due) row for a business, newest if more than one.
 * Pending and canceled rows are ignored so an abandoned checkout cannot
 * shadow the paid row.
 */
export function liveSubscriptionForBusiness(
  businessId: string,
  subscriptions: ReadonlyArray<HostingerLinkSubscription>
): HostingerLinkSubscription | null {
  let newest: HostingerLinkSubscription | null = null;
  for (const row of subscriptions) {
    if (row.business_id !== businessId) continue;
    if (!isLiveSubscriptionStatus(row.status)) continue;
    if (!newest) {
      newest = row;
      continue;
    }
    const rowAt = Date.parse(row.created_at ?? "");
    const newestAt = Date.parse(newest.created_at ?? "");
    if (Number.isFinite(rowAt) && Number.isFinite(newestAt)) {
      if (rowAt >= newestAt) newest = row;
    } else {
      newest = row;
    }
  }
  return newest;
}

/**
 * What to write so subscription rows and inventory agree, and leftover
 * unpaid pending carts next to a live sibling are closed.
 *
 * Stamp is fill-only: a live row that already has a *different* Hostinger
 * id is a partial cutover and is skipped, not overwritten.
 */
export function planSubscriptionHostingerReconcile(args: {
  subscriptions: ReadonlyArray<HostingerLinkSubscription>;
  inventory: ReadonlyArray<HostingerLinkInventory>;
  businessIds?: ReadonlySet<string> | null;
}): { plans: ReconcilePlan[]; skips: ReconcileSkip[] } {
  const plans: ReconcilePlan[] = [];
  const skips: ReconcileSkip[] = [];
  const allow = args.businessIds ?? null;
  const inScope = (businessId: string): boolean => !allow || allow.has(businessId);

  const seenCancel = new Set<string>();
  const businesses = new Set<string>();
  for (const row of args.subscriptions) businesses.add(row.business_id);
  for (const row of args.inventory) {
    if (row.assigned_business_id) businesses.add(row.assigned_business_id);
  }

  for (const row of args.inventory) {
    if (row.state !== "assigned" || !row.assigned_business_id) continue;
    if (!inScope(row.assigned_business_id)) continue;
    if (!row.hostinger_billing_subscription_id) {
      skips.push({
        kind: "skip",
        businessId: row.assigned_business_id,
        reason: `vm ${row.vm_id} is assigned but inventory has no Hostinger billing id`
      });
      continue;
    }
    const live = liveSubscriptionForBusiness(row.assigned_business_id, args.subscriptions);
    if (!live) {
      skips.push({
        kind: "skip",
        businessId: row.assigned_business_id,
        reason: `vm ${row.vm_id} is assigned but this business has no live subscription row`
      });
      continue;
    }
    if (live.hostinger_billing_subscription_id === row.hostinger_billing_subscription_id) {
      continue;
    }
    if (live.hostinger_billing_subscription_id) {
      skips.push({
        kind: "skip",
        businessId: row.assigned_business_id,
        reason:
          `vm ${row.vm_id} inventory id ${row.hostinger_billing_subscription_id} disagrees with ` +
          `live subscription ${live.id} id ${live.hostinger_billing_subscription_id} (partial cutover)`
      });
      continue;
    }
    plans.push({
      kind: "stamp",
      businessId: row.assigned_business_id,
      subscriptionId: live.id,
      hostingerBillingSubscriptionId: row.hostinger_billing_subscription_id,
      vmId: row.vm_id
    });
  }

  for (const businessId of businesses) {
    if (!inScope(businessId)) continue;
    const live = liveSubscriptionForBusiness(businessId, args.subscriptions);
    if (!live) continue;
    for (const row of args.subscriptions) {
      if (row.business_id !== businessId) continue;
      if (row.id === live.id) continue;
      if (row.status !== "pending") continue;
      if (row.stripe_subscription_id) continue;
      if (seenCancel.has(row.id)) continue;
      seenCancel.add(row.id);
      plans.push({
        kind: "cancel_pending",
        businessId,
        subscriptionId: row.id
      });
    }
  }

  return { plans, skips };
}
