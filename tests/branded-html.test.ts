import { describe, expect, it } from "vitest";
import {
  buildBrandedEmailHtml,
  escapeAttr,
  escapeHtml,
  type BrandedEmailHtmlInput
} from "@/lib/email/branded-html";
import {
  buildBrandedEmailHtml as buildBrandedEmailHtmlEdge,
  escapeAttr as escapeAttrEdge,
  escapeHtml as escapeHtmlEdge
} from "../supabase/functions/_shared/branded_email_html.ts";

describe("branded-html", () => {
  it("escapeHtml neutralises HTML-sensitive characters", () => {
    expect(escapeHtml(`a & b < c > d "e"`)).toBe("a &amp; b &lt; c &gt; d &quot;e&quot;");
  });

  it("escapeAttr matches escapeHtml (attribute-safe)", () => {
    expect(escapeAttr('&"')).toBe(escapeHtml('&"'));
  });

  it("preserves newlines in text body blocks (pre-line) for digest-style multiline stats", () => {
    const html = buildBrandedEmailHtml({
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H",
      bodyBlocks: [{ kind: "text", text: "Total events: 3\nUrgent alerts: 1" }],
      recipientEmail: "u@x.y"
    });
    expect(html).toContain("white-space:pre-line");
    expect(html).toMatch(/Total events: 3\s*\n\s*Urgent alerts: 1/);
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

  it("omits fallback link section when includeFallbackLink is false", () => {
    const html = buildBrandedEmailHtml({
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H",
      bodyBlocks: [{ kind: "text", text: "Hi" }],
      cta: { label: "Go", href: "https://app.test/x" },
      includeFallbackLink: false,
      recipientEmail: "u@x.y"
    });
    expect(html).toContain("Go");
    expect(html).not.toContain("If the button doesn't work");
  });

  it("renders fallback using fallbackHref without a CTA", () => {
    const html = buildBrandedEmailHtml({
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H",
      bodyBlocks: [{ kind: "text", text: "Hi" }],
      fallbackHref: "https://app.test/only-fallback",
      recipientEmail: "u@x.y"
    });
    expect(html).toContain("only-fallback");
    expect(html).not.toContain("mso-text-raise");
  });

  it("renders html-kind body blocks and security note", () => {
    const html = buildBrandedEmailHtml({
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H",
      bodyBlocks: [{ kind: "html", html: "<strong style=\"color:#1BD96A\">X</strong>" }],
      securityNote: "If this was not you, ignore.",
      recipientEmail: "u@x.y"
    });
    expect(html).toContain("color:#1BD96A");
    expect(html).toContain("If this was not you");
  });

  it("renders raw-kind body blocks unwrapped (block markup keeps its own tags)", () => {
    const html = buildBrandedEmailHtml({
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H",
      bodyBlocks: [{ kind: "raw", html: '<h2 style="color:#F5F0E8">Section</h2>' }],
      recipientEmail: "u@x.y"
    });
    expect(html).toContain('<h2 style="color:#F5F0E8">Section</h2>');
    // Unwrapped: the h2 must not be nested inside the text-block <p> shell.
    expect(html).not.toContain('white-space:pre-line;"><h2');
  });

  it("omits the body row when there are no blocks and no warning line", () => {
    const html = buildBrandedEmailHtml({
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H only",
      bodyBlocks: [],
      cta: { label: "Go", href: "https://app.test/z" },
      recipientEmail: "u@x.y"
    });
    expect(html).toContain("H only");
    expect(html).not.toContain(
      "margin:0 0 16px;font-size:16px;line-height:1.6;color:#F5F0E8"
    );
  });

  it("renders warning line in accent color", () => {
    const html = buildBrandedEmailHtml({
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H",
      bodyBlocks: [{ kind: "text", text: "Hi" }],
      warningLine: "This link expires in 1 hour.",
      cta: { label: "Go", href: "https://app.test/w" },
      recipientEmail: "u@x.y"
    });
    expect(html).toContain("#FF6B35");
    expect(html).toContain("This link expires in 1 hour.");
  });

  it("always renders the platform signature block (team, founder, HQ line, website — no address)", () => {
    const html = buildBrandedEmailHtml({
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H",
      bodyBlocks: [{ kind: "text", text: "Hi" }],
      recipientEmail: "u@x.y"
    });
    expect(html).toContain("The New Coworker Team");
    expect(html).toContain("Brian Lane, Founder");
    expect(html).toContain('href="tel:+16023131823"');
    expect(html).toContain("602.313.1823");
    // Copy rule (Jul 2026): no AI-answers note on the Call line.
    expect(html).not.toContain("(our AI coworker answers)");
    expect(html).toContain('href="https://www.newcoworker.com"');
    // The signature reuses the site logo at signature size.
    expect(html).toContain('width="56"');
  });

  it("omits the platform signature when platformSignature is false (tenant-identity mail)", () => {
    const html = buildBrandedEmailHtml({
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H",
      bodyBlocks: [{ kind: "text", text: "Hi" }],
      recipientEmail: "u@x.y",
      platformSignature: false
    });
    expect(html).not.toContain("The New Coworker Team");
    expect(html).not.toContain("Brian Lane");
    expect(html).not.toContain("602.313.1823");
  });

  it("omits unsubscribe when url is empty string", () => {
    const html = buildBrandedEmailHtml({
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H",
      bodyBlocks: [{ kind: "text", text: "Hi" }],
      cta: { label: "Go", href: "https://app.test/g" },
      unsubscribeUrl: "",
      recipientEmail: "u@x.y"
    });
    expect(html).not.toContain("Don't want these emails?");
  });
});

describe("branded_email_html (Edge parity)", () => {
  const parityInputs: BrandedEmailHtmlInput[] = [
    {
      siteUrl: "https://parity.test",
      documentTitle: "Doc",
      heading: "Head",
      bodyBlocks: [{ kind: "text", text: "Line" }],
      cta: { label: "Act", href: "https://parity.test/a" },
      recipientEmail: "r@p.t"
    },
    {
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H",
      bodyBlocks: [{ kind: "text", text: "Hi" }],
      cta: { label: "Go", href: "https://app.test/x" },
      includeFallbackLink: false,
      recipientEmail: "u@x.y"
    },
    {
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H",
      bodyBlocks: [{ kind: "text", text: "Hi" }],
      fallbackHref: "https://app.test/only-fallback",
      recipientEmail: "u@x.y"
    },
    {
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H",
      bodyBlocks: [{ kind: "html", html: "<strong style=\"color:#1BD96A\">X</strong>" }],
      securityNote: "If this was not you, ignore.",
      recipientEmail: "u@x.y"
    },
    {
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H",
      bodyBlocks: [{ kind: "raw", html: '<h2 style="color:#F5F0E8">Section</h2>' }],
      recipientEmail: "u@x.y"
    },
    {
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H only",
      bodyBlocks: [],
      cta: { label: "Go", href: "https://app.test/z" },
      recipientEmail: "u@x.y"
    },
    {
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H",
      bodyBlocks: [{ kind: "text", text: "Hi" }],
      cta: { label: "Go", href: "https://app.test/d" },
      unsubscribeUrl: "https://app.test/api/notifications/unsubscribe?bid=abc",
      recipientEmail: "u@x.y"
    },
    {
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H",
      bodyBlocks: [{ kind: "text", text: "Hi" }],
      cta: { label: "Go", href: "https://app.test/g" },
      unsubscribeUrl: "",
      recipientEmail: "u@x.y"
    },
    {
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H",
      bodyBlocks: [{ kind: "text", text: "Hi" }],
      warningLine: "Watch out!",
      cta: { label: "Go", href: "https://app.test/w" },
      recipientEmail: "u@x.y"
    },
    {
      siteUrl: "https://app.test",
      documentTitle: "T",
      heading: "H",
      bodyBlocks: [{ kind: "text", text: "Tenant campaign" }],
      recipientEmail: "u@x.y",
      platformSignature: false
    }
  ];

  it("matches Node escapeHtml / escapeAttr for sample strings", () => {
    expect(escapeHtmlEdge(`a & b`)).toBe(escapeHtml(`a & b`));
    expect(escapeAttrEdge("u&")).toBe(escapeAttr("u&"));
  });

  it("matches Node buildBrandedEmailHtml for every parity input shape", () => {
    for (const input of parityInputs) {
      expect(buildBrandedEmailHtmlEdge(input)).toBe(buildBrandedEmailHtml(input));
    }
  });
});
