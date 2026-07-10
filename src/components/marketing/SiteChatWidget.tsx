import Script from "next/script";

/**
 * Our own website chat widget — the same embeddable loader tenants paste
 * into their sites (public/widget.js), dogfooded on the marketing pages and
 * backed by the internal Residency Pilot tenant's WebchatCoworker.
 *
 * The site key comes from NEXT_PUBLIC_WEBCHAT_SITE_KEY (a PUBLIC widget key
 * by design — it ships in the page HTML either way; the env var just lets
 * us rotate it without a code change). Renders nothing when unset, so
 * previews/local dev without the var simply have no bubble.
 *
 * Rendered from MarketingFooter so it appears on every public marketing
 * page and never on the dashboard/auth surfaces.
 */
export function SiteChatWidget() {
  const siteKey = process.env.NEXT_PUBLIC_WEBCHAT_SITE_KEY?.trim();
  if (!siteKey) return null;
  return (
    <Script
      src="/widget.js"
      data-key={siteKey}
      // Brand accent (claw-green) for the bubble; the frame itself themes
      // from the tenant's chat_widget_settings.theme.
      data-color="#1BD96A"
      strategy="lazyOnload"
    />
  );
}
