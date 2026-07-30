/**
 * Public blog reads that tolerate a DB-free CI/build env.
 *
 * ISR (`revalidate = 60`) prerenders at build time. CI only sets mock
 * `NEXT_PUBLIC_SUPABASE_*` keys and omits `SUPABASE_SERVICE_ROLE_KEY`, so a
 * hard throw would fail the Quality Checks build (the old reason these pages
 * were `force-dynamic`). Production always has the service role, so the
 * empty fallback never ships to visitors.
 */

import {
  countPublishedPosts,
  getPublishedPostBySlug,
  listPublishedCategories,
  listPublishedPosts,
  listRelatedPosts,
  type BlogCategory,
  type BlogPostRow
} from "@/lib/blog/db";

function serviceRoleMissing(): boolean {
  return !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
}

export async function listPublishedPostsIsr(opts: {
  category?: BlogCategory;
  limit: number;
  offset: number;
}): Promise<BlogPostRow[]> {
  if (serviceRoleMissing()) return [];
  return listPublishedPosts(opts);
}

export async function countPublishedPostsIsr(category?: BlogCategory): Promise<number> {
  if (serviceRoleMissing()) return 0;
  return countPublishedPosts(category);
}

export async function listPublishedCategoriesIsr(): Promise<BlogCategory[]> {
  if (serviceRoleMissing()) return [];
  return listPublishedCategories();
}

export async function getPublishedPostBySlugIsr(slug: string): Promise<BlogPostRow | null> {
  if (serviceRoleMissing()) return null;
  return getPublishedPostBySlug(slug);
}

export async function listRelatedPostsIsr(
  category: BlogCategory,
  excludeId: string,
  limit: number
): Promise<BlogPostRow[]> {
  if (serviceRoleMissing()) return [];
  return listRelatedPosts(category, excludeId, limit);
}
