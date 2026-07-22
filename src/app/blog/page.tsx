import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { PageHero } from "@/components/marketing/sections";
import { BlogPostCard } from "@/components/marketing/BlogPostCard";
import {
  BLOG_CATEGORIES,
  BLOG_PAGE_SIZE,
  countPublishedPosts,
  listPublishedCategories,
  listPublishedPosts,
  type BlogCategory
} from "@/lib/blog/db";

// DB-backed at request time: posts appear the moment they publish, and the
// build stays DB-free (CI builds with mock Supabase env).
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.blogPage");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: {
      canonical: "/blog",
      languages: { en: "/blog", es: "/es/blog" },
      types: { "application/rss+xml": "/blog/feed.xml" }
    },
    openGraph: {
      title: t("metaTitle"),
      description: t("metaDescription"),
      url: "/blog"
    }
  };
}

function parseCategory(raw: string | undefined): BlogCategory | undefined {
  return BLOG_CATEGORIES.includes(raw as BlogCategory) ? (raw as BlogCategory) : undefined;
}

export default async function BlogIndexPage({
  searchParams
}: {
  searchParams: Promise<{ category?: string; page?: string }>;
}) {
  const t = await getTranslations("marketing.blogPage");
  const locale = (await getLocale()) === "es" ? ("es" as const) : ("en" as const);
  const params = await searchParams;
  const category = parseCategory(params.category);
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const offset = (page - 1) * BLOG_PAGE_SIZE;

  const [posts, total, categories] = await Promise.all([
    listPublishedPosts({ category, limit: BLOG_PAGE_SIZE, offset }),
    countPublishedPosts(category),
    listPublishedCategories()
  ]);
  const totalPages = Math.max(1, Math.ceil(total / BLOG_PAGE_SIZE));

  // Spanish visitors stay on the /es mirror when filtering and paging —
  // an unprefixed link would bounce them back to the English URLs.
  const basePath = locale === "es" ? "/es/blog" : "/blog";
  const pageHref = (p: number) => {
    const query = new URLSearchParams();
    if (category) query.set("category", category);
    if (p > 1) query.set("page", String(p));
    const qs = query.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <PageHero
        eyebrow={t("heroEyebrow")}
        title={t("heroTitle")}
        subtitle={t("heroSubtitle")}
      />

      {categories.length > 0 && (
        <div className="mx-auto flex max-w-6xl flex-wrap justify-center gap-2 px-6 pb-10">
          <Link
            href={basePath}
            className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
              !category
                ? "bg-claw-green text-deep-ink"
                : "border border-parchment/15 text-parchment/70 hover:bg-parchment/5"
            }`}
          >
            {t("allPosts")}
          </Link>
          {categories.map((c) => (
            <Link
              key={c}
              href={`${basePath}?category=${c}`}
              className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
                category === c
                  ? "bg-claw-green text-deep-ink"
                  : "border border-parchment/15 text-parchment/70 hover:bg-parchment/5"
              }`}
            >
              {t(`categories.${c}`)}
            </Link>
          ))}
        </div>
      )}

      <section className="mx-auto max-w-6xl px-6 pb-20">
        {posts.length === 0 ? (
          <div className="py-16 text-center">
            <h2 className="text-xl font-semibold text-parchment">{t("emptyTitle")}</h2>
            <p className="mt-2 text-parchment/55">{t("emptyBody")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {posts.map((post) => (
              <BlogPostCard
                key={post.id}
                post={post}
                locale={locale}
                categoryLabel={t(`categories.${post.category}`)}
                readLabel={t("readPost")}
              />
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <nav className="mt-12 flex items-center justify-center gap-6 text-sm">
            {page > 1 ? (
              <Link href={pageHref(page - 1)} className="text-signal-teal hover:underline">
                ← {t("newerPosts")}
              </Link>
            ) : (
              <span className="text-parchment/25">← {t("newerPosts")}</span>
            )}
            <span className="text-parchment/50">
              {page} / {totalPages}
            </span>
            {page < totalPages ? (
              <Link href={pageHref(page + 1)} className="text-signal-teal hover:underline">
                {t("olderPosts")} →
              </Link>
            ) : (
              <span className="text-parchment/25">{t("olderPosts")} →</span>
            )}
          </nav>
        )}
      </section>

      <MarketingFooter />
    </div>
  );
}
