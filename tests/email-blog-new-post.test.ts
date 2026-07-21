/**
 * Blog new-post subscriber email (src/lib/email/templates/blog-new-post.ts):
 * English + Spanish copy, locale-aware post URLs, and site-URL
 * normalization.
 */
import { describe, expect, it } from "vitest";
import { buildBlogNewPostEmail } from "@/lib/email/templates/blog-new-post";

const BASE = {
  title: "Big Feature",
  excerpt: "Your coworker can do a new thing.",
  slug: "big-feature",
  recipientEmail: "reader@example.com",
  siteUrl: "https://www.newcoworker.com"
};

describe("buildBlogNewPostEmail", () => {
  it("builds English copy by default with the English post URL", () => {
    const email = buildBlogNewPostEmail(BASE);
    expect(email.subject).toBe("New on the New Coworker blog: Big Feature");
    expect(email.text).toContain("We just published a new post");
    expect(email.text).toContain("https://www.newcoworker.com/blog/big-feature");
    expect(email.html).toContain("Big Feature");
    expect(email.html).toContain("https://www.newcoworker.com/blog/big-feature");
  });

  it("builds Spanish copy with the /es post URL", () => {
    const email = buildBlogNewPostEmail({ ...BASE, locale: "es" });
    expect(email.subject).toBe("Nuevo en el blog de New Coworker: Big Feature");
    expect(email.text).toContain("Acabamos de publicar");
    expect(email.text).toContain("https://www.newcoworker.com/es/blog/big-feature");
  });

  it("normalizes a trailing slash off the site URL", () => {
    const email = buildBlogNewPostEmail({ ...BASE, siteUrl: "https://x.dev/" });
    expect(email.text).toContain("https://x.dev/blog/big-feature");
    expect(email.text).not.toContain("x.dev//blog");
  });
});
