import { describe, expect, it } from "vitest";
import { isLinkPreviewBot } from "@/lib/sms/link-preview-bots";

describe("isLinkPreviewBot", () => {
  it("treats a missing or empty user agent as a bot (real browsers always send one)", () => {
    expect(isLinkPreviewBot(null)).toBe(true);
    expect(isLinkPreviewBot(undefined)).toBe(true);
    expect(isLinkPreviewBot("")).toBe(true);
    expect(isLinkPreviewBot("   ")).toBe(true);
  });

  it("matches messaging-app preview fetchers (what fired the Jul 18 false alerts)", () => {
    // iMessage/WhatsApp previews impersonate the Meta crawler chain.
    expect(isLinkPreviewBot("facebookexternalhit/1.1 Facebot Twitterbot/1.0")).toBe(true);
    expect(isLinkPreviewBot("WhatsApp/2.23.20.0")).toBe(true);
    expect(isLinkPreviewBot("TelegramBot (like TwitterBot)")).toBe(true);
    expect(isLinkPreviewBot("Slackbot-LinkExpanding 1.0")).toBe(true);
    expect(isLinkPreviewBot("Mozilla/5.0 (compatible; Discordbot/2.0)")).toBe(true);
    expect(isLinkPreviewBot("LinkedInBot/1.0")).toBe(true);
    expect(isLinkPreviewBot("SkypeUriPreview Preview/0.5")).toBe(true);
  });

  it("matches crawlers and scanner tooling", () => {
    expect(isLinkPreviewBot("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
    expect(isLinkPreviewBot("Mozilla/5.0 (compatible; bingbot/2.0)")).toBe(true);
    expect(isLinkPreviewBot("curl/8.4.0")).toBe(true);
    expect(isLinkPreviewBot("python-requests/2.31.0")).toBe(true);
    expect(isLinkPreviewBot("Go-http-client/2.0")).toBe(true);
    expect(
      isLinkPreviewBot("Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/119.0.0.0")
    ).toBe(true);
  });

  it("passes real phone and desktop browsers through", () => {
    expect(
      isLinkPreviewBot(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
      )
    ).toBe(false);
    expect(
      isLinkPreviewBot(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
      )
    ).toBe(false);
    expect(
      isLinkPreviewBot(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
      )
    ).toBe(false);
  });
});
