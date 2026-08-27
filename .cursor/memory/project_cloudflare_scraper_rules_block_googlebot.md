---
name: cloudflare-scraper-rules-block-googlebot
description: "Jul 30 2026 anti-scraper Cloudflare rules 403 Googlebot (and curl) on marketing paths; the no-Accept-Language challenge is the cause of the Aug 2026 GSC \"access forbidden\" emails"
metadata: 
  node_type: memory
  type: project
  originSessionId: 42da3430-dc59-4ef1-a1ab-73cfcf39a377
  modified: 2026-08-10T16:04:41.004Z
---

On 2026-07-30 a Cursor session mitigated a scraping attack (India origin, one
JA4 fingerprint, spoofed Chrome/Firefox UAs, hammering SSR marketing pages) by
adding three Cloudflare zone rules (zone 04d570f55e7312f34ba2f4fa4ca35209):

1. `ea70346cce3d4bcbb9eb04cb9ce0b6a6` (http_request_firewall_custom):
   managed_challenge on GET with NO Accept-Language header on marketing paths
   (/pricing /features /about /faq /contact /login /blog* /onboard*
   /integrations* /industries* /compare*). **This one challenges Googlebot**,
   which does not send Accept-Language; a challenge is an HTTP 403 to a
   crawler, and the interstitial is noindex. Result: GSC "Blocked due to
   access forbidden (403)" emails starting Aug 7 2026, growing as Google
   recrawls. Paths NOT listed (/, /terms, /privacy, /docs/api) stay 200.
2. `0b762514f4974ed3abd395eeb69cf65d`: managed_challenge on two exact scraper
   UA strings (Chrome/141 Win, Firefox/140 Linux) on same paths + /es/*.
3. `462dfb6e491f49f984f4b97172d4d922` (http_ratelimit): block at 30 req/10s
   per IP+colo on same paths + /es/*.

FIX APPLIED 2026-08-10: rules 1 and 3 now start with `not cf.client.bot and`
(Cloudflare's verified "known bots" field, available on all plans), so
Googlebot/Bingbot/verified AI crawlers skip the challenge while unverified
no-Accept-Language clients are still challenged (verified live: curl no-A-L
still 403, with A-L 200; Google Rich Results Test fetched /pricing as real
Googlebot on 2026-08-10: "Crawled successfully"). Rule 2 (exact scraper UAs)
left unchanged. The
Anthropic MCP allowlist skip rule (`c9c2f051`, /api/mcp + /.well-known from
160.79.104.0/21) was untouched, still first in the ruleset; the live Claude
MCP connector confirmed working post-change. Remaining human step: GSC
"Validate fix" on the 403 reason ONLY (redirect/canonical reasons are
intentional per the www cutover; Cursor session d9d1e483, Jul 30, ruled the
May GSC email needed no action).

Traps for future sessions:
- **curl against www.newcoworker.com marketing paths returns 403 unless you
  send an Accept-Language header.** Always probe with
  `-H 'Accept-Language: en-US'` or the result lies.
- WAF/ruleset write access: `CLOUDFLARE_SSL_API_TOKEN` in .env can read/write
  zone rulesets (its /user/tokens/verify oddly errors, but ruleset calls
  work). The main `CLOUDFLARE_API_TOKEN` cannot touch WAF, settings, or
  bot_management. Neither token can read Super Bot Fight Mode state.
- A "managed challenge" from Cloudflare is served as HTTP 403 with
  `cf-mitigated: challenge`; security scanners (ZAP) and GSC both report it
  as plain 403.
