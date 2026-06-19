# New Coworker

AI Coworker platform: local-first autonomous agents for small businesses, built on Rowboat + Ollama + Telnyx, with a VPS media bridge that pipes calls to **Gemini Live** (default model **`gemini-3.1-flash-live-preview`** on the Gemini API) when `GOOGLE_API_KEY` is configured on the bridge host (see `vps/voice-bridge/`).

This repository includes:

- Next.js dashboard app
- Supabase migrations and edge-function scaffolding
- VPS bootstrap and deployment scripts
- Rowboat, Telnyx (voice/SMS), and Supabase Edge integration code
- Local Docker integration fixtures for model validation

## Pricing

| Tier | 24mo | 12mo | 1mo | VPS |
|------|------|------|-----|-----|
| Starter | $9.99/mo | $10.99/mo | $15.99/mo | KVM 2 (2 vCPU, 8GB) |
| Standard | $99/mo | $109/mo | $195/mo | KVM 8 (8 vCPU, 32GB) |
| Enterprise | Custom | Custom | Custom | Custom |

See `src/lib/plans/tier.ts` for pricing logic.

## Architecture

- Agent runtime: Rowboat
- Local inference: Ollama
- Voice: Telnyx Call Control + VPS media bridge (Gemini Live real-time audio when the bridge has `GOOGLE_API_KEY`)
- Starter default model: `llama3.2:3b`
- Standard default model: `qwen3:4b-instruct`

Rowboat talks to a small `llm-router` sidecar on the VPS (`vps/llm-router/`) which forwards `gemini-*` traffic to Google's OpenAI-compatible endpoint and everything else to Ollama's `/v1` API. The SMS `dispatcher` agent stays on Ollama; the voice `voice_task` agent uses `GEMINI_ROWBOAT_MODEL` (default `gemini-3.1-flash`). No Bifrost layer.

### Voice knowledge + tools

