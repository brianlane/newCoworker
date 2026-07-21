/**
 * Platform blog — DB access.
 *
 * `blog_posts` / `blog_settings` / `blog_subscribers` are service-role-only
 * (RLS on, no policies) — every access flows through the Next.js server
 * after its own auth checks, matching social_posts / email_campaigns.
 * Public pages read published rows server-side; admin CRUD sits behind
 * requireAdmin.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type {
  BlogCategory,
  BlogPostRow,
  BlogPostStatus,
  BlogSettingsRow,
  BlogSubscriberRow
} from "./shared";
import { BLOG_CATEGORIES } from "./shared";

// Client-safe vocabulary lives in ./shared.ts (no next/headers there); the
// server-side callers keep importing everything from this module.
export * from "./shared";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * Unconditional-await client resolution keeps v8 branch accounting honest
 * (same rationale as src/lib/db/contact-form-sink.ts).
 */
async function resolveClient(client?: SupabaseClient): Promise<SupabaseClient> {
  return client ?? (await createSupabaseServiceClient());
}

// --------------------------------------------------------------------------
// Public reads (published posts only)
// --------------------------------------------------------------------------

export async function listPublishedPosts(
  opts: { category?: BlogCategory; limit: number; offset: number },
  client?: SupabaseClient
): Promise<BlogPostRow[]> {
  const db = await resolveClient(client);
  let query = db
    .from("blog_posts")
    .select()
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .range(opts.offset, opts.offset + opts.limit - 1);
  if (opts.category) query = query.eq("category", opts.category);
  const { data, error } = await query;
  if (error) throw new Error(`listPublishedPosts: ${error.message}`);
  return (data ?? []) as BlogPostRow[];
}

export async function countPublishedPosts(
  category?: BlogCategory,
  client?: SupabaseClient
): Promise<number> {
  const db = await resolveClient(client);
  let query = db
    .from("blog_posts")
    .select("id", { count: "exact", head: true })
    .eq("status", "published");
  if (category) query = query.eq("category", category);
  const { count, error } = await query;
  if (error) throw new Error(`countPublishedPosts: ${error.message}`);
  return count ?? 0;
}

/** Distinct categories that currently have a published post (filter pills). */
export async function listPublishedCategories(
  client?: SupabaseClient
): Promise<BlogCategory[]> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("blog_posts")
    .select("category")
    .eq("status", "published");
  if (error) throw new Error(`listPublishedCategories: ${error.message}`);
  const seen = new Set<BlogCategory>();
  for (const row of (data ?? []) as Array<{ category: BlogCategory }>) {
    seen.add(row.category);
  }
  return BLOG_CATEGORIES.filter((c) => seen.has(c));
}

export async function getPublishedPostBySlug(
  slug: string,
  client?: SupabaseClient
): Promise<BlogPostRow | null> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("blog_posts")
    .select()
    .eq("status", "published")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(`getPublishedPostBySlug: ${error.message}`);
  return (data as BlogPostRow | null) ?? null;
}

/** Recent published posts in the same category, excluding the current one. */
export async function listRelatedPosts(
  category: BlogCategory,
  excludeId: string,
  limit: number,
  client?: SupabaseClient
): Promise<BlogPostRow[]> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("blog_posts")
    .select()
    .eq("status", "published")
    .eq("category", category)
    .neq("id", excludeId)
    .order("published_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listRelatedPosts: ${error.message}`);
  return (data ?? []) as BlogPostRow[];
}

// --------------------------------------------------------------------------
// Admin CRUD
// --------------------------------------------------------------------------

