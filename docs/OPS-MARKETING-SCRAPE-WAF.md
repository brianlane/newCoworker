# Ops: marketing scrape WAF (2026-07-30)

Standing Cloudflare protection after the Vercel Function Invocations spike
(12x, peaking ~3.4k/min around 21:43 UTC on 2026-07-30). The traffic was
spoofed-browser GETs to SSR marketing pages (`/contact`, `/blog`, `/login`,
etc.), mostly India → Cloudflare → `www.newcoworker.com`, one JA4 digest
(`t13d1312h2_a44d0ee8b3cc_e381dae6da6b`).

## Why not a JA4 rule

`cf.bot_management.ja4` requires a Bot Management plan. This zone is not
entitled, so JA4 challenges fail API validation. Use the UA + rate-limit
rules below instead. If Bot Management is purchased later, add:

```text
(cf.bot_management.ja4 eq "t13d1312h2_a44d0ee8b3cc_e381dae6da6b")
→ Managed Challenge
```

## Live rules (zone `newcoworker.com`)

Managed with `CLOUDFLARE_SSL_API_TOKEN` (the tunnel token cannot edit WAF).

### Custom firewall (`http_request_firewall_custom`)

Ruleset id `f9a51022c3c24b5baa8c8e8ac33f5d8f` (also holds the Anthropic MCP
skip rule; do not remove that).

1. **Challenge likely scraper GETs on hot marketing paths (no Accept-Language)**  
   Action: `managed_challenge`  
   Expression: GET on `/contact`, `/blog*`, `/login`, `/onboard*`, `/pricing`,
   `/features`, `/about`, `/faq`, `/integrations*`, `/industries*`, `/compare*`
   when `Accept-Language` is absent.

2. **Challenge known 2026-07-30 scrape User-Agents on marketing paths**  
   Action: `managed_challenge`  
   Exact UAs from the spike:
   - `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36`
   - `Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0`  
   Same marketing path set, plus `/admin/login` and `/es/*`.

### Rate limiting (`http_ratelimit`)

Ruleset id `920e807491964ed68ee604ad911a8d98`.

1. **Rate-limit marketing GET scrape paths (2026-07-30 spike)**  
   Action: `block` (this plan cannot use `managed_challenge` inside rate
   limit; `mitigation_timeout` must be `10`)  
   Characteristics: `cf.colo.id`, `ip.src`  
   Threshold: 30 requests / 10 seconds  
   Paths: same marketing set as above (including `/es/*`).

## Do not

- Block all of India or the Cloudflare ASN (breaks real users behind CF).
- Delete the Anthropic MCP skip rule when editing the custom ruleset.
- Rely on Vercel IP blocks: client IPs in Observability are CF edge addresses.

## Verify

Vercel Observability → `vercel.function_invocation.count` for project
`new-coworker`, grouped by `route`. Baseline is roughly 50 to 110 per 5 minutes.
After a scrape attempt, marketing routes should challenge/block at CF and
invocations should stay near baseline. Internal `/api/internal/*` cron polls
(~1/min each) are unrelated noise.

## App-side companions

- `/contact` no longer calls `getAuthUser` in the RSC; prefill is
  `GET /api/contact/prefill` from the client.
- Blog index/post/feed use `revalidate = 60` instead of `force-dynamic`.
- `src/i18n/request.ts` skips the auth/preferences lookup when no `sb-*`
  session cookie is present.
