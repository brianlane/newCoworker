# AiFlow render service

Headless-Chromium HTTP service for the AiFlows `browse_extract` step. Deploy it
when a lead page is a JavaScript SPA whose data isn't in the static HTML, **or
when the page is login-gated** (the worker's static fetch can't authenticate).
When the worker has no render URL configured it falls back to a static `fetch`.

## Deployment model — per-tenant

This runs as a **per-tenant sidecar**, one container on each business's own VPS
(same model as the voice bridge and chat-worker), so a tenant's stored
credentials, login cookies, and rendered lead data never leave that tenant's
host. `vps/scripts/deploy-client.sh` builds and starts it from the staged repo,
and the per-tenant Cloudflare Tunnel publishes it at
`https://render-<businessId>.<zone>/render` → `127.0.0.1:8080`
(see `src/lib/cloudflare/tunnel.ts`).

The shared `ai-flow-worker` (Supabase Edge) reaches the right tenant by
templating the businessId into `AIFLOW_RENDER_URL_TEMPLATE`
(e.g. `https://render-{businessId}.newcoworker.com/render`) — exactly like
`ROWBOAT_CHAT_URL_TEMPLATE` does for per-tenant Rowboat.

> **Tier gating:** the render sidecar is **not** deployed on the starter/KVM2
> tier (Chromium would compete with Ollama + Rowboat for the box's ~2 GB).
> `deploy-client.sh` skips/tears it down there, and the orchestrator omits the
> `render-<businessId>` hostname for starter tenants.

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

Production deploy is automatic via the orchestrator + `deploy-client.sh` on
every non-starter tenant. You only need to set the secrets:

1. Supabase Edge secrets (the shared worker):
   ```
   AIFLOW_RENDER_URL_TEMPLATE=https://render-{businessId}.newcoworker.com/render
   AIFLOW_RENDER_TOKEN=<shared bearer>
   ```
2. Orchestrator env (Vercel) so each VPS `.env` gets the matching bearer:
   ```
   AIFLOW_RENDER_TOKEN=<same shared bearer>
   ```
   `AIFLOW_PLATFORM_URL` and `AIFLOW_GATEWAY_TOKEN` on the VPS are derived from
   the platform origin (`APP_BASE_URL`) and `ROWBOAT_GATEWAY_TOKEN` already in
   the stack — see the render block in `deploy-client.sh`.

Local / single-host testing (no tunnel) — run the container and point the worker
at a static URL (no `{businessId}` placeholder is accepted too):
```
docker compose -f vps/aiflow-render/docker-compose.yml up --build
# then: AIFLOW_RENDER_URL_TEMPLATE=http://localhost:8080/render
```

> The service is network-reachable from Supabase Edge, so always set
> `AIFLOW_RENDER_TOKEN` in production. Credentials never leave the tenant's VPS
> process — they're used in-page to drive the login form and are never persisted
> or returned.
