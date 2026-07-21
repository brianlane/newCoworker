/**
 * Subscriber email: a new post went live on the New Coworker blog.
 *
 * Sent by the blog publish pipeline (src/lib/blog/publish.ts) to every
 * active blog_subscribers row. Deterministic and input-pure: no DB reads,
 * no Date.now(), no env lookups.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";

export type BlogNewPostInput = {
  title: string;
  excerpt: string;
  slug: string;
  recipientEmail: string;
  /** App origin without trailing slash (e.g. https://www.newcoworker.com). */
  siteUrl: string;
  /** Recipient's locale; defaults to English. */
  locale?: AppLocale;
};

export type BlogNewPostEmail = {
  subject: string;
  text: string;
  html: string;
};

export function buildBlogNewPostEmail(input: BlogNewPostInput): BlogNewPostEmail {
  const locale = input.locale ?? defaultLocale;
  const copy = emailMessagesForLocale(locale).blogNewPost;
  const siteUrl = input.siteUrl.replace(/\/$/, "");
  const postPath = locale === "es" ? `/es/blog/${input.slug}` : `/blog/${input.slug}`;
  const postUrl = `${siteUrl}${postPath}`;

  const subject = fmtEmail(copy.subject, { title: input.title });
  const textLines = [copy.intro, input.title, input.excerpt, `${copy.readCta}: ${postUrl}`];
  const text = textLines.join("\n\n");

  const html = buildBrandedEmailHtml({
    siteUrl,
    documentTitle: subject,
    heading: input.title,
    bodyBlocks: [
      { kind: "text" as const, text: copy.intro },
      { kind: "text" as const, text: input.excerpt }
    ],
    cta: { label: copy.readCta, href: postUrl },
    recipientEmail: input.recipientEmail
  });

  return { subject, text, html };
}
