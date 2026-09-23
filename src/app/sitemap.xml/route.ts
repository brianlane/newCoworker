import { COMPARISONS } from "@/app/(marketing)/compare/data";
import { INDUSTRIES } from "@/app/(marketing)/industries/data";
import { listPublishedPosts } from "@/lib/blog/db";
import { buildSitemap, renderSitemapXml } from "@/lib/marketing/sitemap";

/**
 * /sitemap.xml as a route handler rather than Next's metadata sitemap.ts.
 *
 * The metadata file returned 500 when the generator threw (a hung blog
 * query, a serializer error). WebFetch hit that once. A route handler can
 * catch and still return 200 XML, and it can set Cache-Control the same way
 * /robots.txt and /llms-full.txt do.
 */
export const dynamic = "force-dynamic";

const HEADERS = {
  "content-type": "application/xml; charset=utf-8",
  "cache-control": "public, max-age=3600, stale-while-revalidate=86400"
};

function ok(xml: string): Response {
  return new Response(xml, { status: 200, headers: HEADERS });
}

export async function GET(): Promise<Response> {
  try {
    const entries = await buildSitemap({
      listPosts: () => listPublishedPosts({ limit: 500, offset: 0 }),
      industrySlugs: INDUSTRIES.map((i) => i.slug),
      compareSlugs: COMPARISONS.map((c) => c.slug)
    });
    return ok(renderSitemapXml(entries));
  } catch {
    return ok(renderSitemapXml(await buildSitemap()));
  }
}