- The voice bridge loads `/opt/rowboat/vault/{soul,identity,memory,website}.md` (mounted read-only from Rowboat's vault) and injects them into Gemini Live's system prompt on every call. Owners set the website URL during onboarding; `/api/onboard/website-ingest` crawls once (SSRF-guarded, robots-respecting) and stores a summary in `business_configs.website_md`, which is editable from `/dashboard/memory` → "Website Knowledge".
- Gemini Live calls typed tools exposed by the app under `/api/voice/tools/*` — `business_knowledge_lookup`, `calendar_find_slots`, `calendar_book_appointment`, `send_follow_up_email`, `send_follow_up_sms`, `capture_caller_details`. Calendar + email proxy through Nango (Google Workspace / Microsoft 365); SMS uses the metered Telnyx path; capture writes to `coworker_logs`. Authentication is a **per-tenant gateway token** (see [Per-tenant gateway tokens](#security-per-tenant-gateway-tokens)); the shared `ROWBOAT_GATEWAY_TOKEN` remains a fallback during the transition.
- See [docs/VOICE-ROLLOUT.md §9](docs/VOICE-ROLLOUT.md) for the Phase 2 rollout runbook.

## Testing

Run unit tests with:

```bash
npm test
```

Run Docker integration correctness with:

```bash
npm run test:integration
```

Useful variants:

```bash
npm run test:integration:kvm2
npm run test:integration:kvm8
npm run test:integration:persist
npm run test:integration:correctness
npm run test:integration:correctness:kvm2-llama32-compare
```

The integration path uses real Rowboat + Ollama stacks and writes assistant outputs to `test-results/integration-correctness-responses.json`.

## Operating the VPS fleet (`debug/`)

One-shot operational + diagnostic scripts for the live per-tenant VPS fleet
live in [`debug/`](debug/README.md). They run locally with `tsx`, read
credentials from the repo-root `.env`, and talk to the boxes over the
Hostinger API + SSH. They are **not** part of the app bundle and **not** under
the test coverage gate (coverage is scoped to `src/lib/**`); the reusable,
tested primitives they build on live in `src/lib/db/vps-ssh-keys.ts` and
`src/lib/hostinger/*`.

```bash
# Roll the latest main's chat-worker out to EVERY active VPS
tsx debug/update-all-vps.ts --dry-run   # preview targets
tsx debug/update-all-vps.ts             # update all (sequential)
tsx debug/update-all-vps.ts --concurrency=4

# Single tenant + diagnostics
tsx debug/deploy-worker.ts <businessId> # update one box
tsx debug/smoke-rule.ts  [businessId]   # e2e owner-rule memory-capture check
tsx debug/logs.ts        [businessId]   # tail worker memory/job logs
tsx debug/check-ollama.ts [businessId]  # verify Ollama reachable + JSON extraction
```

> ⚠️ These touch production (service-role key + plaintext VPS SSH keys, and
> they recreate live containers). See [`debug/README.md`](debug/README.md).

## Security standards & posture

The platform follows a **deny-by-default** model. New code is expected to uphold
these standards:

- **Database functions are `service_role`-only.** Every public-schema function
  revokes `EXECUTE` from `PUBLIC`/`anon`/`authenticated`; callable surfaces go
  through service-role clients, never `anon`/`authenticated` RPC. Enforced three
  ways: an initial lockdown
  (`supabase/migrations/20260618182009_lockdown_public_function_grants.sql`), an
  explicit `PUBLIC` revoke that closed a residual gap
  (`…20260618194058_lockdown_public_function_grants_revoke_public.sql`), and the
  `fn_grants_lockdown` `ddl_command_end` event trigger
  (`…20260629030000_…sql`, detailed below) that auto-revokes those grants on every
  newly created or altered function — so the `supabase_admin` default ACL can
  never silently re-open them again.
- **`search_path` is pinned** (`SET search_path = pg_catalog, public`) on public
  functions to block search-path-injection privilege escalation
  (`…20260618194956_pin_function_search_path.sql`, Supabase advisor 0011).
- **Row Level Security is on by default** with deny-by-default policies. Secret
  tables (`vps_gateway_tokens`, `vps_ssh_keys`) run RLS with **no policies**, so
  only `service_role` (which bypasses RLS) can read them.
- **Per-tenant gateway tokens** replace the old platform-wide shared secret for
  all VPS ↔ app authentication — see
  [Security: per-tenant gateway tokens](#security-per-tenant-gateway-tokens) for
  the table, inbound/outbound binding, PENDING→CONFIRMED lifecycle, and rotation.
- **Rate limiting** guards abuse-prone surfaces: a durable per-key limiter
  (`rateLimitDurable`, `…20260618184317_app_rate_limit.sql`) plus per-IP/route
  caps on Telnyx Edge webhooks (`TELNYX_WEBHOOK_RATE_MAX_PER_MINUTE` /
  `TELNYX_WEBHOOK_RATE_WINDOW_SEC`).
- **Cron / Edge auth**: scheduled Edge functions require `INTERNAL_CRON_SECRET`
  via `assertCronAuth`; `CRON_ALLOW_SERVICE_ROLE_BEARER` is dev-only and must stay
  **unset** in production.
- **Dependency hygiene**: Dependabot alerts are tracked to zero. Transitive
  vulnerabilities are pinned via root `package.json` `overrides` (e.g. `postcss`)
  or by bumping the owning tool when a dependency is implicitly pinned (e.g.
  `wrangler` for the email worker).

## Security: per-tenant gateway tokens

Historically every tenant VPS shared one platform-wide `ROWBOAT_GATEWAY_TOKEN`. That
token is used three ways: (1) the bearer on VPS → app calls (`/api/voice/tools/*`,
the Nango proxy, custom-integration credentials/call, `aiflows/send-owner-email`,
and `/api/provisioning/progress`); (2) the HMAC secret Rowboat signs its tool-call
JWT (`x-signature-jwt`) with; and (3) the API key the platform uses for app → Rowboat
calls (chat/customer-memory summarizers). A single shared token means a compromise of
**one** tenant VPS could impersonate **every** other tenant.

**What changed**

- **`vps_gateway_tokens` table** (`supabase/migrations/20260629020000_vps_gateway_tokens.sql`):
  stores a distinct token per `business_id`. RLS is on with **no policies**, so
  `anon`/`authenticated` get nothing — only `service_role` (which bypasses RLS) can
  read it, identical posture to `vps_ssh_keys`. The plaintext token is stored because
  it doubles as the symmetric HMAC secret (needs the same value on both sides);
  `token_sha256` is the O(1) bearer-lookup index.
- **Inbound binding**: VPS → app endpoints now resolve the presented bearer (or the
  JWT's `projectId`) to a specific business and reject it if it's a *known per-tenant
  token bound to a different business*. Helpers: `verifyGatewayTokenForBusiness`,
  `gatewayBusinessGuard`, and `resolveRowboatWebhookClaims` (the single inbound gate —
  the old shared-only `gatewayGuard` was removed so it can't reject a valid per-tenant
  bearer). This closes the cross-tenant impersonation gap.
- **Outbound binding**: app → Rowboat calls resolve the tenant's token via
  `resolveOutboundRowboatBearer(businessId)`.
- **The JWT path is EXCLUSIVE; the bearer path is NOT.** The shared `ROWBOAT_GATEWAY_TOKEN`
  is a **platform-internal** secret: it lives in the app env and is presented by trusted
  platform callers (notably the Supabase `ai-flow-worker` edge function, which calls
  `/api/aiflows/*` and `/api/integrations/custom/call` on behalf of **every** tenant). It is
  **never** deployed to a tenant VPS — provisioning injects each box's own per-tenant token
  as its `ROWBOAT_GATEWAY_TOKEN`. Therefore:
  - **Bearer** (`verifyGatewayTokenForBusiness`): a known per-tenant token must match its
    business (binding check — this is the cross-tenant guard); otherwise the shared token is
    accepted. It is intentionally not exclusive, so platform callers keep working for migrated
    tenants. A transient DB read error fails open to the shared check.
  - **JWT** (`resolveRowboatWebhookClaims`): once a project has a **confirmed** per-tenant
    secret, the JWT is verified **only** against its per-tenant token(s) — the shared secret is
    rejected. This is exclusive because the HMAC secret is forgeable by anyone who knows the
    shared value, and Rowboat tool-call JWTs are signed on the (per-tenant) VPS, never by the
    platform edge worker. Exclusivity is gated on *confirmed* (not merely pending) because the
    box keeps signing with the shared secret until the deploy that injects the per-tenant token
    finishes (see lifecycle below).
- **A token has a PENDING → CONFIRMED lifecycle (`deployed_at`)** so the DB never gets ahead
  of the VPS (`supabase/migrations/20260629050000_…sql`):
  - Provisioning reads the business's existing token (`getActiveGatewayTokenForBusiness`,
    pending **or** confirmed) or mints + inserts a fresh **pending** one (`issueGatewayToken`,
    `deployed_at` NULL) BEFORE `deploy-client.sh` runs — the same token is the in-deploy
    progress-callback bearer (`/api/provisioning/progress`), which authenticates via the
    inbound binding (pending tokens still bind).
  - While the token is pending, **outbound** app→Rowboat calls keep using the confirmed
    secret the box is still on (`getDeployedGatewayTokenForBusiness` returns only confirmed
    tokens), so a half-finished deploy never points summarizers at a token the box doesn't have.
  - **Tool-call JWT** verification (`resolveRowboatWebhookClaims`) checks the JWT against
    **every** non-revoked token for the project — pending *and* confirmed
    (`getActiveGatewayTokensForProject`) — because the VPS starts signing with a freshly
    deployed token the moment Rowboat restarts (before the app confirms it), and during a
    rotation an old + new token briefly coexist. The shared secret is **still accepted while
    the project has no confirmed token** (`hasConfirmed` false): a pending row exists from the
    moment provisioning inserts it, but the box keeps signing with the shared secret for the
    whole (multi-minute) deploy — rejecting it then would 401 every tool-call during a first
    migration. The instant the first token is confirmed, the box has switched to it and the
    shared secret is rejected forever. The lookup resolves the owning business via
    `business_configs.rowboat_project_id` (which can be re-pointed) and falls back to treating
    the project id as the business id.
  - On a **successful** deploy the orchestrator calls `markGatewayTokenDeployed`, which runs
    the `confirm_gateway_token` SQL function (`supabase/migrations/20260629060000_…sql`,
    hardened by `…070000_confirm_gateway_token_guard.sql`) to revoke any older token and stamp
    `deployed_at` **atomically** in one transaction — flipping outbound over to the per-tenant
    secret without a zero-confirmed-token window. The function first verifies the target token
    is a live row and raises (rolling back) otherwise, so a wrong/missing token can never
    revoke the only confirmed secret and strand the tenant. A confirm failure *after* a
    successful deploy is **non-fatal**: provisioning logs it and finishes (the box already
    serves the new, still-pending secret that inbound JWT verification accepts), leaving the
    pending token for the next idempotent reprovision to re-confirm. A failed deploy leaves
    the pending token for the next attempt to **reuse** + redeploy (idempotent, self-healing).
    A DB error during the initial mint aborts provisioning (no shared-token fallback). There
    is no DB-only seed path.
  - **Tool-call dispatch resolves the owning business**, not the raw project id. The JWT's
    `projectId` claim is `business_configs.rowboat_project_id` (re-pointable), so both secret
    resolution AND tool gating/dispatch go through `resolveBusinessIdForRowboatProject` —
    otherwise a re-pointed project could authenticate yet run tools against the wrong tenant.
- **One CONFIRMED token per business** is enforced by the partial unique index
  `uq_vps_gateway_tokens_deployed_business` (`where revoked_at is null and deployed_at is not
  null`), so two tenants can't end up with competing live secrets. `issueGatewayToken` is
  insert-only (never revoke-before-insert), so a failed insert never leaves a business with
  zero active tokens; revocation of the old token happens only in `markGatewayTokenDeployed`,
  after the new one is confirmed.
### Accessing / rotating Rowboat on each VPS

Every tenant box authenticates with its **own** unique gateway token — there is no
longer a single shared secret on any VPS. The same per-tenant token value is, on each
box (written by `deploy-client.sh`):

- the box's `ROWBOAT_GATEWAY_TOKEN` in `/opt/rowboat/.env` and `/opt/chat-worker/.env`,
- the Rowboat project **`secret`** (the HMAC key it signs tool-call JWTs with) and its
  `api_keys` row (the bearer it accepts on VPS → app calls),
- the `AIFLOW_GATEWAY_TOKEN` for the render sidecar.

The plaintext + `token_sha256` live in `vps_gateway_tokens` (service-role-only). To talk
to a tenant's Rowboat from the platform, resolve its token with
`resolveOutboundRowboatBearer(businessId)` (confirmed token, else the platform env
fallback for any not-yet-migrated box); never hard-code the shared value.

**Rotating a box's token** is just a redeploy — `scripts/redeploy-deploy-client.ts` (and
the provisioning orchestrator) **mint-or-reuse** the business's per-tenant token, inject
it as the box's `ROWBOAT_GATEWAY_TOKEN`, and **confirm** it (`markGatewayTokenDeployed`)
only after a healthy deploy:

```bash
set -a && source .env && set +a
npx tsx scripts/redeploy-deploy-client.ts --business <uuid> --ref main
```

Because the redeploy injects the **DB** per-tenant token (not the shared env value), a
routine fleet redeploy never re-stamps the shared secret over a rotated tenant, and
running it against a legacy box still on the shared token transparently rotates it onto
a fresh unique one.

- **Existing live tenant (`621a5b0d-…`) has been rotated** off the shared token onto its
  own confirmed per-tenant token (`vps_gateway_tokens`, `deployed_at` set) via the
  `redeploy-deploy-client.ts` path above — verified by matching the on-box
  `ROWBOAT_GATEWAY_TOKEN` SHA-256 to the DB `token_sha256`. New tenants get this from the
  first provision; no box runs the shared secret anymore.

**`fn_grants_lockdown` event trigger** (`supabase/migrations/20260629030000_…sql`):
a `ddl_command_end` event trigger that revokes `EXECUTE` from `public`/`anon`/
`authenticated` on every new or altered **public** function (extension-owned functions
skipped). This permanently closes the recurrence where `supabase_admin`'s default ACL —
which the migration role can't `ALTER` — kept re-granting `anon`/`authenticated`
EXECUTE on freshly created functions. Policy: public functions are **service_role-only**;
callable surfaces go through service-role clients, never `anon`/`authenticated` RPC.

## Production checklist (high level)

- Set **`INTERNAL_CRON_SECRET`** for scheduled invocations of Edge functions that use `assertCronAuth` (e.g. `sms-inbound-worker`, **`voice-settlement-sweep`** — runs **`voice_run_maintenance_sweeps`** for stale settlements, zombie **`voice_active_sessions`**, stale **`voice_reservations`**, stuck **`sms_inbound_jobs`**, and expired **`stream_url_nonces`** — **`voice-low-balance-alerts`**, **`telnyx-voice-failover`**). Do **not** set **`CRON_ALLOW_SERVICE_ROLE_BEARER`** in production — that flag exists only so local dev can reuse the service role as the bearer when no dedicated cron secret is configured.
- Schedule **`voice-low-balance-alerts`** with the same cron auth; set Edge secrets **`RESEND_API_KEY`**, **`MAILER_EMAIL`**, **`CONTACT_EMAIL`** (optional reply-to) so owners get email when included voice headroom drops below **300s** (`low_balance_alert_armed` is cleared after send).
- **`telnyx-voice-failover`**: default **`mode: "speak"`** (or omit `mode`) runs §8 **maintenance `answer` + `speak`** with optional **`VOICE_FAILOVER_MAINTENANCE_MESSAGE`**. **`mode: "transfer"`** + **`TELNYX_FAILOVER_CONNECTION_ID`** (or body `connection_id`) moves the call to a backup Connection. POST JSON `{ "call_control_id": "…", "mode"?: "speak" | "transfer" }`.
- **`stream_url_nonces`**: expired rows are deleted by **`stream_url_nonces_prune_expired`**, invoked from **`voice_run_maintenance_sweeps`** (same schedule as **`voice-settlement-sweep`**). Response JSON includes **`stream_url_nonces_pruned`** (row count).
- Telnyx Edge webhooks use **`telnyx_webhook_try_begin` / `telnyx_webhook_mark_complete`** (claim + completion) so transport retries can finish work; duplicate **completed** events short-circuit. Concurrent deliveries for the same event may receive **503** until the claim lease expires — Telnyx should retry. Optional env: **`TELNYX_WEBHOOK_RATE_MAX_PER_MINUTE`**, **`TELNYX_WEBHOOK_RATE_WINDOW_SEC`** (defaults: 240 per minute per IP per route).
- Structured **`telemetry_events`** (via `telemetry_record` RPC) include: `edge_webhook_rejected` (reason: `size` \| `rate` \| `concurrent_claim`), `telnyx_webhook_signature_reject` (class: `malformed` \| `crypto_mismatch`), `jit_stripe_fail_proceed_cached` / `jit_stripe_fail_block`, `voice_answer_fail`, `voice_concurrent_limit_spoken`, `voice_rollout_stream_disabled`, `voice_mark_answer_issued_fail`, `sms_outbound_reconciled_after_error`, `sms_inbound_*_keyword`, and voice settlement events — wire dashboards/alerts to these types.
- Rollout / kill switches: Edge secret **`VOICE_AI_STREAM_ENABLED=false`** → `telnyx-voice-inbound` answers with speak-only (no stream). Bridge env **`GEMINI_LIVE_ENABLED=false`** → media WebSocket stays up but Gemini Live audio is off.
- Voice bridge deploy: `deploy-client.sh` rsyncs **`${VOICE_BRIDGE_SRC:-/opt/newcoworker-repo/vps/voice-bridge}`** → `/opt/voice-bridge`, rewrites `.env` (so rotated secrets land), runs `docker compose up -d --build --force-recreate`, and polls `http://127.0.0.1:8090/` for up to 40s before marking the deploy healthy. Operators are responsible for staging the repo at `VOICE_BRIDGE_SRC` (bootstrap-time git clone, rsync from orchestrator, or gold-image bake). If no source is present the script logs and skips, matching the pre-Telnyx behavior.
- Telnyx Call Control has **one** webhook URL per Application, but voice events are split across two handlers (`telnyx-voice-inbound` for `call.initiated`, `telnyx-voice-call-end` for `call.hangup`/`call.ended`). Point Mission Control at **`telnyx-voice-dispatch`**; it extracts `data.event_type`, forwards the raw body + Telnyx signature headers to the matching function on the same Supabase project, and returns the upstream response unchanged. The target functions verify the signature themselves — the dispatcher is a routing layer only. Optional env **`DISPATCH_FORWARD_BEARER`** injects an `Authorization` header if the targets were deployed with JWT verification enabled.
- SMS keyword auto-replies (**STOP** / **HELP** / **START**) need **`TELNYX_API_KEY`**, **`TELNYX_MESSAGING_PROFILE_ID`**, and **`TELNYX_SMS_FROM_E164`** on the `telnyx-sms-inbound` function; without them the handler still returns **200** but logs a warning.
- After first-time deploy (or any time you reset the cache columns), backfill `subscriptions.stripe_current_period_{start,end}` from Stripe so voice quota gating works before the next subscription lifecycle webhook runs: `npx tsx scripts/backfill-stripe-subscription-periods.ts` (dry-run), then re-run with `--apply`. Requires `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`.

## Telnyx voice inbound (ops note)

**§6 HTTP semantics (shipped vs matrix shorthand):** The failure matrix highlights **403** for **bad webhook signature** (no processing, no answer). For many **logical** failures after verify (unknown DID, quota, bridge unhealthy, etc.), the handler deliberately returns **HTTP 200** with Telnyx **`hangup` / `speak`** (or equivalent) so Telnyx treats delivery as successful and **does not** retry the webhook as a transport failure—see Telnyx [webhook retries](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks). That is an intentional tradeoff: clearer PSTN UX and less duplicate traffic vs strict “non-2xx for every failure class.”

The `telnyx-voice-inbound` function may return **HTTP 200** with a Telnyx `hangup`/`reject` action for logical failures (missing fields, subscription/period gating) for the same reason. Hard failures after answer may still surface as **5xx**; rely on logs and telemetry for diagnosis.


## All work and code modifications must follow this flow

For any changes always Branch -> PR -> babysit CI + Bugbot to green -> merge (per PR merge policy). Then after the successful merge apply migrations, deploy functions, vps needed redeploy, seed etc