# AiFlow render service

Headless-Chromium HTTP service for the AiFlows `browse_extract` step. Deploy it
when a lead page is a JavaScript SPA whose data isn't in the static HTML, **or
when the page is login-gated** (the worker's static fetch can't authenticate).
When `AIFLOW_RENDER_URL` is unset the worker falls back to a static `fetch`.

## Contract

Matches `supabase/functions/_shared/ai_flows/browse.ts` (`parseRenderResponse`):

```
POST /render
{ "url": "https://example.com/lead/123" }                       # public page

{ "url": "https://...", "businessId": "<uuid>",                 # login-gated page
  "auth": { "integrationLabel": "Referral Exchange",
            "login": { "usernameSelector": "...",               # optional overrides
                       "passwordSelector": "...",
                       "submitSelector": "..." } } }

200 -> { "finalUrl": "https://...", "text": "<innerText>", "html": "<html>" }
400 -> { "error": "invalid_or_unsafe_url" | "missing_business_or_label" }
401 -> { "error": "unauthorized" }                              # bad/no bearer
502 -> { "error": "render_failed" | "login_failed", "detail": "..." }
```

### Authenticated (credentialed) browse

When `auth` is present the service:

1. Opens (or reuses) a **per-tenant browser context** keyed by
   `businessId:integrationLabel`, so the login session cookie is cached across
   calls and we only re-login when it expires.
2. Navigates to the URL. If it lands on a login form (a password field is
   present), it fetches the integration's decrypted credentials from the
   platform's gateway-guarded endpoint
   (`POST {AIFLOW_PLATFORM_URL}/api/integrations/custom/credentials?businessId=…`),
   fills the email/password fields, submits, and re-navigates to the URL.
3. Returns the rendered page. It **only reads** — it never clicks lead-page
   action buttons (accept/call/email), which can create binding agreements.

The same SSRF host rules as the worker apply to every browser request (initial
nav, redirects, subresources): http/https only; no localhost / private-IPv4 /
IPv6-literal / `*.internal` / metadata hosts.

## Environment

| Var | Purpose |
|-----|---------|
| `PORT` | Listen port (default `8080`). |
| `AIFLOW_RENDER_TIMEOUT_MS` | Per-navigation timeout (default `30000`). |
| `AIFLOW_RENDER_TOKEN` | If set, required as `Authorization: Bearer` on `/render`. Set the same value as the worker's `AIFLOW_RENDER_TOKEN`. |
| `AIFLOW_PLATFORM_URL` | Platform base URL for credential lookups (auth mode). |
| `AIFLOW_GATEWAY_TOKEN` | Bearer for the platform credentials endpoint (`ROWBOAT_GATEWAY_TOKEN`). |
| `AIFLOW_SESSION_TTL_MS` | Idle context eviction (default `1800000` = 30m). |
| `AIFLOW_MAX_SESSIONS` | Max cached contexts (default `50`). |
| `AIFLOW_RATE_WINDOW_MS` | Rate-limit window (default `60000`). |
| `AIFLOW_RATE_MAX` | Max requests per window per IP (default `120`). |

## Enable

1. Build & run on the VPS Docker host (add as a compose service):
   ```
   docker build -t aiflow-render vps/aiflow-render
   docker run -d --name aiflow-render -p 8080:8080 \
     -e AIFLOW_RENDER_TOKEN=... -e AIFLOW_PLATFORM_URL=https://<app> \
     -e AIFLOW_GATEWAY_TOKEN=... aiflow-render
   ```
2. Point the worker at it (Supabase Edge secrets):
   ```
   AIFLOW_RENDER_URL=https://<vps-host>/render
   AIFLOW_RENDER_TOKEN=<same shared bearer>
   ```

> The service is network-reachable from Supabase Edge, so always set
> `AIFLOW_RENDER_TOKEN` in production. Credentials never leave the VPS process —
> they're used in-page to drive the login form and are never persisted or
> returned.
