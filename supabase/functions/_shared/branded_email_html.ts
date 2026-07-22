// Keep markup in sync with `src/lib/email/branded-html.ts`.
//
// Supabase Dashboard auth templates (Confirm signup, Magic link, Reset password)
// are configured in the Supabase UI using `{{ .SiteURL }}`, `{{ .ConfirmationURL }}`, etc.

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function escapeAttr(url: string): string {
  return escapeHtml(url);
}

export type BrandedBodyBlock =
  | { kind: "text"; text: string }
  | { kind: "html"; html: string }
  /** Block-level markup emitted unwrapped; trusted, pre-escaped input only. */
  | { kind: "raw"; html: string };

export type BrandedEmailHtmlInput = {
  siteUrl: string;
  documentTitle: string;
  heading: string;
  bodyBlocks: BrandedBodyBlock[];
  cta?: { label: string; href: string };
  includeFallbackLink?: boolean;
  fallbackHref?: string;
  warningLine?: string;
  securityNote?: string;
  recipientEmail: string;
  unsubscribeUrl?: string | null;
  /**
   * When false, omit the platform team signature block. Set false for mail
   * sent under a TENANT identity — the platform's name/phone must not appear
   * under a business's From header. Defaults to true (platform-sent mail).
   */
  platformSignature?: boolean;
};

function renderBodyBlocks(blocks: BrandedBodyBlock[]): string {
  return blocks
    .map((b) => {
      if (b.kind === "text") {
        const t = escapeHtml(b.text);
        // pre-line keeps intentional \n (digest stats, bullet lists); HTML collapses them otherwise.
        return `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#F5F0E8;white-space:pre-line;">${t}</p>`;
      }
      if (b.kind === "raw") {
        return b.html;
      }
      return `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#F5F0E8;">${b.html}</p>`;
    })
    .join("");
}

export function buildBrandedEmailHtml(input: BrandedEmailHtmlInput): string {
  const siteUrl = input.siteUrl.replace(/\/$/, "");
  const logoSrc = `${siteUrl}/logo.png`;
  const year = new Date().getFullYear();

  const fallbackTarget = input.fallbackHref ?? (input.cta ? input.cta.href : "");
  const showFallback =
    input.includeFallbackLink !== false &&
    fallbackTarget.length > 0 &&
    (input.cta !== undefined || input.fallbackHref !== undefined);

  const warningBlock = input.warningLine
    ? `<p style="margin:0;font-size:16px;line-height:1.6;color:#FF6B35;font-weight:600;">${escapeHtml(
        input.warningLine
      )}</p>`
    : "";

  const ctaBlock =
    input.cta !== undefined
      ? `<tr><td align="center" style="padding:0 40px 32px;">
  <a href="${escapeAttr(input.cta.href)}" target="_blank" style="display:inline-block;background-color:#1BD96A;color:#0D2235;font-size:16px;font-weight:700;text-decoration:none;padding:14px 40px;border-radius:8px;mso-padding-alt:0;text-align:center;">
    <!--[if mso]><i style="mso-font-width:200%;mso-text-raise:30px;" hidden>&nbsp;</i><![endif]-->
    <span style="mso-text-raise:15px;">${escapeHtml(input.cta.label)}</span>
    <!--[if mso]><i style="mso-font-width:200%;" hidden>&nbsp;</i><![endif]-->
  </a>
</td></tr>`
      : "";

  const fallbackBlock = showFallback
    ? `<tr><td style="padding:0 40px 32px;">
  <p style="margin:0;font-size:13px;line-height:1.5;color:#8a9bb0;">If the button doesn't work, copy and paste this link into your browser:</p>
  <p style="margin:8px 0 0;font-size:13px;line-height:1.5;word-break:break-all;"><a href="${escapeAttr(
    fallbackTarget
  )}" style="color:#2EC4B6;text-decoration:underline;">${escapeHtml(fallbackTarget)}</a></p>
</td></tr>`
    : "";

  const securityBlock = input.securityNote
    ? `<tr><td style="padding:0 40px 32px;">
  <p style="margin:0;font-size:13px;line-height:1.5;color:#8a9bb0;">${escapeHtml(input.securityNote)}</p>
</td></tr>`
    : "";

  const unsubscribeBlock =
    input.unsubscribeUrl && input.unsubscribeUrl.length > 0
      ? `<tr><td style="padding:0 40px 24px;">
  <p style="margin:0;font-size:12px;line-height:1.5;color:#5a7186;">Don't want these emails? <a href="${escapeAttr(
    input.unsubscribeUrl
  )}" style="color:#2EC4B6;text-decoration:underline;">Unsubscribe</a> with one click.</p>
</td></tr>`
      : "";

  // Platform signature (Truly-style: logo left, stacked details right). The
  // phone line is the HQ number — answered by our own AI coworker (the demo).
  // Deliberately no physical address. Mirrors docs/email-signatures.html.
  const signatureBlock =
    input.platformSignature === false
      ? ""
      : `<tr><td style="padding:0 40px 32px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
    <tr>
      <td style="vertical-align:middle;padding:0 16px 0 0;">
        <img src="${escapeAttr(logoSrc)}" alt="New Coworker" width="56" height="56" style="display:block;width:56px;height:56px;border-radius:10px;">
      </td>
      <td style="vertical-align:middle;border-left:2px solid #2EC4B6;padding:2px 0 2px 16px;font-size:13px;line-height:1.55;color:#F5F0E8;">
        <span style="font-weight:700;">The New Coworker Team</span><br>
        <span style="font-style:italic;color:#8a9bb0;">Brian Lane, Founder</span><br>
        Call: <a href="tel:+16023131823" style="color:#F5F0E8;text-decoration:none;">602.313.1823</a> <span style="color:#8a9bb0;">(our AI coworker answers)</span><br>
        Web: <a href="https://www.newcoworker.com" target="_blank" style="color:#2EC4B6;text-decoration:underline;">newcoworker.com</a>
      </td>
    </tr>
  </table>
</td></tr>`;

  const bodyInner = renderBodyBlocks(input.bodyBlocks);
  const bodyCellInner = [bodyInner, warningBlock].filter(Boolean).join("\n  ");
  const bodyRow = bodyCellInner
    ? `<tr><td style="padding:0 40px 32px;">
  ${bodyCellInner}
</td></tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>${escapeHtml(input.documentTitle)}</title>
</head>
<body style="margin:0;padding:0;background-color:#0D2235;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,Cantarell,'Helvetica Neue',Arial,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#0D2235;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;background-color:#142d44;border-radius:12px;overflow:hidden;">

<tr><td align="center" style="padding:40px 40px 24px;">
  <img src="${escapeAttr(logoSrc)}" alt="New Coworker" width="160" style="display:block;max-width:160px;height:auto;">
</td></tr>

<tr><td align="center" style="padding:0 40px 16px;">
  <h1 style="margin:0;font-size:26px;font-weight:700;color:#F5F0E8;line-height:1.3;">${escapeHtml(input.heading)}</h1>
</td></tr>

${bodyRow}
${ctaBlock}
${fallbackBlock}
${securityBlock}
${signatureBlock}

<tr><td style="padding:0 40px;">
  <div style="border-top:1px solid #1e3a52;"></div>
</td></tr>

${unsubscribeBlock}
<tr><td align="center" style="padding:24px 40px 40px;">
  <p style="margin:0 0 8px;font-size:12px;color:#5a7186;line-height:1.5;">&copy; ${year} New Coworker. All rights reserved.</p>
  <p style="margin:0;font-size:12px;color:#5a7186;line-height:1.5;">This email was sent to ${escapeHtml(input.recipientEmail)}</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}
