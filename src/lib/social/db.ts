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
  ig_media_id: string | null;
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
    | "ig_media_id"
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
 * Posts stuck mid-publish past the stale window (a sweep crash between the
 * promotion and the outcome stamp). Re-marked failed by the sweep rather
 * than retried: Meta may have already published the container, and a
 * duplicate feed post is worse than a manual retry.
 */
export async function listStalePublishingPosts(
  cutoffIso: string,
  client?: SupabaseClient
): Promise<SocialPostRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("social_posts")
    .select()
    .eq("status", "publishing")
    .lte("started_at", cutoffIso)
    .order("started_at", { ascending: true })
    .limit(20);
  if (error) throw new Error(`listStalePublishingPosts: ${error.message}`);
  return (data ?? []) as SocialPostRow[];
}
