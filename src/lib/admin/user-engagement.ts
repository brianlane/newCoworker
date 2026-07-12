/**
 * Platform-user engagement for the admin — the BizBlasts users-admin
 * "Daily Active Users Analytics" panel (DAU/WAU/MAU + engagement rate +
 * per-user last-sign-in table) ported to newCoworker's shape: Supabase auth
 * `last_sign_in_at` stands in for BizBlasts' Devise `last_sign_in_at`, and
 * the recency bands reuse the tenant-facing contact segmentation
 * (src/lib/analytics/engagement.ts) so "quiet" means the same thing on both
 * surfaces.
 *
 * Pure — the /admin/engagement page fetches auth users + businesses +
 * members and passes them in.
 */

import {
  classifyEngagement,
  type EngagementSegment
} from "@/lib/analytics/engagement";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

import type { PlatformAuthUser } from "@/lib/admin/engagement-summary";

export type { EngagementSegment };
// Re-exported so existing server-side callers keep one import site; the
// browser-safe summary math lives in engagement-summary.ts.
export type { PlatformAuthUser, UserEngagementSummary } from "@/lib/admin/engagement-summary";
export { summarizeUserEngagement } from "@/lib/admin/engagement-summary";

export type EngagementBusinessRef = {
  id: string;
  name: string;
  owner_email: string;
  created_at: string;
};

export type EngagementMemberRef = {
  business_id: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
};

export type UserEngagementRow = {
  email: string;
  businessId: string | null;
  businessName: string | null;
  /** `owner` | member role (`manager`/`staff`) | `none` (no business link). */
  role: string;
  /** Auth account creation, or the invite date for never-signed-up members. */
  createdAt: string;
  lastSignInAt: string | null;
  segment: EngagementSegment;
};

/** Pagination bounds for the auth-directory scan — far above current fleet size. */
export const AUTH_USERS_PAGE_CAP = 20;
export const AUTH_USERS_PER_PAGE = 500;

export type PlatformAuthUsersResult = {
  users: PlatformAuthUser[];
  /**
   * True when the scan filled its page cap — the directory is PARTIAL and
   * recency data for uncollected users is missing. Callers must degrade
   * (hide churn badges / show a truncation notice) rather than mis-segment
   * users past the cap as never-signed-in.
   */
  clipped: boolean;
};

/**
 * The whole Supabase auth directory (email + created + last sign-in),
 * paginated up to {@link AUTH_USERS_PAGE_CAP} pages. Email-less users
 * (phone-only rows, if any ever exist) are skipped — engagement is keyed
 * on email everywhere else.
 */
export async function listPlatformAuthUsers(
  client?: SupabaseClient
): Promise<PlatformAuthUsersResult> {
  const db = client ?? (await createSupabaseServiceClient());
  const users: PlatformAuthUser[] = [];
  let clipped = true;
  for (let page = 1; page <= AUTH_USERS_PAGE_CAP; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({
      page,
      perPage: AUTH_USERS_PER_PAGE
    });
    if (error) throw new Error(`listPlatformAuthUsers: ${error.message}`);
    const batch = data?.users ?? [];
    for (const user of batch) {
      if (!user.email) continue;
      users.push({
        email: user.email,
        created_at: user.created_at,
        last_sign_in_at: user.last_sign_in_at ?? null
      });
    }
    if (batch.length < AUTH_USERS_PER_PAGE) {
      clipped = false;
      break;
    }
  }
  return { users, clipped };
}

function segmentFor(
  createdAt: string,
  lastSignInAt: string | null,
  now: Date
): EngagementSegment {
  return classifyEngagement(
    { created_at: createdAt, last_interaction_at: lastSignInAt },
    now
  );
}

/**
 * One row per (user × business relationship): every owner and every
 * non-revoked team member, plus auth users attached to no business at all.
 * Members who never created an auth account still get a row (the invite IS
 * the grant) keyed on the membership's own dates.
 */
export function buildUserEngagementRows(
  params: {
    users: PlatformAuthUser[];
    businesses: EngagementBusinessRef[];
    members: EngagementMemberRef[];
  },
  now: Date = new Date()
): UserEngagementRow[] {
  const usersByEmail = new Map<string, PlatformAuthUser>();
  for (const user of params.users) {
    usersByEmail.set(user.email.toLowerCase(), user);
  }
  const businessById = new Map(params.businesses.map((b) => [b.id, b]));

  const rows: UserEngagementRow[] = [];
  const linkedEmails = new Set<string>();

  for (const business of params.businesses) {
    const email = business.owner_email.trim().toLowerCase();
    if (!email) continue;
    linkedEmails.add(email);
    const user = usersByEmail.get(email) ?? null;
    const createdAt = user?.created_at ?? business.created_at;
    const lastSignInAt = user?.last_sign_in_at ?? null;
    rows.push({
      email,
      businessId: business.id,
      businessName: business.name,
      role: "owner",
      createdAt,
      lastSignInAt,
      segment: segmentFor(createdAt, lastSignInAt, now)
    });
  }

  for (const member of params.members) {
    if (member.status === "revoked") continue;
    const email = member.email.trim().toLowerCase();
    linkedEmails.add(email);
    const user = usersByEmail.get(email) ?? null;
    const business = businessById.get(member.business_id) ?? null;
    const createdAt = user?.created_at ?? member.created_at;
    const lastSignInAt = user?.last_sign_in_at ?? null;
    rows.push({
      email,
      businessId: member.business_id,
      businessName: business?.name ?? null,
      role: member.role,
      createdAt,
      lastSignInAt,
      segment: segmentFor(createdAt, lastSignInAt, now)
    });
  }

  for (const user of params.users) {
    const email = user.email.toLowerCase();
    if (linkedEmails.has(email)) continue;
    rows.push({
      email,
      businessId: null,
      businessName: null,
      role: "none",
      createdAt: user.created_at,
      lastSignInAt: user.last_sign_in_at,
      segment: segmentFor(user.created_at, user.last_sign_in_at, now)
    });
  }

  // Most recently signed-in first; never-signed-in rows last.
  return rows.sort((a, b) => {
    const am = a.lastSignInAt ? Date.parse(a.lastSignInAt) : Number.NEGATIVE_INFINITY;
    const bm = b.lastSignInAt ? Date.parse(b.lastSignInAt) : Number.NEGATIVE_INFINITY;
    return bm - am;
  });
}

/**
 * Businesses whose OWNER row landed in the quiet band — the churn-risk set
 * badged on the admin clients table.
 */
export function quietOwnerBusinessIds(rows: UserEngagementRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.role === "owner" && row.segment === "quiet" && row.businessId) {
      ids.add(row.businessId);
    }
  }
  return ids;
}
