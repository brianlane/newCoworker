/**
 * Link-preview / scanner detection for tracked short-link hits.
 *
 * When an SMS/RCS/iMessage with a URL is DELIVERED, software fetches the
 * link before any human touches it: the messaging app builds its preview
 * card, and carrier security scanners probe links in transit (observed in
 * production: every link hit within 3-16s of send). Counting those as clicks
 * inflates stats and once fired false "lead opened your link" owner alerts.
 *
 * Pure and dependency-free so the matcher sits under the lib coverage gate.
 */

// Known preview/scanner user-agent fragments. Deliberately targeted — a
// broad /bot/ match would also catch legitimate in-app browsers that embed
// odd tokens. Case-insensitive.
const PREVIEW_BOT_RE = new RegExp(
  [
    // Meta family — also what iMessage and WhatsApp previews impersonate
    // ("facebookexternalhit/1.1 Facebot Twitterbot/1.0").
    "facebookexternalhit",
    "facebot",
    "whatsapp",
    // Messaging & collaboration preview fetchers.
    "telegrambot",
    "slackbot",
    "slack-imgproxy",
    "discordbot",
    "twitterbot",
    "linkedinbot",
    "skypeuripreview",
    "snapchat",
    "viber",
    "line-poker",
    // Search / infra crawlers and proxies that follow SMS links.
    "googlebot",
    "bingbot",
    "yandexbot",
    "duckduckbot",
    "baiduspider",
    "applebot",
    "google-pagerenderer",
    "googleimageproxy",
    "google-safety",
    "cloudflare-alwaysonline",
    // Generic scanner/monitoring tells seen on carrier/security probes.
    "urlscan",
    "phishtank",
    "safebrowsing",
    "headlesschrome",
    "python-requests",
    "python-urllib",
    "go-http-client",
    "okhttp",
    "curl/",
    "wget/",
    "libwww",
    "httpclient",
    "axios/",
    "node-fetch",
    "undici"
  ].join("|"),
  "i"
);

/**
 * True when the request is machine link-preview/scanner traffic that must
 * not count as a click. A MISSING user agent is treated as a bot: every real
 * phone/desktop browser sends one; carrier scanners frequently do not.
 */
export function isLinkPreviewBot(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").trim();
  if (ua.length === 0) return true;
  return PREVIEW_BOT_RE.test(ua);
}
