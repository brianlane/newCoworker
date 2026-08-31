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

function assignedInventoryForBusiness(
  businessId: string,
  inventory: ReadonlyArray<HostingerLinkInventory>
): HostingerLinkInventory[] {
  const out: HostingerLinkInventory[] = [];
  for (const row of inventory) {
    if (row.state === "assigned" && row.assigned_business_id === businessId) {
      out.push(row);
    }
  }
  return out;
}

function highestVm(rows: ReadonlyArray<HostingerLinkInventory>): HostingerLinkInventory {
  let picked = rows[0]!;
  for (const row of rows) {
    if (row.vm_id > picked.vm_id) picked = row;
  }
  return picked;
}

/**
 * One assigned inventory row to copy a Hostinger billing id from, or a skip.
 *
 * A leftover `stale_assigned_row` (old box still `assigned` after
 * `businesses.hostinger_vps_id` moved) must not supply the id. Prefer the
 * current VM when the caller knows it. With no current VM, stamp only when
 * every assigned row agrees on the same non-null id.
 *
 * `null` means this business has no assigned inventory, so there is nothing
 * to stamp and nothing to skip.
 */
export function pickAssignedStampSource(
  businessId: string,
  inventory: ReadonlyArray<HostingerLinkInventory>,
  currentVmByBusiness?: ReadonlyMap<string, number> | null
):
  | { row: HostingerLinkInventory & { hostinger_billing_subscription_id: string } }
  | { skip: string }
  | null {
  const assigned = assignedInventoryForBusiness(businessId, inventory);
  const currentVmId = currentVmByBusiness?.get(businessId);

  if (currentVmId != null) {
    const current = assigned.find((row) => row.vm_id === currentVmId) ?? null;
    if (!current) {
      if (assigned.length === 0) return null;
      return {
        skip:
          `business points at srv${currentVmId} but no assigned inventory row for that VM ` +
          `(leftover assigned: ${assigned.map((row) => row.vm_id).join(", ")}); ` +
          "refusing to stamp from a stale_assigned_row"
      };
    }
    const id = current.hostinger_billing_subscription_id;
    if (!id) {
      return {
        skip: `vm ${current.vm_id} is assigned but inventory has no Hostinger billing id`
      };
    }
    return { row: { ...current, hostinger_billing_subscription_id: id } };
  }

  const distinct = new Set(
    assigned.map((row) => row.hostinger_billing_subscription_id ?? "")
  );
  if (distinct.size > 1) {
    const detail = assigned
      .map((row) => `vm ${row.vm_id}=${row.hostinger_billing_subscription_id ?? "null"}`)
      .join(", ");
    return {
      skip:
        `assigned inventory rows disagree on Hostinger billing id (${detail}): ` +
        "refusing to stamp a live subscription from a leftover assigned row"
    };
  }
  const first = assigned[0];
  if (!first) return null;
  const id = first.hostinger_billing_subscription_id;
  if (!id) {
    return {
      skip: `vm ${first.vm_id} is assigned but inventory has no Hostinger billing id`
    };
  }
  return { row: { ...highestVm(assigned), hostinger_billing_subscription_id: id } };
}

/**
 * What to write so subscription rows and inventory agree, and leftover
 * unpaid pending carts next to a live sibling are closed.
 *
 * Stamp is fill-only: a live row that already has a *different* Hostinger
 * id is a partial cutover and is skipped, not overwritten. At most one
 * stamp per business, from {@link pickAssignedStampSource}, so a leftover
 * assigned inventory row cannot race a later stamp and abort pending
 * cancels.
 */
export function planSubscriptionHostingerReconcile(args: {
  subscriptions: ReadonlyArray<HostingerLinkSubscription>;
  inventory: ReadonlyArray<HostingerLinkInventory>;
  businessIds?: ReadonlySet<string> | null;
  /** `businesses.hostinger_vps_id` parsed to a number. Prefer this VM. */
  currentVmByBusiness?: ReadonlyMap<string, number> | null;
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

  for (const businessId of businesses) {
    if (!inScope(businessId)) continue;
    const source = pickAssignedStampSource(
      businessId,
      args.inventory,
      args.currentVmByBusiness
    );
    const live = liveSubscriptionForBusiness(businessId, args.subscriptions);
    if (source && "skip" in source) {
      skips.push({ kind: "skip", businessId, reason: source.skip });
    } else if (source) {
      if (!live) {
        skips.push({
          kind: "skip",
          businessId,
          reason: `vm ${source.row.vm_id} is assigned but this business has no live subscription row`
        });
      } else if (
        live.hostinger_billing_subscription_id !== source.row.hostinger_billing_subscription_id
      ) {
        if (live.hostinger_billing_subscription_id) {
          skips.push({
            kind: "skip",
            businessId,
            reason:
              `vm ${source.row.vm_id} inventory id ${source.row.hostinger_billing_subscription_id} disagrees with ` +
              `live subscription ${live.id} id ${live.hostinger_billing_subscription_id} (partial cutover)`
          });
        } else {
          plans.push({
            kind: "stamp",
            businessId,
            subscriptionId: live.id,
            hostingerBillingSubscriptionId: source.row.hostinger_billing_subscription_id,
            vmId: source.row.vm_id
          });
        }
      }
    }

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
