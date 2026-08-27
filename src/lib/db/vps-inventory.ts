/**
 * VPS reuse pool (fleet economics Phase B).
 *
 * Hostinger boxes are effectively non-refundable for us until ≈Dec 30, 2026
 * (30-day-per-box AND 180-days-since-last-refund policy), so canceled /
 * replaced VMs are sunk cost. This module tracks owned boxes so provisioning
 * can adopt one (Hostinger setup/recreate, no purchase) before buying new.
 *
 * Lifecycle of a row:
 *   purchase           → recordVpsAssigned (state=assigned)
 *   tenant cancel/wipe → releaseVpsToPool  (state=available, business cleared)
 *   adopt-first hit    → claimAvailableVps (state=assigned, race-safe)
 *   box gone upstream  → retireVps         (state=retired, audit kept)
 *
 * Service-role only, the table has RLS on with no policies.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { VpsSize } from "@/lib/vps/size";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type VpsInventoryState = "available" | "assigned" | "retired";

/**
 * Minimum remaining paid runway a pooled box must have before adopt-first
 * will claim it. Shorter than this and the claim skips the candidate
 * (falling through to purchase) rather than landing a tenant on a box that
 * dies the next day.
 */
export const VPS_POOL_MIN_RUNWAY_MS = 72 * 60 * 60 * 1000;

export type VpsInventoryRow = {
  vm_id: number;
  hostname: string | null;
  plan: string;
  state: VpsInventoryState;
  hostinger_billing_subscription_id: string | null;
  assigned_business_id: string | null;
  acquired_at: string;
  assigned_at: string | null;
  notes: string | null;
  /**
   * Sunk-cost box that must lapse at its paid period end NO MATTER WHAT,
   * even while assigned to a live tenant. The adopt path skips its
   * auto-renew re-enable and the billing-posture cron skips its auto-heal
   * (nagging ops to migrate the tenant instead). Example: srv1632631, KVM8
   * hardware pooled under the kvm2 label whose $73.99/mo renewal must never
   * be paid for a kvm2-priced tenant.
   */
  never_renew: boolean;
  /**
   * Hostinger paid-through timestamp (`expires_at ?? next_billing_at` from
   * the billing subscription). Null when unknown / not yet refreshed.
   * {@link claimAvailableVps} prefers the furthest expiry and skips boxes
   * with under {@link VPS_POOL_MIN_RUNWAY_MS} of runway.
   */
  expires_at: string | null;
  updated_at: string;
};

/** Paid-through from a Hostinger billing subscription (either field). */
export function paidThroughFromBillingSub(sub: {
  expires_at?: string | null;
  next_billing_at?: string | null;
}): string | null {
  return sub.expires_at ?? sub.next_billing_at ?? null;
}

/** True when the box has unknown expiry OR at least {@link VPS_POOL_MIN_RUNWAY_MS} left. */
export function hasPoolRunway(
  expiresAt: string | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (expiresAt == null || expiresAt === "") return true;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return true;
  return ms - nowMs >= VPS_POOL_MIN_RUNWAY_MS;
}

/**
 * Atomically claim one available box of the requested size.
 *
 * Preference: furthest {@link VpsInventoryRow.expires_at} first (unknown
 * expiry sorts last), then oldest `acquired_at` as a tie-break. Candidates
 * with a known expiry under {@link VPS_POOL_MIN_RUNWAY_MS} are skipped so a
 * signup is never landed on a box that dies the next day, the caller then
 * falls through to purchase.
 *
 * Race safety: two concurrent provisions must never adopt the same VM. The
 * conditional UPDATE (`state = 'available'` in the WHERE) is the lock, the
 * loser's update matches zero rows and moves on to the next candidate (or
 * returns null → caller falls back to purchase).
 *
 * Retry idempotency: a box THIS business already claimed is returned
 * as-is before the available scan. Without this, a provision that died
 * after the pool claim (the KYP Ads Jul 14 2026 signup, webhook function
 * torn down mid-adopt) left the row 'assigned' to the business, and the
 * retry would skip it and PURCHASE a second box; recovering required a
 * manual pool-row reset. Now the watchdog's re-run lands back on the same
 * hardware automatically.
 */
