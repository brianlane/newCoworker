"use client";

import { useEffect } from "react";

/**
 * Our own website chat widget — the same embeddable loader tenants paste
 * into their sites (public/widget.js), dogfooded on the marketing pages and
 * backed by the internal Residency Pilot tenant's WebchatCoworker.
 *
 * The site key comes from NEXT_PUBLIC_WEBCHAT_SITE_KEY (a PUBLIC widget key
 * by design — it ships in the page HTML either way; the env var just lets
 * us rotate it without a code change). Unset ⇒ no bubble, so previews and
 * local dev are unaffected.
 *
 * Why a client component with an unmount cleanup instead of next/script:
 * the loader appends its bubble/iframe to document.body, so after a
 * client-side navigation from a marketing page to /login or /dashboard the
 * UI would otherwise persist on surfaces that never render this component
 * (Bugbot finding on PR #497). The loader exposes window.__ncwWidget
 * {show, hide} for exactly this: we hide on unmount and re-show (without
 * re-injecting the script) when a marketing page mounts again.
 *
 * Rendered from MarketingFooter so it appears on every public marketing
 * page and never on the dashboard/auth surfaces.
 */

type NcwWidgetHandle = { show: () => void; hide: () => void };

declare global {
  interface Window {
    __ncwWidget?: NcwWidgetHandle;
    __ncwWidgetLoaded?: boolean;
  }
}

export function SiteChatWidget() {
  useEffect(() => {
    const siteKey = process.env.NEXT_PUBLIC_WEBCHAT_SITE_KEY?.trim();
    if (!siteKey) return;

    if (window.__ncwWidget) {
      // Already injected by a previous marketing page — just re-show.
      window.__ncwWidget.show();
    } else if (!window.__ncwWidgetLoaded) {
      const script = document.createElement("script");
      script.src = "/widget.js";
      script.async = true;
      script.setAttribute("data-key", siteKey);
      // Brand accent (claw-green) for the bubble; the frame itself themes
      // from the tenant's chat_widget_settings.theme.
      script.setAttribute("data-color", "#1BD96A");
      document.body.appendChild(script);
    }

    return () => {
      // Leaving the marketing surface (SPA navigation to login/dashboard):
      // close the panel and hide the bubble. The script stays loaded, so
      // returning to a marketing page is a cheap show().
      window.__ncwWidget?.hide();
    };
  }, []);

  return null;
}
