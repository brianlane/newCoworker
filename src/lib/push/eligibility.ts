/**
 * Who is allowed to RECEIVE a tenant's push alerts.
 *
 * Push enrolls a DEVICE, keyed by the signed-in user id, and then fans out
 * to every live row for that business. That is the right shape for an owner
 * with two phones. It is the wrong shape for HQ view-as: `requireBusinessRole`
 * lets the platform admin past every tenant gate, and PushRegistrar silently
 * re-POSTs an already-granted subscription on every dashboard load, so one
 * "View as tenant" visit enrolled the operator's iPhone as a Kin device and
 * every later lead-tap alert landed on the HQ lock screen.
 *
 * The rule, reused at enroll time and at send time: a tenant-scoped row is
 * valid only when that user would still be allowed to subscribe, which means
 * a REAL roster role (owner_email or business_members), not the admin bypass.
 * `selfOwned` view-as (the HQ tenant, whose owner IS the admin) still passes,
 * because getBusinessRoleForEmail returns owner for that address.
 */

import { findAuthUserIdByEmail } from "@/lib/auth";
import { can, isBusinessRole } from "@/lib/authz/policy";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * Whether the dashboard should offer tenant-scoped push in this session.
 *
 * `viewAs === null` is a plain owner/teammate. `selfOwned` is the admin on
 * their own HQ tenant, which is not impersonation. Any other view-as pin is
 * the operator looking at someone else's business, and must not enroll.
 */
export function tenantPushEnrollmentAllowed(
  viewAs: { selfOwned: boolean } | null
): boolean {
  if (viewAs === null) return true;
  return viewAs.selfOwned;
}

/**
 * Which business the silent registrar should POST.
 *
 * The current dashboard pin is used only when this session is allowed to
 * enroll that tenant. Foreign view-as keeps the operator's OWN tenant
 * subscribed instead, so HQ alerts still reach the HQ phone while they
 * inspect someone else. Never pass the impersonated tenant id here.
 */
export function pushRegistrarBusinessId(input: {
  enrollCurrentTenant: boolean;
  currentBusinessId: string | null;
  ownBusinessId: string | null;
}): string | null {
  if (input.enrollCurrentTenant) return input.currentBusinessId;
  return input.ownBusinessId;
}

/**
 * Newest business this email owns. Same case-insensitive LIKE match as
 * `listAccessibleBusinesses`, including the metacharacter escape, so an
 * address with `_` cannot wildcard-match a neighbour.
 *
 * Returns null on an empty email, a missing row, or a lookup error. The
 * registrar is optional on a page render; failing closed (no enroll) is
 * safer than 500ing the dashboard because the lookup blipped.
 */
function ownerEmailIlikePattern(email: string): string {
  return email
    .trim()
    .toLowerCase()
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

export async function newestOwnedBusinessId(
  email: string | null | undefined,
  client?: SupabaseClient
): Promise<string | null> {
  const trimmed = email?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { data, error } = await db
      .from("businesses")
      .select("id")
      .ilike("owner_email", ownerEmailIlikePattern(trimmed))
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return null;
    const id = (data as { id?: string } | null)?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Enroll-time gate. Throws on a lookup error so the route can 500 rather
 * than tell a real owner "you are not a member" because of a blip.
 */
export async function callerCanEnrollTenantPush(input: {
  email: string | null;
  businessId: string;
}): Promise<boolean> {
  if (!input.email) return false;
  // Dynamic import: business-members imports revokePushSubscriptionsForUser
  // from this package's db.ts, and db.ts imports this module. A static
  // import here would cycle at load and leave pushTargetState bound to a
  // half-initialized eligibility export, which is how a mock of
  // listEligiblePushUserIds silently did nothing.
  const { getBusinessRoleForEmail } = await import("@/lib/db/business-members");
  const role = await getBusinessRoleForEmail(input.businessId, input.email);
  return role !== null && can(role, "view_dashboard");
}

/**
 * User ids that may receive this tenant's pushes right now.
 *
 * Returns `null` when the lookup cannot safely distinguish the owner from a
 * leaked admin device (owner_email set but the auth id did not resolve, or
 * any query error). Callers MUST fail open on null at send time: filtering
 * strictly would treat the owner's own phone as leaked and revoke it.
 *
 * An empty Set is a real answer: this business has no owner login and no
 * members, so nobody is eligible.
 */
export async function listEligiblePushUserIds(
  businessId: string,
  client?: SupabaseClient
): Promise<Set<string> | null> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { data: business, error: bizErr } = await db
      .from("businesses")
      .select("owner_email")
      .eq("id", businessId)
      .maybeSingle();
    if (bizErr) return null;

    const ids = new Set<string>();
    const ownerEmail = ((business as { owner_email?: string | null } | null)?.owner_email ?? "")
      .trim();
    if (ownerEmail) {
      const ownerId = await findAuthUserIdByEmail(ownerEmail);
      // Fail open: without the owner's id we cannot tell their device from
      // the operator's, and the wrong guess revokes the owner's phone.
      if (!ownerId) return null;
      ids.add(ownerId);
    }

    const { data: members, error: memErr } = await db
      .from("business_members")
      .select("user_id, role, status")
      .eq("business_id", businessId)
      .in("status", ["active", "invited"]);
    if (memErr) return null;

    for (const row of (members ?? []) as {
      user_id: string | null;
      role: string;
      status: string;
    }[]) {
      if (!row.user_id) continue;
      if (!isBusinessRole(row.role) || !can(row.role, "view_dashboard")) continue;
      ids.add(row.user_id);
    }
    return ids;
  } catch {
    return null;
  }
}

/**
 * Split live subscriptions into roster devices vs everyone else.
 *
 * `eligible === null` is a failed lookup: keep every row, leak none, so a
 * blip cannot drop the owner's alert. A Set (even empty) is authoritative.
 */
export function partitionEligiblePushRows<T extends { user_id: string }>(
  rows: T[],
  eligible: Set<string> | null
): { keep: T[]; leaked: T[] } {
  if (eligible === null) return { keep: rows, leaked: [] };
  const keep: T[] = [];
  const leaked: T[] = [];
  for (const row of rows) {
    if (eligible.has(row.user_id)) keep.push(row);
    else leaked.push(row);
  }
  return { keep, leaked };
}
