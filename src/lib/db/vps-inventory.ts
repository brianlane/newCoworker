/**
 * VPS reuse pool (fleet economics Phase B).
 *
 * Hostinger boxes are effectively non-refundable for us until ≈Dec 30, 2026
 * (30-day-per-box AND 180-days-since-last-refund policy), so canceled /
 * replaced VMs are sunk cost. This module tracks owned boxes so provisioning
 * can adopt one (Hostinger setup/recreate — no purchase) before buying new.
 *
 * Lifecycle of a row:
 *   purchase           → recordVpsAssigned (state=assigned)
 *   tenant cancel/wipe → releaseVpsToPool  (state=available, business cleared)
 *   adopt-first hit    → claimAvailableVps (state=assigned, race-safe)
 *   box gone upstream  → retireVps         (state=retired, audit kept)
 *
 * Service-role only — the table has RLS on with no policies.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { VpsSize } from "@/lib/vps/size";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type VpsInventoryState = "available" | "assigned" | "retired";

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
   * Sunk-cost box that must lapse at its paid period end NO MATTER WHAT —
   * even while assigned to a live tenant. The adopt path skips its
   * auto-renew re-enable and the billing-posture cron skips its auto-heal
   * (nagging ops to migrate the tenant instead). Example: srv1632631, KVM8
   * hardware pooled under the kvm2 label whose $73.99/mo renewal must never
   * be paid for a kvm2-priced tenant.
   */
  never_renew: boolean;
  updated_at: string;
};

/**
 * Atomically claim one available box of the requested size.
 *
 * Race safety: two concurrent provisions must never adopt the same VM. The
 * conditional UPDATE (`state = 'available'` in the WHERE) is the lock — the
 * loser's update matches zero rows and moves on to the next candidate (or
 * returns null → caller falls back to purchase).
 */
export async function claimAvailableVps(
  plan: VpsSize,
  businessId: string,
  client?: SupabaseClient
): Promise<VpsInventoryRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: candidates, error } = await db
    .from("vps_inventory")
    .select("vm_id")
    .eq("state", "available")
    .eq("plan", plan)
    .order("acquired_at", { ascending: true })
    .limit(5);
  if (error) throw new Error(`claimAvailableVps: ${error.message}`);

  for (const candidate of (candidates as { vm_id: number }[] | null) ?? []) {
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
      notes: input.notes ?? null,
      updated_at: new Date().toISOString()
    },
    { onConflict: "vm_id" }
  );
  if (error) throw new Error(`recordVpsAssigned: ${error.message}`);
}

/**
 * Return a box to the pool after its tenant cancels. The box stays owned
 * (auto-renew off — it lapses at its paid period end unless adopted first),
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
    const { error } = await db
      .from("vps_inventory")
      .update({
        state: "available",
        assigned_business_id: null,
        assigned_at: null,
        hostinger_billing_subscription_id: input.hostingerBillingSubscriptionId ?? null,
        notes: input.notes ?? null,
        updated_at: nowIso
      })
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
