/**
 * RSS 2.0 feed of the 20 most recent published blog posts.
 */

import { listPublishedPostsIsr } from "@/lib/blog/public-isr";
import { markdownToPlainText } from "@/lib/blog/markdown";
import { SITE_URL } from "@/lib/marketing/site-url";

// ISR aligns with the blog index/post pages. Cache-Control below still lets
// CDNs hold the feed briefly. public-isr keeps CI builds DB-free.
export const revalidate = 60;


function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET(): Promise<Response> {
  const posts = await listPublishedPostsIsr({ limit: 20, offset: 0 });

  const items = posts
    .map((post) => {
      const url = `${SITE_URL}/blog/${post.slug}`;
      const description = xmlEscape(markdownToPlainText(post.excerpt));
      const pubDate = post.published_at ? new Date(post.published_at).toUTCString() : "";
      return [
        "    <item>",
        `      <title>${xmlEscape(post.title)}</title>`,
        `      <link>${url}</link>`,
        `      <guid isPermaLink="true">${url}</guid>`,
        `      <description>${description}</description>`,
        `      <category>${xmlEscape(post.category)}</category>`,
        ...(pubDate ? [`      <pubDate>${pubDate}</pubDate>`] : []),
        "    </item>"
      ].join("\n");
    })
    .join("\n");

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    "    <title>New Coworker Blog</title>",
    `    <link>${SITE_URL}/blog</link>`,
    "    <description>Feature announcements, tutorials, and practical tips for putting your AI coworker to work.</description>",
    "    <language>en</language>",
    `    <atom:link href="${SITE_URL}/blog/feed.xml" rel="self" type="application/rss+xml" />`,
    items,
    "  </channel>",
    "</rss>"
  ].join("\n");

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300"
    }
  });
}
