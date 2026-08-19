import en from "../../../messages/en.json";
import { buildLlmsFullTxt, type LlmsBlogPost } from "@/lib/marketing/llms-content";
import { INDUSTRIES } from "@/app/(marketing)/industries/data";
import { listPublishedPosts } from "@/lib/blog/db";

// Rendered per request so newly published posts appear without a redeploy,
// and so the CI build (mock Supabase env) never touches the DB, same
// rationale as src/app/sitemap.ts.
export const dynamic = "force-dynamic";

// The English catalog is read directly rather than through next-intl: this is
// a canonical machine-readable artifact, not a localized page, and the request
// config resolves the READER's locale (cookie/header), which would otherwise
// hand a Spanish brief to a crawler that sent Accept-Language: es. Same
// direct-import pattern as src/lib/i18n/email-copy.ts.
const INDUSTRY_COPY = en.marketing.industries as Record<
  string,
  { name: string; teaser: string }
>;

export async function GET(): Promise<Response> {
  const industries = INDUSTRIES.map((i) => ({
    slug: i.slug,
    name: INDUSTRY_COPY[i.i18nKey].name,
    teaser: INDUSTRY_COPY[i.i18nKey].teaser
  }));

  // Best-effort: a DB hiccup must not 500 the brief, it just costs the
  // article list.
  let posts: LlmsBlogPost[] = [];
  try {
    const rows = await listPublishedPosts({ limit: 25, offset: 0 });
    posts = rows.map((p) => ({ slug: p.slug, title: p.title, excerpt: p.excerpt }));
  } catch {
    posts = [];
  }

  return new Response(buildLlmsFullTxt({ posts, industries }), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400"
    }
  });
}
