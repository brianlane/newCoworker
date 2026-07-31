# CASA AL1: DAST finding triage

Scan: `New Coworker production DAST 2026-07-30`, PO_21824_1785445496,
target `https://www.newcoworker.com`, report generated 2026-07-31 10:20 IST.
Vulnerability ids 78106-78119.

All evidence below was reproduced first-hand against production on 2026-07-31,
not taken from the scanner's summary.

| # | Vul id | Finding | Sev | Disposition | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | 78106 | NoSQL Injection - MongoDB | Med | **False positive** | Scanner evidence URL is `https://www.newcoworker.com/_next/static/chunks/turbopack-0ygm7u69gqutw.js?dpl[$eq]=`: ZAP appended a MongoDB operator to the `dpl` query parameter of a **static JavaScript chunk**, which returns identical bytes regardless of query string. No database is reached on that path. The assessed app uses Supabase/PostgreSQL exclusively; MongoDB exists only in the per-tenant Rowboat VPS tier (`src/lib/vps/sync-vault.ts`), which is not reachable from `www.newcoworker.com` and is out of assessment scope. |
| 2 | 78107 | Source Code Disclosure - File Inclusion | Med | **False positive** | Scanner evidence URL is the **Next.js image optimizer**: `/_next/image?dpl=...&q=75&url=%2Flogo.png&w=64`. Verified 2026-07-31 to return `content-type: image/png`, a 1491-byte 64x64 PNG, not source. The scanner's own stated reason is a similarity heuristic that crossed its threshold by one point: *"differs sufficiently from that of the random parameter, at [74%], compared to a threshold of [75%]"*, comparing two binary image renders. Independently, `/.git/config`, `/.env`, `/package.json` and `/next.config.ts` all return 404, and no browser source maps are emitted (`/_next/static/chunks/<hash>.js.map` returns 404). |
| 3 | 78108 | Bypassing 403 | Low | **Not application layer** | The 403s ZAP saw are Cloudflare managed challenges, not app authorization: `GET /login` returns `HTTP/2 403` with `cf-mitigated: challenge` and `server: cloudflare`. No application access control was bypassed. |
| 4 | 78109 | CORS Misconfiguration | Low | **False positive** | See row 6. |
| 5 | 78110 | CSP: Header & Meta | Info | Addressed by PR C | No `<meta http-equiv="Content-Security-Policy">` exists anywhere in `src/`. The enforced header is set at `next.config.ts:28`. Needs the flagged URL from the PDF report to close precisely. |
| 6 | 78111 | Cross-Domain Misconfiguration | Low | **False positive** | `access-control-allow-origin: *` appears on exactly two responses, `/robots.txt` and `/llms.txt`, both public credential-free static text. It is injected by Vercel's static-asset serving for `force-static` routes, not by our code (no `Access-Control-Allow-*` string exists in `src/`); the `force-dynamic` sibling `/llms-full.txt` returns no ACAO. **No authenticated surface returns ACAO** (`/login`, `/dashboard`, `/admin`, `/api/auth/callback`, `/api/integrations/nango/session` all return none) and `Access-Control-Allow-Credentials` is never returned, so the authenticated cross-origin read the rule warns about is not possible. |
| 7 | 78112 | Proxy Disclosure | Low | **Accepted, by design** | Cloudflare fronts the origin deliberately. |
| 8 | 78113 | HTTPS Content Available via HTTP | Info | **False positive** | Plain HTTP serves no content: `http://newcoworker.com/` and `http://www.newcoworker.com/` both return `308 Permanent Redirect` to the HTTPS equivalent, served by Cloudflare. |
| 9 | 78114 | Timestamp Disclosure - Unix | Info | Accepted noise | Standard ZAP pattern match. |
| 10 | 78115 | Strict-Transport-Security Header Not Set | Info | **False positive** | HSTS is present on the secure response: `https://www.newcoworker.com/` returns `strict-transport-security: max-age=63072000; includeSubDomains; preload` (from `next.config.ts:23`). It is absent only on the Cloudflare-served plain-HTTP 308, where **RFC 6797 section 7.2 requires user agents to ignore an HSTS header received over non-secure transport**, so setting it there would be inert. |
| 11 | 78116 | Modern Web Application | Info | Accepted noise | Informational scanner hint. |
| 12 | 78117 | Storable but Non-Cacheable Content | Info | Accepted noise | |
| 13 | 78118 | Retrieved from Cache | Info | Accepted noise | |
| 14 | 78119 | User Agent Fuzzer | Info | Accepted noise | |

## Headline

**No finding requires an application code fix.** 0 critical, 0 high; both
mediums are false positives with reproducible evidence. The Phase 2 hardening
PRs are therefore proactive SAQ strengthening, not finding remediation.

## Two things worth knowing

1. **The HSTS fix I originally planned would have been wrong.** Adding HSTS at
   the Cloudflare edge would have duplicated what `next.config.ts` already
   emits, which is exactly the two-sources-of-truth drift
   [README.md:1130](README.md:1130) forbids. It is also unnecessary, since the
   only header-less response is one browsers must ignore by spec. No edge HSTS
   change will be made.

2. **The scan ran through Cloudflare's bot management.** `/login` returns a
   `cf-mitigated: challenge` 403 to non-browser clients, so an unknown share of
   the app was challenged rather than actually tested. This does not change the
   agreed approach of treating the completed scan as the AL1 evidence, but it
   is a fact to state plainly to TAC rather than let them infer clean coverage.

## Still needed

- The password-protected PDF scan report, for the exact flagged URLs on
  findings 2 and 5. Download requires Brian's go-ahead (batched).
- `/.well-known/security.txt` returns 404. Adding one that points at the
  Vulnerability Disclosure Policy is a cheap, coherent addition to PR D.
