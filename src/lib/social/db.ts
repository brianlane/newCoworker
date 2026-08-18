/**
 * Instagram posts — DB access.
 *
 * `social_posts` holds the post lifecycle (draft → scheduled → publishing →
 * published, or failed / cancelled). Service-role-only (RLS on, no
 * policies) — every access flows through the Next.js server after its own
 * auth checks, matching email_campaigns.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type SocialPostStatus =
  | "draft"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"
  | "cancelled";

export type SocialPostRow = {
  id: string;
  business_id: string;
  caption: string;
  media_url: string;
  media_type: "image";
  status: SocialPostStatus;
  publish_at: string | null;
  started_at: string | null;
  published_at: string | null;
  /** Publish step 1's container id — persisted before media_publish. */
  ig_creation_id: string | null;
  ig_media_id: string | null;
  /** The live post's public URL — fetched best-effort after publishing. */
  ig_permalink: string | null;
  /**
   * When the sweep first saw Meta report this media as gone (the owner
   * deleted the post on Instagram). Null while it is still live.
   */
  removed_at: string | null;
  removed_check_at: string | null;
  error_detail: string | null;
  created_at: string;
  updated_at: string;
};

/** Instagram's caption ceiling is 2,200 characters. */
export const SOCIAL_CAPTION_MAX_LENGTH = 2200;

export async function listSocialPosts(
  businessId: string,
  client?: SupabaseClient
): Promise<SocialPostRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("social_posts")
    .select()
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listSocialPosts: ${error.message}`);
  return (data ?? []) as SocialPostRow[];
}

export async function getSocialPost(
  businessId: string,
  postId: string,
  client?: SupabaseClient
): Promise<SocialPostRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("social_posts")
    .select()
    .eq("business_id", businessId)
    .eq("id", postId)
    .maybeSingle();
  if (error) throw new Error(`getSocialPost: ${error.message}`);
  return (data as SocialPostRow | null) ?? null;
}

export async function insertSocialPost(
  row: Pick<SocialPostRow, "business_id" | "caption" | "media_url"> &
    Partial<Pick<SocialPostRow, "status" | "publish_at">>,
  client?: SupabaseClient
): Promise<SocialPostRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("social_posts")
    .insert({ ...row })
    .select()
    .single();
  if (error) throw new Error(`insertSocialPost: ${error.message}`);
  return data as SocialPostRow;
}

export type SocialPostPatch = Partial<
  Pick<
    SocialPostRow,
    | "caption"
    | "media_url"
    | "status"
    | "publish_at"
    | "started_at"
    | "published_at"
    | "ig_creation_id"
    | "ig_media_id"
    | "ig_permalink"
    | "removed_at"
    | "removed_check_at"
    | "error_detail"
  >
>;

export async function patchSocialPost(
  businessId: string,
  postId: string,
  patch: SocialPostPatch,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("social_posts")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", postId);
  if (error) throw new Error(`patchSocialPost: ${error.message}`);
}

/**
 * Guarded lifecycle transition: applies `patch` only while the post is
 * still in `fromStatus`. Returns whether a row actually moved — the
 * sweep's scheduled→publishing promotion and the owner's cancel both race
 * through here, and the loser must see "no rows" instead of clobbering.
 */
export async function transitionSocialPost(
  businessId: string,
  postId: string,
  fromStatus: SocialPostStatus,
  patch: SocialPostPatch,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("social_posts")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", postId)
    .eq("status", fromStatus)
    .select("id");
  if (error) throw new Error(`transitionSocialPost: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/**
 * Delete a post — guarded so a row the sweep just promoted to `publishing`
 * survives (Meta may already hold its container). Returns whether a row
 * was actually deleted.
 */
export async function deleteSocialPost(
  businessId: string,
  postId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("social_posts")
    .delete()
    .eq("business_id", businessId)
    .eq("id", postId)
    .neq("status", "publishing")
    .select("id");
  if (error) throw new Error(`deleteSocialPost: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/** Posts whose publish time has passed, oldest first (sweep promotion). */
export async function listDueScheduledPosts(
  nowIso: string,
  client?: SupabaseClient
): Promise<SocialPostRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("social_posts")
    .select()
    .eq("status", "scheduled")
    .lte("publish_at", nowIso)
    .order("publish_at", { ascending: true })
    .limit(20);
  if (error) throw new Error(`listDueScheduledPosts: ${error.message}`);
  return (data ?? []) as SocialPostRow[];
}

/**
 * Every post currently mid-publish, oldest first. The sweep RESOLVES these
 * each pass — Meta's container status_code says whether the post actually
 * went live (or is ready to publish now) — rather than blind-retrying: a
 * duplicate feed post is worse than a manual retry. Rows older than the
 * stale window that still can't be resolved are dead-lettered.
 */
export async function listPublishingPosts(client?: SupabaseClient): Promise<SocialPostRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("social_posts")
    .select()
    .eq("status", "publishing")
    .order("started_at", { ascending: true })
    .limit(20);
  if (error) throw new Error(`listPublishingPosts: ${error.message}`);
  return (data ?? []) as SocialPostRow[];
}

/**
 * Published posts still believed live, newest first: the re-check pass asks
 * Meta whether each still exists.
 *
 * Bounded on BOTH ends. `publishedSinceIso` keeps the scan on a recent
 * window rather than re-polling a tenant's entire history every minute, and
 * the limit keeps one pass small. A post deleted after it falls out of the
 * window keeps its stale row: the alternative is an unbounded, ever-growing
 * poll of every post ever published, which costs more than it is worth.
 */
export async function listPublishedPostsToRecheck(
  publishedSinceIso: string,
  checkedBeforeIso: string,
  limit: number,
  client?: SupabaseClient
): Promise<SocialPostRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("social_posts")
    .select()
    .eq("status", "published")
    .is("removed_at", null)
    .not("ig_media_id", "is", null)
    .gte("published_at", publishedSinceIso)
    // Quote the ISO value: `.` and `:` are reserved in PostgREST's filter
    // grammar, so the safe form is the quoted one (same convention as
    // claimAvailableVps in src/lib/db/vps-inventory.ts).
    .or(`removed_check_at.is.null,removed_check_at.lt."${checkedBeforeIso}"`)
    .order("removed_check_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error(`listPublishedPostsToRecheck: ${error.message}`);
  return (data ?? []) as SocialPostRow[];
}
