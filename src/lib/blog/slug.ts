/**
 * URL slugs for blog posts: lowercase ASCII words joined by hyphens.
 * Diacritics fold to their base letters so Spanish titles slug cleanly.
 */

export function slugifyBlogTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

/**
 * First candidate slug not already taken: the base, then `base-2`,
 * `base-3`, … `exists` is the caller's uniqueness probe (a DB lookup).
 */
export async function uniqueBlogSlug(
  title: string,
  exists: (slug: string) => Promise<boolean>
): Promise<string> {
  const base = slugifyBlogTitle(title) || "post";
  let candidate = base;
  for (let n = 2; await exists(candidate); n++) {
    candidate = `${base}-${n}`;
  }
  return candidate;
}
