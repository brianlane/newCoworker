/**
 * Subscriber newsletter: a new post went live on the New Coworker blog.
 *
 * The email IS the newsletter, the full post body (markdown → the blog's
 * own escape-first renderer) is embedded in the branded shell with inline,
 * email-client-safe styles, followed by a "Read on the blog" CTA. Sent by
 * the blog publish pipeline (src/lib/blog/publish.ts) to every active
 * blog_subscribers row. Deterministic and input-pure: no DB reads, no
 * Date.now(), no env lookups.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { renderMarkdown, markdownToPlainText } from "@/lib/blog/markdown";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";

export type BlogNewPostInput = {
  title: string;
  excerpt: string;
  /** Full post body, markdown, rendered into the email. */
  content: string;
  slug: string;
  recipientEmail: string;
  /** App origin without trailing slash (e.g. https://www.newcoworker.com). */
  siteUrl: string;
  /** Recipient's locale; defaults to English. */
  locale?: AppLocale;
  /** Tokenized one-click unsubscribe link, shown in the shell footer. */
  unsubscribeUrl?: string;
};

export type BlogNewPostEmail = {
  subject: string;
  text: string;
  html: string;
};

/**
 * Inline styles for the article markup, keyed by tag. Email clients strip
 * <style> blocks, so every element the blog renderer can emit carries its
 * look inline. Palette matches the branded shell (dark card, parchment
 * text, teal links).
 */
const ARTICLE_TAG_STYLES: Record<string, string> = {
  h1: "margin:24px 0 12px;font-size:21px;line-height:1.35;font-weight:700;color:#F5F0E8;",
  h2: "margin:24px 0 12px;font-size:19px;line-height:1.35;font-weight:700;color:#F5F0E8;",
  h3: "margin:20px 0 10px;font-size:17px;line-height:1.35;font-weight:600;color:#F5F0E8;",
  h4: "margin:18px 0 8px;font-size:15px;font-weight:600;color:#F5F0E8;",
  h5: "margin:18px 0 8px;font-size:15px;font-weight:600;color:#F5F0E8;",
  h6: "margin:18px 0 8px;font-size:15px;font-weight:600;color:#F5F0E8;",
  p: "margin:0 0 14px;font-size:15px;line-height:1.65;color:#d9d2c4;",
  a: "color:#2EC4B6;text-decoration:underline;",
  strong: "color:#F5F0E8;",
  del: "color:#8a9bb0;",
  ul: "margin:0 0 14px;padding-left:22px;font-size:15px;line-height:1.65;color:#d9d2c4;",
  ol: "margin:0 0 14px;padding-left:22px;font-size:15px;line-height:1.65;color:#d9d2c4;",
  li: "margin:4px 0;",
  blockquote:
    "margin:0 0 14px;padding:2px 0 2px 14px;border-left:3px solid #2EC4B6;color:#8a9bb0;font-style:italic;",
  pre: "margin:0 0 14px;padding:12px;background-color:#0D2235;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.5;color:#d9d2c4;",
  code: "font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;color:#d9d2c4;",
  img: "max-width:100%;height:auto;border-radius:8px;margin:0 0 14px;",
  hr: "margin:20px 0;border:none;border-top:1px solid #1e3a52;",
  table:
    "margin:0 0 14px;border-collapse:collapse;width:100%;font-size:14px;line-height:1.5;color:#d9d2c4;",
  th: "border:1px solid #1e3a52;background-color:#0D2235;padding:6px 10px;text-align:left;color:#F5F0E8;",
  td: "border:1px solid #1e3a52;padding:6px 10px;"
};

const STYLED_TAG_RE = new RegExp(
  `<(${Object.keys(ARTICLE_TAG_STYLES).join("|")})(?=[\\s/>])`,
  "g"
);

/**
 * The blog's rendered HTML with inline styles injected per tag. The input
 * comes from renderMarkdown (escape-first, trusted tag vocabulary), so a
 * plain tag-open rewrite is exact.
 */
export function emailArticleHtml(markdown: string): string {
  return renderMarkdown(markdown).replace(
    STYLED_TAG_RE,
    (_match, tag: string) => `<${tag} style="${ARTICLE_TAG_STYLES[tag]}"`
  );
}

export function buildBlogNewPostEmail(input: BlogNewPostInput): BlogNewPostEmail {
  const locale = input.locale ?? defaultLocale;
  const copy = emailMessagesForLocale(locale).blogNewPost;
  const siteUrl = input.siteUrl.replace(/\/$/, "");
  const postPath = locale === "es" ? `/es/blog/${input.slug}` : `/blog/${input.slug}`;
  const postUrl = `${siteUrl}${postPath}`;

  const subject = fmtEmail(copy.subject, { title: input.title });
  const textLines = [
    copy.intro,
    input.title,
    input.excerpt,
    markdownToPlainText(input.content),
    `${copy.readCta}: ${postUrl}`
  ];
  const text = textLines.join("\n\n");

  const html = buildBrandedEmailHtml({
    siteUrl,
    documentTitle: subject,
    heading: input.title,
    bodyBlocks: [
      { kind: "text" as const, text: input.excerpt },
      { kind: "raw" as const, html: emailArticleHtml(input.content) }
    ],
    cta: { label: copy.readCta, href: postUrl },
    includeFallbackLink: false,
    recipientEmail: input.recipientEmail,
    ...(input.unsubscribeUrl ? { unsubscribeUrl: input.unsubscribeUrl } : {})
  });

  return { subject, text, html };
}
