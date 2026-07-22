import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { JsonLd } from "@/components/marketing/JsonLd";
import { BlogPostCard } from "@/components/marketing/BlogPostCard";
import { BlogShareButtons } from "@/components/marketing/BlogShareButtons";
import { BlogSubscribeForm } from "@/components/marketing/BlogSubscribeForm";
import {
  blogImagePublicUrl,
  getPublishedPostBySlug,
  listRelatedPosts
} from "@/lib/blog/db";
import { renderMarkdown } from "@/lib/blog/markdown";

// DB-backed at request time: posts appear the moment they publish, and the
// build stays DB-free (CI builds with mock Supabase env).
export const dynamic = "force-dynamic";

const SITE_URL = "https://www.newcoworker.com";

export async function generateMetadata({
  params
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPublishedPostBySlug(slug);
  if (!post) return {};
  const locale = (await getLocale()) === "es" ? "es" : "en";
  const translated = locale === "es" && post.title_es;
  const title = translated ? (post.title_es as string) : post.title;
  const description = (translated ? (post.excerpt_es ?? post.excerpt) : post.excerpt).slice(
    0,
    155
  );
  const imageUrl = blogImagePublicUrl(post.featured_image_path);
  return {
    title: `${title} — New Coworker`,
    description,
    alternates: {
      canonical: translated ? `/es/blog/${post.slug}` : `/blog/${post.slug}`,
      languages: {
        en: `/blog/${post.slug}`,
        // Advertise the Spanish mirror only when a translation exists.
        ...(post.title_es ? { es: `/es/blog/${post.slug}` } : {})
      }
    },
    openGraph: {
      title,
      description,
      type: "article",
      url: `/blog/${post.slug}`,
      ...(post.published_at ? { publishedTime: post.published_at } : {}),
      ...(imageUrl ? { images: [{ url: imageUrl }] } : {})
    },
    twitter: {
      card: imageUrl ? "summary_large_image" : "summary",
      title,
      description,
      ...(imageUrl ? { images: [imageUrl] } : {})
    }
  };
}

const ARTICLE_STYLES = [
  "leading-relaxed text-parchment/75",
  "[&_h1]:mt-10 [&_h1]:mb-4 [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:text-parchment",
  "[&_h2]:mt-10 [&_h2]:mb-4 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:text-parchment",
  "[&_h3]:mt-8 [&_h3]:mb-3 [&_h3]:text-xl [&_h3]:font-semibold [&_h3]:text-parchment",
  "[&_h4]:mt-6 [&_h4]:mb-2 [&_h4]:font-semibold [&_h4]:text-parchment",
  "[&_h5]:mt-6 [&_h5]:mb-2 [&_h5]:font-semibold [&_h5]:text-parchment",
  "[&_h6]:mt-6 [&_h6]:mb-2 [&_h6]:font-semibold [&_h6]:text-parchment",
  "[&_p]:my-4",
  "[&_a]:text-signal-teal [&_a]:underline-offset-2 hover:[&_a]:underline",
  "[&_strong]:text-parchment",
  "[&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-6",
  "[&_li]:my-1.5",
  "[&_blockquote]:my-6 [&_blockquote]:border-l-4 [&_blockquote]:border-claw-green/50 [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-parchment/60",
  "[&_pre]:my-6 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black/40 [&_pre]:p-4 [&_pre]:text-sm",
  "[&_code]:rounded [&_code]:bg-black/40 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sm [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_img]:my-6 [&_img]:rounded-lg",
  "[&_hr]:my-8 [&_hr]:border-parchment/15"
].join(" ");

export default async function BlogPostPage({
  params
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await getPublishedPostBySlug(slug);
  if (!post) notFound();

  const t = await getTranslations("marketing.blogPage");
  const locale = (await getLocale()) === "es" ? ("es" as const) : ("en" as const);
  const translated = locale === "es" && post.title_es;
  const title = translated ? (post.title_es as string) : post.title;
  const excerpt = translated ? (post.excerpt_es ?? post.excerpt) : post.excerpt;
  const content = translated ? (post.content_es ?? post.content) : post.content;
  const imageUrl = blogImagePublicUrl(post.featured_image_path);
  const canonicalUrl = `${SITE_URL}${locale === "es" && post.title_es ? "/es" : ""}/blog/${post.slug}`;
  const publishedDate = post.published_at
    ? new Date(post.published_at).toLocaleDateString(locale === "es" ? "es-US" : "en-US", {
        year: "numeric",
        month: "long",
        day: "numeric"
      })
    : null;

  const related = await listRelatedPosts(post.category, post.id, 3);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description: excerpt.slice(0, 155),
    ...(post.published_at ? { datePublished: post.published_at } : {}),
    dateModified: post.updated_at,
    ...(imageUrl ? { image: [imageUrl] } : {}),
    author: { "@type": "Organization", name: post.author_name, url: SITE_URL },
    publisher: { "@type": "Organization", name: "New Coworker", url: SITE_URL },
    mainEntityOfPage: canonicalUrl
  };

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />
      <JsonLd data={jsonLd} />

      <article className="mx-auto max-w-3xl px-6 pb-16 pt-14">
        <nav className="mb-8 text-sm">
          <Link
            href={locale === "es" ? "/es/blog" : "/blog"}
            className="text-signal-teal hover:underline"
          >
            ← {t("backToBlog")}
          </Link>
        </nav>

        <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-parchment/45">
          <span className="rounded-full border border-claw-green/40 px-2.5 py-0.5 text-claw-green">
            {t(`categories.${post.category}`)}
          </span>
          {publishedDate && (
            <time dateTime={post.published_at ?? undefined}>{publishedDate}</time>
          )}
          <span>{post.author_name}</span>
        </div>

        <h1 className="text-3xl font-bold leading-tight text-parchment lg:text-4xl">{title}</h1>
        <p className="mt-4 border-l-4 border-claw-green/50 pl-4 text-lg italic text-parchment/60">
          {excerpt}
        </p>

        {imageUrl && (
          /* eslint-disable-next-line @next/next/no-img-element -- remote Supabase storage image */
          <img
            src={imageUrl}
            alt={post.featured_image_alt ?? title}
            className="mt-8 aspect-video w-full rounded-xl object-cover"
          />
        )}

        <div
          className={`mt-8 ${ARTICLE_STYLES}`}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
        />

        <div className="mt-12 border-t border-parchment/10 pt-8">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-parchment/50">
            {t("sharePost")}
          </h2>
          <BlogShareButtons
            url={canonicalUrl}
            title={title}
            labels={{
              x: t("shareOnX"),
              linkedin: t("shareOnLinkedIn"),
              copy: t("copyLink"),
              copied: t("linkCopied")
            }}
          />
        </div>

        <div className="mt-12 rounded-xl border border-parchment/10 bg-parchment/[0.02] p-6">
          <h2 className="text-lg font-semibold text-parchment">{t("subscribeTitle")}</h2>
          <p className="mt-1 text-sm text-parchment/55">{t("subscribeBody")}</p>
          <BlogSubscribeForm
            locale={locale}
            labels={{
              placeholder: t("subscribePlaceholder"),
              button: t("subscribeButton"),
              success: t("subscribeSuccess"),
              error: t("subscribeError")
            }}
          />
        </div>
      </article>

      {related.length > 0 && (
        <section className="mx-auto max-w-6xl px-6 pb-20">
          <h2 className="mb-6 text-xl font-semibold text-parchment">{t("relatedPosts")}</h2>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {related.map((r) => (
              <BlogPostCard
                key={r.id}
                post={r}
                locale={locale}
                categoryLabel={t(`categories.${r.category}`)}
                readLabel={t("readPost")}
              />
            ))}
          </div>
        </section>
      )}

      <MarketingFooter />
    </div>
  );
}
