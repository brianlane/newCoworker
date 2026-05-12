import { describe, expect, it } from "vitest";
import { buildBrandedEmailHtml, escapeHtml } from "@/lib/email/branded-html";

describe("branded-html", () => {
  it("escapeHtml neutralises HTML-sensitive characters", () => {
    expect(escapeHtml(`a & b < c > d "e"`)).toBe("a &amp; b &lt; c &gt; d &quot;e&quot;");
  });

  it("buildBrandedEmailHtml includes logo, CTA href, and escaped dynamic heading", () => {
    const html = buildBrandedEmailHtml({
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: `Hello <script> & co`,
      bodyBlocks: [{ kind: "text", text: "Body line." }],
      cta: { label: "Go", href: "https://app.test/go" },
      recipientEmail: "u@x.y"
    });
    expect(html).toContain("https://app.test/logo.png");
    expect(html).toContain('href="https://app.test/go"');
    expect(html).toContain("Hello &lt;script&gt; &amp; co");
    expect(html).not.toContain("<script>");
    expect(html).toContain("u@x.y");
  });

  it("renders unsubscribe block when unsubscribeUrl is set", () => {
    const html = buildBrandedEmailHtml({
      siteUrl: "https://app.test",
      documentTitle: "Alert",
      heading: "Alert",
      bodyBlocks: [{ kind: "text", text: "Hi" }],
      cta: { label: "Open", href: "https://app.test/d" },
      unsubscribeUrl: "https://app.test/api/notifications/unsubscribe?bid=abc",
      recipientEmail: "u@x.y"
    });
    expect(html).toContain("Unsubscribe");
    expect(html).toContain("api/notifications/unsubscribe?bid=abc");
  });
});
