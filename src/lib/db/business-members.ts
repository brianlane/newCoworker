/**
 * Team access — DB layer for business_members (see migration
 * 20260808000000_business_members.sql).
 *
 * A row grants one email a `manager`/`staff` role on one business. The
 * business's `owner_email` login is the implicit OWNER and never has a row
 * here. Service-role only — authorization is the API route's job
 * (`requireBusinessRole` before any call here).
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { BusinessRole, MemberRole } from "@/lib/authz/policy";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type BusinessMemberStatus = "invited" | "active" | "revoked";

export type BusinessMemberRow = {
  id: string;
  business_id: string;
  email: string;
  user_id: string | null;
  role: MemberRole;
  status: BusinessMemberStatus;
  invited_by: string;
  employee_id: string | null;
  created_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
};

/** Sanity cap so a compromised manager account can't spam-invite forever. */
export const MAX_MEMBERS_PER_BUSINESS = 25;

const COLUMNS =
  "id,business_id,email,user_id,role,status,invited_by,employee_id,created_at,accepted_at,revoked_at";

export async function listBusinessMembers(
  businessId: string,
  client?: SupabaseClient
): Promise<BusinessMemberRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_members")
    .select(COLUMNS)
    .eq("business_id", businessId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listBusinessMembers: ${error.message}`);
  return (data ?? []) as unknown as BusinessMemberRow[];
}

export async function getBusinessMember(
  businessId: string,
  memberId: string,
  client?: SupabaseClient
): Promise<BusinessMemberRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_members")
    .select(COLUMNS)
    .eq("business_id", businessId)
    .eq("id", memberId)
    .maybeSingle();
  if (error) throw new Error(`getBusinessMember: ${error.message}`);
  return (data as unknown as BusinessMemberRow | null) ?? null;
}

export class BusinessMemberConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusinessMemberConflictError";
  }
}

/**
 * Invite (or RE-invite) `email` to a business. One row per (business,
 * lower(email)) — inviting an address that already has a REVOKED row flips
 * it back to `invited` with the new role; an existing invited/active row is
 * a conflict (change the role via updateBusinessMemberRole instead).
 */
export async function inviteBusinessMember(
  data: {
    businessId: string;
    email: string;
    role: MemberRole;
    invitedBy: string;
    employeeId?: string | null;
  },
  client?: SupabaseClient
): Promise<BusinessMemberRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const email = data.email.trim().toLowerCase();

  const members = await listBusinessMembers(data.businessId, db);
  const existing = members.find((m) => m.email.toLowerCase() === email) ?? null;
  if (existing && existing.status !== "revoked") {
    throw new BusinessMemberConflictError(
      "That email is already on the team (change their role instead of re-inviting)"
    );
  }
  const liveCount = members.filter((m) => m.status !== "revoked").length;
  if (liveCount >= MAX_MEMBERS_PER_BUSINESS) {
    throw new BusinessMemberConflictError(
      `Team is at the ${MAX_MEMBERS_PER_BUSINESS}-member cap`
    );
  }

  if (existing) {
    const { data: row, error } = await db
      .from("business_members")
      .update({
        role: data.role,
        status: "invited",
        invited_by: data.invitedBy,
        employee_id: data.employeeId ?? null,
        revoked_at: null,
        accepted_at: null,
        user_id: null
      })
      .eq("id", existing.id)
      // Guard against a concurrent re-invite/acceptance racing this one.
      .eq("status", "revoked")
      .select(COLUMNS)
      .single();
    if (error) throw new Error(`inviteBusinessMember (re-invite): ${error.message}`);
    return row as unknown as BusinessMemberRow;
  }

  const { data: row, error } = await db
    .from("business_members")
    .insert({
      business_id: data.businessId,
      email,
      role: data.role,
      invited_by: data.invitedBy,
      employee_id: data.employeeId ?? null
    })
    .select(COLUMNS)
    .single();
  if (error) {
    // The (business_id, lower(email)) unique index closes the TOCTOU gap on
    // concurrent invites; surface it as the same conflict shape.
    if (error.message.includes("business_members_business_email_idx")) {
      throw new BusinessMemberConflictError("That email is already on the team");
    }
    throw new Error(`inviteBusinessMember: ${error.message}`);
  }
  return row as unknown as BusinessMemberRow;
}

export async function updateBusinessMemberRole(
  businessId: string,
  memberId: string,
  role: MemberRole,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_members")
    .update({ role })
    .eq("business_id", businessId)
    .eq("id", memberId)
    .neq("status", "revoked")
    .select("id");
  if (error) throw new Error(`updateBusinessMemberRole: ${error.message}`);
  return ((data as unknown[] | null) ?? []).length > 0;
}

/** Revoke access. Keeps the row for audit; re-inviting flips it back. */
export async function revokeBusinessMember(
  businessId: string,
  memberId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_members")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", memberId)
    .neq("status", "revoked")
    .select("id");
  if (error) throw new Error(`revokeBusinessMember: ${error.message}`);
  return ((data as unknown[] | null) ?? []).length > 0;
}

/**
 * First-login binding: activate every INVITED membership addressed to this
 * email (case-insensitive), stamping the auth user id. Called from the
 * dashboard layout on render (same as reconcilePendingEmailChange) — cheap
 * indexed no-op when nothing is pending. Returns how many rows flipped.
 */
export async function bindBusinessMemberUser(
  userId: string,
  email: string,
  client?: SupabaseClient
): Promise<number> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return 0;
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_members")
    .update({ user_id: userId, status: "active", accepted_at: new Date().toISOString() })
    .eq("status", "invited")
    // The column is stored lowercased by inviteBusinessMember; eq on the
    // normalized value stays index-friendly.
    .eq("email", normalized)
    .select("id");
  if (error) throw new Error(`bindBusinessMemberUser: ${error.message}`);
  return ((data as unknown[] | null) ?? []).length;
}

/**
 * Resolve the caller's role on a business: `owner` when their email is the
 * business's `owner_email`, else their ACTIVE membership role, else null.
 * Invited-but-never-logged-in rows count too (the invite email IS the
 * grant; first dashboard render binds them active).
 */
export async function getBusinessRoleForEmail(
  businessId: string,
  email: string,
  client?: SupabaseClient
): Promise<BusinessRole | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const db = client ?? (await createSupabaseServiceClient());

  const { data: business, error: bizErr } = await db
    .from("businesses")
    .select("owner_email")
    .eq("id", businessId)
    .maybeSingle();
  if (bizErr) throw new Error(`getBusinessRoleForEmail: ${bizErr.message}`);
  if (!business) return null;
  if ((business.owner_email ?? "").trim().toLowerCase() === normalized) {
    return "owner";
  }

  const { data: member, error: memErr } = await db
    .from("business_members")
    .select("role,status")
    .eq("business_id", businessId)
    .eq("email", normalized)
    .maybeSingle();
  if (memErr) throw new Error(`getBusinessRoleForEmail: ${memErr.message}`);
  if (!member || member.status === "revoked") return null;
  return member.role as BusinessRole;
}
