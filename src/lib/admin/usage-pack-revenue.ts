/**
 * This month's one-time usage-pack cash (Billing-page top-ups and
 * auto-reload). Recurring membership packs are already inside MRR via
 * `membership_pack_addons`, and their grants are stamped `inv_...`, so
 * those rows are skipped here. A pack id the catalog cannot price
 * contributes 0: the page still renders.
 */

export type PackUnitPrice = {
  unit: number;
  priceCents: number;
};

export type UsagePackGrant = {
  businessId: string;
  /** `stripe_checkout_session_id`. `inv_` means a recurring membership grant. */
  sourceId: string | null;
  voided: boolean;
  units: number;
};

export type UsagePackRevenue = {
  totalCents: number;
  byBusiness: Map<string, number>;
};

/** Membership-invoice grants are already priced into MRR. */
export function isRecurringMembershipGrant(sourceId: string | null): boolean {
  return (sourceId ?? "").startsWith("inv_");
}

/**
 * Cents for one grant. The largest catalog unit that divides the grant
 * wins, so a 120-minute purchase prices as one 120-minute pack rather
 * than four 30-minute packs.
 */
export function priceOneTimeGrant(grant: UsagePackGrant, packs: PackUnitPrice[]): number {
  if (grant.voided || isRecurringMembershipGrant(grant.sourceId)) return 0;
  if (!Number.isFinite(grant.units) || grant.units <= 0) return 0;
  const fit = packs
    .filter((pack) => pack.unit > 0 && pack.priceCents > 0 && grant.units % pack.unit === 0)
    .sort((a, b) => b.unit - a.unit)[0];
  if (!fit) return 0;
  return (grant.units / fit.unit) * fit.priceCents;
}

export function sumUsagePackRevenue(
  grants: UsagePackGrant[],
  packs: PackUnitPrice[]
): UsagePackRevenue {
  const byBusiness = new Map<string, number>();
  let totalCents = 0;
  for (const grant of grants) {
    const cents = priceOneTimeGrant(grant, packs);
    if (cents <= 0) continue;
    totalCents += cents;
    byBusiness.set(grant.businessId, (byBusiness.get(grant.businessId) ?? 0) + cents);
  }
  return { totalCents, byBusiness };
}

export type UsagePackGrantRow = {
  business_id: string;
  stripe_checkout_session_id: string | null;
  voided_at: string | null;
  units: number;
};

export function usagePackGrantFromRow(row: UsagePackGrantRow): UsagePackGrant {
  return {
    businessId: row.business_id,
    sourceId: row.stripe_checkout_session_id,
    voided: row.voided_at !== null,
    units: row.units
  };
}
