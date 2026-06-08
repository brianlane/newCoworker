# AiFlow render service (optional)

Headless-Chromium HTTP service for the AiFlows `browse_extract` step. **Deferred
by the Phase-0 spike** — the default browse backend is a static fetch performed
inside `supabase/functions/ai-flow-worker`. Deploy this only when a lead page is
a JavaScript SPA whose contact data is not in the static HTML.

## Contract

Matches `supabase/functions/_shared/ai_flows/browse.ts` (`parseRenderResponse`):

```
POST /render
{ "url": "https://example.com/lead/123" }

200 -> { "finalUrl": "https://...", "text": "<innerText>", "html": "<html>" }
400 -> { "error": "invalid_or_unsafe_url" }
502 -> { "error": "render_failed", "detail": "..." }
```

The same SSRF host rules as the worker apply (http/https only; no
localhost / private-IPv4 / IPv6-literal / `*.internal` / metadata hosts).

## Enable

1. Build & run on the VPS Docker host (add as a compose service):
   ```
   docker build -t aiflow-render vps/aiflow-render
   docker run -d --name aiflow-render -p 8080:8080 aiflow-render
   ```
2. Point the worker at it (Supabase Edge env):
   ```
   AIFLOW_RENDER_URL=http://aiflow-render:8080/render
   ```

When `AIFLOW_RENDER_URL` is unset the worker falls back to a static `fetch`.