export async function claimAvailableVps(
  plan: VpsSize,
  businessId: string,
  client?: SupabaseClient
): Promise<VpsInventoryRow | null> {
  const db = client ?? (await createSupabaseServiceClient());

  const { data: own, error: ownErr } = await db
    .from("vps_inventory")
    .select("*")
    .eq("state", "assigned")
    .eq("assigned_business_id", businessId)
    .eq("plan", plan)
    .order("acquired_at", { ascending: true })
    .limit(1);
  if (ownErr) throw new Error(`claimAvailableVps: ${ownErr.message}`);
  const ownRow = ((own as VpsInventoryRow[] | null) ?? [])[0];
  if (ownRow) return ownRow;

  // Push the 72h runway floor into the query so short-runway boxes never
  // crowd the LIMIT 20 window ahead of eligible null-expiry inventory
  // (nulls sort last on expires_at DESC; known near-expiry would otherwise
  // fill the page and hide usable nulls). Client-side hasPoolRunway remains
  // as defense in depth. Furthest expiry first; unknown (null) last.
  const nowMs = Date.now();
  const minExpiryIso = new Date(nowMs + VPS_POOL_MIN_RUNWAY_MS).toISOString();
  // Quote the ISO value: PostgREST treats `.` and `:` as reserved in filter
  // grammar, so an unquoted timestamp would break the or() clause.
  const { data: candidates, error } = await db
    .from("vps_inventory")
    .select("vm_id, expires_at")
    .eq("state", "available")
    .eq("plan", plan)
    .or(`expires_at.is.null,expires_at.gte."${minExpiryIso}"`)
    .order("expires_at", { ascending: false, nullsFirst: false })
    .order("acquired_at", { ascending: true })
    .limit(20);
  if (error) throw new Error(`claimAvailableVps: ${error.message}`);

  const eligible = ((candidates as { vm_id: number; expires_at: string | null }[] | null) ?? []).filter(
    (c) => hasPoolRunway(c.expires_at, nowMs)
  );

  for (const candidate of eligible) {
    const { data: claimed, error: claimErr } = await db
      .from("vps_inventory")
      .update({
        state: "assigned",
        assigned_business_id: businessId,
        assigned_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("vm_id", candidate.vm_id)
      .eq("state", "available")
      .select()
      .maybeSingle();
    if (claimErr) throw new Error(`claimAvailableVps: ${claimErr.message}`);
    if (claimed) return claimed as VpsInventoryRow;
  }
  return null;
}

/**
 * Atomically claim one specific pooled VM by id (term fail-but-charge
 * adopt). Unlike {@link claimAvailableVps}, this never substitutes a
 * different available box of the same size.
 *
 * Returns the row when the claim wins (or the VM is already assigned to
 * this business), otherwise null when another provision claimed it first
 * or the row is not `available`.
 */
export async function claimSpecificAvailableVps(
  vmId: number,
  businessId: string,
  client?: SupabaseClient
): Promise<VpsInventoryRow | null> {
  const db = client ?? (await createSupabaseServiceClient());

  const { data: own, error: ownErr } = await db
    .from("vps_inventory")
    .select("*")
    .eq("vm_id", vmId)
    .eq("state", "assigned")
    .eq("assigned_business_id", businessId)
    .maybeSingle();
  if (ownErr) throw new Error(`claimSpecificAvailableVps: ${ownErr.message}`);
  if (own) return own as VpsInventoryRow;

  const { data: claimed, error: claimErr } = await db
    .from("vps_inventory")
    .update({
      state: "assigned",
      assigned_business_id: businessId,
      assigned_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("vm_id", vmId)
    .eq("state", "available")
    .select()
    .maybeSingle();
  if (claimErr) throw new Error(`claimSpecificAvailableVps: ${claimErr.message}`);
  return (claimed as VpsInventoryRow | null) ?? null;
}

/**
 * Record a freshly purchased box as assigned inventory. Upsert so a
 * re-provision of the same VM (idempotent retry) doesn't fail on the PK.
 */
export async function recordVpsAssigned(
  input: {
    vmId: number;
    plan: VpsSize;
    businessId: string;
    hostname?: string | null;
    hostingerBillingSubscriptionId?: string | null;
    /**
     * Hostinger paid-through for the box we just bought. Stamping it HERE is
     * what closes the window in which a freshly-purchased box carries a null
     * expiry: `claimAvailableVps` sorts unknown expiry last, so a box with
     * real runway used to lose the adopt-first ranking to a box with a known
     * but shorter one until the daily billing-posture cron filled the column
     * in. Omit (not null) to leave an existing value untouched, PostgREST
     * upserts only the keys present in the payload, and a caller that could
     * not resolve the date must not erase one we already knew.
     */
    expiresAt?: string | null;
    notes?: string | null;
  },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("vps_inventory").upsert(
    {
      vm_id: input.vmId,
      plan: input.plan,
      state: "assigned",
      assigned_business_id: input.businessId,
      assigned_at: new Date().toISOString(),
      hostname: input.hostname ?? `srv${input.vmId}.hstgr.cloud`,
      hostinger_billing_subscription_id: input.hostingerBillingSubscriptionId ?? null,
      ...(input.expiresAt !== undefined ? { expires_at: input.expiresAt } : {}),
      notes: input.notes ?? null,
      updated_at: new Date().toISOString()
    },
    { onConflict: "vm_id" }
  );
  if (error) throw new Error(`recordVpsAssigned: ${error.message}`);
}

/**
 * Return a box to the pool after its tenant cancels. The box stays owned
 * (auto-renew off, it lapses at its paid period end unless adopted first),
 * so the next matching-size provision can reuse it instead of purchasing.
 *
 * Existing rows keep their recorded `plan`: the SKU captured at
 * purchase/adopt time is ground truth, while a cancel-time caller can only
 * infer it (tier default / pin), which can mislabel the box and break the
 * adopt-first size match. `input.plan` only seeds boxes provisioned before
 * this table existed (no row yet).
 */
export async function releaseVpsToPool(
  input: {
    vmId: number;
    plan: VpsSize;
    hostname?: string | null;
    hostingerBillingSubscriptionId?: string | null;
    /** Hostinger paid-through; when omitted the existing value is preserved on update. */
    expiresAt?: string | null;
    notes?: string | null;
  },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const nowIso = new Date().toISOString();

  const { data: existing, error: readErr } = await db
    .from("vps_inventory")
    .select("vm_id, state")
    .eq("vm_id", input.vmId)
    .maybeSingle();
  if (readErr) throw new Error(`releaseVpsToPool: ${readErr.message}`);

  if (existing) {
    // A retired row means the box is gone upstream (lapsed, panel-deleted,
    // failed adopt). A later lifecycle release for the same vm_id (e.g. the
    // grace-expired wipe re-running after the cancel already pooled and a
    // failed adopt retired it) must not resurrect it into the adopt pool.
    if ((existing as { state: string }).state === "retired") return;
    const patch: Record<string, unknown> = {
      state: "available",
      assigned_business_id: null,
      assigned_at: null,
      hostinger_billing_subscription_id: input.hostingerBillingSubscriptionId ?? null,
      notes: input.notes ?? null,
      updated_at: nowIso
    };
    if (input.expiresAt !== undefined) patch.expires_at = input.expiresAt;
    const { error } = await db
      .from("vps_inventory")
      .update(patch)
      .eq("vm_id", input.vmId)
      // Guard against a retire racing between our read and this write.
      .neq("state", "retired");
    if (error) throw new Error(`releaseVpsToPool: ${error.message}`);
    return;
  }

  const { error } = await db.from("vps_inventory").insert({
    vm_id: input.vmId,
    plan: input.plan,
    state: "available",
    assigned_business_id: null,
    assigned_at: null,
    hostname: input.hostname ?? `srv${input.vmId}.hstgr.cloud`,
    hostinger_billing_subscription_id: input.hostingerBillingSubscriptionId ?? null,
    expires_at: input.expiresAt ?? null,
    notes: input.notes ?? null,
    updated_at: nowIso
  });
  if (error) throw new Error(`releaseVpsToPool: ${error.message}`);
}

/**
 * Mark a box gone from Hostinger (lapsed, panel-deleted, or adopt-time
 * lookup 404). The row is kept for audit rather than deleted.
 */
export async function retireVps(
  vmId: number,
  reason: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("vps_inventory")
    .update({
      state: "retired",
      assigned_business_id: null,
      notes: reason,
      updated_at: new Date().toISOString()
    })
    .eq("vm_id", vmId);
  if (error) throw new Error(`retireVps: ${error.message}`);
}

/**
 * Retire a pooled row whose hardware is gone, but ONLY while it is still
 * `available`. Returns true when a row was actually retired.
 *
 * The state guard is the whole difference from {@link retireVps}, which
 * retires unconditionally because its caller (the adopt path) is retiring a
 * box it just claimed and legitimately holds as `assigned`. The billing
 * posture reaper has no such claim: it decides from a snapshot taken earlier
 * in the run, and {@link claimSpecificAvailableVps} can assign ANY
 * `available` row by id without consulting runway. Without the guard, a
 * claim landing between the reaper's read and this write would clear
 * `assigned_business_id` out from under a live signup, and the purchase
 * cooldown (which reads assigned rows) would then let the term sweep buy
 * that tenant a second box.
 *
 * PostgREST reports no error for an update that matches zero rows, so the
 * boolean is load-bearing: a caller that assumed success would report a
 * retire that never happened.
 */
export async function retireLapsedPoolVps(
  vmId: number,
  reason: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("vps_inventory")
    .update({
      state: "retired",
      assigned_business_id: null,
      notes: reason,
      updated_at: new Date().toISOString()
    })
    .eq("vm_id", vmId)
    .eq("state", "available")
    .select("vm_id")
    .maybeSingle();
  if (error) throw new Error(`retireLapsedPoolVps: ${error.message}`);
  return data !== null;
}

/**
 * Single-row lookup by Hostinger VM id. Null when the box was never tracked
 * (pre-inventory purchases, --adopt-vm orphans). Used by the adopt path to
 * honor `never_renew` regardless of how the adopt was initiated.
 */
export async function getVpsInventoryByVmId(
  vmId: number,
  client?: SupabaseClient
): Promise<VpsInventoryRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("vps_inventory")
    .select("*")
    .eq("vm_id", vmId)
    .maybeSingle();
  if (error) throw new Error(`getVpsInventoryByVmId: ${error.message}`);
  return (data as VpsInventoryRow | null) ?? null;
}

/**
 * Flag a pooled box so adopt and billing-posture never re-enable its renewal.
 * Used after term-renewal sweep returns a sunk-cost box to the pool.
 */
export async function markVpsNeverRenew(vmId: number, client?: SupabaseClient): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("vps_inventory")
    .update({ never_renew: true, updated_at: new Date().toISOString() })
    .eq("vm_id", vmId);
  if (error) throw new Error(`markVpsNeverRenew: ${error.message}`);
}

/**
 * Clear `never_renew` on a box whose flag no longer applies: the adopt path
 * calls this when the box's PHYSICAL Hostinger plan matches the size being
 * adopted, so the sunk-cost rationale (mislabeled hardware whose renewal the
 * tenant's price doesn't cover) is void and renewal must come back ON for
 * the live tenant. Live precedent: vm 1864812, adopted for a paying tenant
 * on 2026-08-24 with renewal OFF and repaired by hand the next day.
 */
export async function clearVpsNeverRenew(vmId: number, client?: SupabaseClient): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("vps_inventory")
    .update({ never_renew: false, updated_at: new Date().toISOString() })
    .eq("vm_id", vmId);
  if (error) throw new Error(`clearVpsNeverRenew: ${error.message}`);
}

/**
 * When we most recently acquired a box that is still assigned to this
 * business, or null when none is.
 *
 * `acquired_at` is the purchase stamp: `recordVpsAssigned` deliberately omits
 * it from the upsert payload, so it takes `default now()` on insert and is
 * preserved on conflict. That makes it the durable answer to "when did we last
 * buy this tenant a box", including when the migration that bought it never
 * finished. Reads assigned rows only: a released box has its business linkage
 * cleared, and its purchase is no longer the one we are cooling down on.
 */
export async function getLastAcquiredAtForBusiness(
  businessId: string,
  client?: SupabaseClient
): Promise<Date | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("vps_inventory")
    .select("acquired_at")
    .eq("assigned_business_id", businessId)
    .order("acquired_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getLastAcquiredAtForBusiness: ${error.message}`);
  const acquiredAt = (data as { acquired_at?: string | null } | null)?.acquired_at;
  if (!acquiredAt) return null;
  const at = new Date(acquiredAt);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Pool telemetry for the admin dashboard, newest-acquired first. */
export async function listVpsInventory(client?: SupabaseClient): Promise<VpsInventoryRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("vps_inventory")
    .select("*")
    .order("acquired_at", { ascending: false });
  if (error) throw new Error(`listVpsInventory: ${error.message}`);
  return (data as VpsInventoryRow[] | null) ?? [];
}

/**
 * Refresh `expires_at` on every non-retired inventory row from the live
 * Hostinger billing subscriptions. Called by the daily billing-posture cron
 * so adopt-first ranking stays current without a separate job.
 *
 * Returns the number of rows whose stored expiry changed (or was filled).
 */
export async function refreshVpsInventoryExpiresAt(
  inventory: ReadonlyArray<
    Pick<VpsInventoryRow, "vm_id" | "state" | "hostinger_billing_subscription_id" | "expires_at">
  >,
  subscriptions: ReadonlyArray<{
    id: string;
    expires_at?: string | null;
    next_billing_at?: string | null;
  }>,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const subsById = new Map(subscriptions.map((s) => [s.id, s]));
  let updated = 0;
  for (const row of inventory) {
    if (row.state === "retired") continue;
    if (!row.hostinger_billing_subscription_id) continue;
    const sub = subsById.get(row.hostinger_billing_subscription_id);
    if (!sub) continue;
    const next = paidThroughFromBillingSub(sub);
    // Never wipe a known paid-through with null: a transient Hostinger
    // response missing both expires_at and next_billing_at would otherwise
    // re-admit a short-runway box (hasPoolRunway treats null as eligible).
    if (next == null) continue;
    if (next === row.expires_at) continue;
    const { error } = await db
      .from("vps_inventory")
      .update({ expires_at: next, updated_at: new Date().toISOString() })
      .eq("vm_id", row.vm_id)
      .neq("state", "retired");
    if (error) throw new Error(`refreshVpsInventoryExpiresAt: ${error.message}`);
    updated += 1;
  }
  return updated;
}
