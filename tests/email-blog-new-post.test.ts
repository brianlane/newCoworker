/**
 * Blog newsletter email (src/lib/email/templates/blog-new-post.ts):
 * English + Spanish copy, the full article rendered into the HTML with
 * inline styles, locale-aware post URLs, the optional unsubscribe footer,
 * and site-URL normalization.
 */
import { describe, expect, it } from "vitest";
import { buildBlogNewPostEmail, emailArticleHtml } from "@/lib/email/templates/blog-new-post";

const BASE = {
  title: "Big Feature",
  excerpt: "Your coworker can do a new thing.",
  content: "## What changed\n\nYour coworker got **smarter**.\n\n- one\n- two",
  slug: "big-feature",
  recipientEmail: "reader@example.com",
  siteUrl: "https://www.newcoworker.com"
};

describe("emailArticleHtml", () => {
  it("renders the markdown with inline styles on every known tag", () => {
    const html = emailArticleHtml(BASE.content);
    expect(html).toContain('<h2 style="');
    expect(html).toContain('<p style="');
    expect(html).toContain('<ul style="');
    expect(html).toContain('<li style="');
    expect(html).toContain('<strong style="');
    expect(html).not.toContain("<h2>");
  });

  it("styles self-closing and attribute-carrying tags (hr, links, images)", () => {
    const html = emailArticleHtml(
      "---\n[docs](https://a.dev) ![alt](https://a.dev/i.png)"
    );
    expect(html).toContain('<hr style="');
    expect(html).toMatch(/<a style="[^"]+" href="https:\/\/a\.dev"/);
    expect(html).toMatch(/<img style="[^"]+" src="https:\/\/a\.dev\/i\.png"/);
  });

  it("styles tables", () => {
    const html = emailArticleHtml("| A |\n| --- |\n| 1 |");
    expect(html).toContain('<table style="');
    expect(html).toContain('<th style="');
    expect(html).toContain('<td style="');
  });
});

describe("buildBlogNewPostEmail", () => {
  it("builds English copy by default with the article embedded and the English post URL", () => {
    const email = buildBlogNewPostEmail(BASE);
    expect(email.subject).toBe("New on the New Coworker blog: Big Feature");
    expect(email.text).toContain("We just published a new post");
    expect(email.text).toContain("Your coworker got smarter."); // plain-text article
    expect(email.text).toContain("https://www.newcoworker.com/blog/big-feature");
    expect(email.html).toContain("Big Feature");
    expect(email.html).toContain('<h2 style="'); // full article in the HTML
    expect(email.html).toContain("What changed");
    expect(email.html).toContain("https://www.newcoworker.com/blog/big-feature");
  });

  it("builds Spanish copy with the /es post URL", () => {
    const email = buildBlogNewPostEmail({ ...BASE, locale: "es" });
    expect(email.subject).toBe("Nuevo en el blog de New Coworker: Big Feature");
    expect(email.text).toContain("Acabamos de publicar");
    expect(email.text).toContain("https://www.newcoworker.com/es/blog/big-feature");
  });

  it("shows the unsubscribe footer only when a URL is provided", () => {
    const withUnsub = buildBlogNewPostEmail({
      ...BASE,
      unsubscribeUrl: "https://www.newcoworker.com/api/blog/unsubscribe?token=t1"
    });
    expect(withUnsub.html).toContain("Unsubscribe");
    expect(withUnsub.html).toContain("unsubscribe?token=t1");

    const without = buildBlogNewPostEmail(BASE);
    expect(without.html).not.toContain("Unsubscribe</a>");
  });

  it("normalizes a trailing slash off the site URL", () => {
    const email = buildBlogNewPostEmail({ ...BASE, siteUrl: "https://x.dev/" });
    expect(email.text).toContain("https://x.dev/blog/big-feature");
    expect(email.text).not.toContain("x.dev//blog");
  });
});
