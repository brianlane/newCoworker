import Link from "next/link";
import type { BlogPostRow } from "@/lib/blog/shared";
import { blogImagePublicUrl } from "@/lib/blog/shared";

/**
 * One card on the /blog index grid. Spanish visitors get the translated
 * title/excerpt when the post carries one, English otherwise.
 */
export function BlogPostCard({
  post,
  locale,
  categoryLabel,
  readLabel
}: {
  post: BlogPostRow;
  locale: "en" | "es";
  categoryLabel: string;
  readLabel: string;
}) {
  const title = locale === "es" && post.title_es ? post.title_es : post.title;
  const excerpt = locale === "es" && post.excerpt_es ? post.excerpt_es : post.excerpt;
  const href = locale === "es" ? `/es/blog/${post.slug}` : `/blog/${post.slug}`;
  const imageUrl = blogImagePublicUrl(post.featured_image_path);
  const publishedDate = post.published_at
    ? new Date(post.published_at).toLocaleDateString(locale === "es" ? "es-US" : "en-US", {
        year: "numeric",
        month: "long",
        day: "numeric"
      })
    : null;

  return (
    <article className="flex flex-col overflow-hidden rounded-xl border border-parchment/10 bg-parchment/[0.02] transition-colors hover:border-parchment/25">
      {imageUrl && (
        <Link href={href} className="block">
          {/* eslint-disable-next-line @next/next/no-img-element -- remote Supabase storage image */}
          <img
            src={imageUrl}
            alt={post.featured_image_alt ?? title}
            loading="lazy"
            className="aspect-video w-full object-cover"
          />
        </Link>
      )}
      <div className="flex flex-1 flex-col p-6">
        <div className="mb-3 flex items-center gap-3 text-xs text-parchment/45">
          <span className="rounded-full border border-claw-green/40 px-2.5 py-0.5 text-claw-green">
            {categoryLabel}
          </span>
          {publishedDate && <time dateTime={post.published_at ?? undefined}>{publishedDate}</time>}
        </div>
        <h2 className="text-lg font-semibold leading-snug text-parchment">
          <Link href={href} className="hover:text-claw-green">
            {title}
          </Link>
        </h2>
        <p className="mt-2 flex-1 text-sm leading-relaxed text-parchment/55">{excerpt}</p>
        <Link href={href} className="mt-4 text-sm text-signal-teal hover:underline">
          {readLabel} →
        </Link>
      </div>
    </article>
  );
}