export async function listPostsAdmin(client?: SupabaseClient): Promise<BlogPostRow[]> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("blog_posts")
    .select()
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listPostsAdmin: ${error.message}`);
  return (data ?? []) as BlogPostRow[];
}

/** Any-status slug probe (uniqueness check when creating/renaming posts). */
export async function blogSlugExists(slug: string, client?: SupabaseClient): Promise<boolean> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("blog_posts")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(`blogSlugExists: ${error.message}`);
  return data !== null;
}

export async function getBlogPost(
  postId: string,
  client?: SupabaseClient
): Promise<BlogPostRow | null> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("blog_posts")
    .select()
    .eq("id", postId)
    .maybeSingle();
  if (error) throw new Error(`getBlogPost: ${error.message}`);
  return (data as BlogPostRow | null) ?? null;
}

export type BlogPostInsert = Pick<BlogPostRow, "slug" | "title"> &
  Partial<
    Pick<
      BlogPostRow,
      | "excerpt"
      | "content"
      | "title_es"
      | "excerpt_es"
      | "content_es"
      | "category"
      | "author_name"
      | "status"
      | "published_at"
      | "scheduled_for"
      | "featured_image_path"
      | "featured_image_alt"
      | "source"
      | "digest_week"
    >
  >;

export async function insertBlogPost(
  row: BlogPostInsert,
  client?: SupabaseClient
): Promise<BlogPostRow> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("blog_posts")
    .insert({ ...row })
    .select()
    .single();
  if (error) throw new Error(`insertBlogPost: ${error.message}`);
  return data as BlogPostRow;
}

export type BlogPostPatch = Partial<Omit<BlogPostRow, "id" | "created_at" | "updated_at">>;

export async function patchBlogPost(
  postId: string,
  patch: BlogPostPatch,
  client?: SupabaseClient
): Promise<void> {
  const db = await resolveClient(client);
  const { error } = await db
    .from("blog_posts")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", postId);
  if (error) throw new Error(`patchBlogPost: ${error.message}`);
}

export async function deleteBlogPost(postId: string, client?: SupabaseClient): Promise<void> {
  const db = await resolveClient(client);
  const { error } = await db.from("blog_posts").delete().eq("id", postId);
  if (error) throw new Error(`deleteBlogPost: ${error.message}`);
}

// --------------------------------------------------------------------------
// Publish sweep
// --------------------------------------------------------------------------

/** Scheduled posts whose publish time has passed, oldest first. */
export async function listDueScheduledBlogPosts(
  nowIso: string,
  client?: SupabaseClient
): Promise<BlogPostRow[]> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("blog_posts")
    .select()
    .eq("status", "scheduled")
    .lte("scheduled_for", nowIso)
    .order("scheduled_for", { ascending: true })
    .limit(20);
  if (error) throw new Error(`listDueScheduledBlogPosts: ${error.message}`);
  return (data ?? []) as BlogPostRow[];
}

/**
 * Guarded lifecycle transition: applies `patch` only while the post is
 * still in `fromStatus`. Returns whether a row actually moved — the
 * sweep's promotion and an admin edit both race through here, and the
 * loser must see "no rows" instead of clobbering.
 */
export async function transitionBlogPost(
  postId: string,
  fromStatus: BlogPostStatus,
  patch: BlogPostPatch,
  client?: SupabaseClient
): Promise<boolean> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("blog_posts")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", postId)
    .eq("status", fromStatus)
    .select("id");
  if (error) throw new Error(`transitionBlogPost: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/** Weekly-digest idempotency probe. */
export async function getPostByDigestWeek(
  digestWeek: string,
  client?: SupabaseClient
): Promise<BlogPostRow | null> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("blog_posts")
    .select()
    .eq("digest_week", digestWeek)
    .maybeSingle();
  if (error) throw new Error(`getPostByDigestWeek: ${error.message}`);
  return (data as BlogPostRow | null) ?? null;
}

// --------------------------------------------------------------------------
// Settings (single fixed row)
// --------------------------------------------------------------------------

export const DEFAULT_BLOG_SETTINGS: BlogSettingsRow = {
  digest_enabled: true,
  digest_as_draft: false,
  digest_include_image: true,
  instagram_business_id: null,
  instagram_publish_immediately: false
};

export async function getBlogSettings(client?: SupabaseClient): Promise<BlogSettingsRow> {
  const db = await resolveClient(client);
  const { data, error } = await db.from("blog_settings").select().eq("id", true).maybeSingle();
  if (error) throw new Error(`getBlogSettings: ${error.message}`);
  if (!data) return { ...DEFAULT_BLOG_SETTINGS };
  const row = data as BlogSettingsRow;
  return {
    digest_enabled: row.digest_enabled,
    digest_as_draft: row.digest_as_draft,
    digest_include_image: row.digest_include_image,
    instagram_business_id: row.instagram_business_id,
    instagram_publish_immediately: row.instagram_publish_immediately
  };
}

export async function updateBlogSettings(
  patch: Partial<BlogSettingsRow>,
  client?: SupabaseClient
): Promise<void> {
  const db = await resolveClient(client);
  const { error } = await db
    .from("blog_settings")
    .upsert({ id: true, ...patch, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw new Error(`updateBlogSettings: ${error.message}`);
}

// --------------------------------------------------------------------------
// Subscribers
// --------------------------------------------------------------------------

/**
 * Subscribe (or re-subscribe) an email. Upsert keyed on the unique email:
 * a returning unsubscriber gets their `unsubscribed_at` cleared and locale
 * refreshed; the original unsubscribe token is replaced.
 */
export async function upsertBlogSubscriber(
  email: string,
  locale: "en" | "es",
  unsubscribeToken: string,
  client?: SupabaseClient
): Promise<void> {
  const db = await resolveClient(client);
  const { error } = await db.from("blog_subscribers").upsert(
    {
      email,
      locale,
      unsubscribe_token: unsubscribeToken,
      unsubscribed_at: null
    },
    { onConflict: "email" }
  );
  if (error) throw new Error(`upsertBlogSubscriber: ${error.message}`);
}

/** Returns whether a subscriber row matched the token. */
export async function unsubscribeBlogSubscriberByToken(
  token: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("blog_subscribers")
    .update({ unsubscribed_at: new Date().toISOString() })
    .eq("unsubscribe_token", token)
    .select("id");
  if (error) throw new Error(`unsubscribeBlogSubscriberByToken: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

export async function listActiveBlogSubscribers(
  client?: SupabaseClient
): Promise<BlogSubscriberRow[]> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("blog_subscribers")
    .select()
    .is("unsubscribed_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listActiveBlogSubscribers: ${error.message}`);
  return (data ?? []) as BlogSubscriberRow[];
}
