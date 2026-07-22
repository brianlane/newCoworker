/**
 * Client-safe blog vocabulary: types, constants, and the public image URL
 * builder. No server-only imports — the admin editor (a client component)
 * pulls these; DB access stays in ./db.ts (which re-exports everything
 * here for server callers).
 */

export type BlogPostStatus = "draft" | "scheduled" | "published";

export const BLOG_CATEGORIES = [
  "feature",
  "tutorial",
  "announcement",
  "business-tips",
  "spotlight",
  "platform-updates"
] as const;

export type BlogCategory = (typeof BLOG_CATEGORIES)[number];

export type BlogPostRow = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  title_es: string | null;
  excerpt_es: string | null;
  content_es: string | null;
  category: BlogCategory;
  author_name: string;
  status: BlogPostStatus;
  published_at: string | null;
  scheduled_for: string | null;
  /** Storage path within the public blog-images bucket. */
  featured_image_path: string | null;
  featured_image_alt: string | null;
  source: "manual" | "weekly_digest";
  digest_week: string | null;
  created_at: string;
  updated_at: string;
};

export type BlogSettingsRow = {
  digest_enabled: boolean;
  digest_as_draft: boolean;
  digest_include_image: boolean;
  /** Weekly rotation: tutorial week enabled (falls back to the digest when off). */
  auto_tutorial_enabled: boolean;
  /** Weekly rotation: business-tips week enabled. */
  auto_business_tips_enabled: boolean;
  /** Weekly rotation: feature deep-dive week enabled. */
  auto_feature_enabled: boolean;
  instagram_business_id: string | null;
  instagram_publish_immediately: boolean;
};

export type BlogSubscriberRow = {
  id: string;
  email: string;
  locale: "en" | "es";
  unsubscribe_token: string;
  created_at: string;
  unsubscribed_at: string | null;
};

export const BLOG_IMAGES_BUCKET = "blog-images";

/** Posts per page on the public index. */
export const BLOG_PAGE_SIZE = 9;

/**
 * Public URL of a featured image in the blog-images bucket (the bucket is
 * public — the marketing site serves it directly and Meta downloads it for
 * Instagram cross-posts). Null when the path is empty.
 */
export function blogImagePublicUrl(path: string | null): string | null {
  if (!path) return null;
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
  return `${base}/storage/v1/object/public/${BLOG_IMAGES_BUCKET}/${path}`;
}
