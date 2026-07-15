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

Billing model (Hostinger-consistent): **12/24-month plans are charged in full
at checkout** (e.g. Standard 24mo = $2,376 today) because the tenant's VPS is
prepaid for the whole contract — the Stripe prices use `interval=month` with
`interval_count=12|24` (`scripts/oneshot/create-term-prices.ts`). Included
usage (voice minutes, shared AI budget, SMS) still resets **monthly** via
`deriveMonthlyQuotaWindow` (`supabase/functions/_shared/billing_period_window.ts`;
inline copies in `vps/chat-worker/worker.mjs` and `vps/voice-bridge/src/index.ts`
must stay in lockstep). After the term, service rolls month-to-month at the
higher renewal rate (`*_RENEWAL_PRICE_ID` via `ensureCommitmentSchedule`)
unless auto-renew is on or the owner starts a new contract at the contract
rate.

## Architecture

- Agent runtime: Rowboat
- Local inference: Ollama
- Voice: Telnyx Call Control + VPS media bridge (Gemini Live real-time audio when the bridge has `GOOGLE_API_KEY`)
- KVM2 / KVM4 local fallback model: `llama3.2:3b` (KVM1 ships no local model)
- KVM8 local fallback model: `qwen3:4b-instruct`

Rowboat talks to a small `llm-router` sidecar on the VPS (`vps/llm-router/`) which forwards `gemini-*` traffic to Google's OpenAI-compatible endpoint and everything else to Ollama's `/v1` API. The SMS `dispatcher` agent stays on Ollama; the voice `voice_task` agent uses `GEMINI_ROWBOAT_MODEL` (default `gemini-3.1-flash`). No Bifrost layer.

### Voice knowledge + tools

- The voice bridge loads `/opt/rowboat/vault/{soul,identity,memory,website}.md` (mounted read-only from Rowboat's vault) and injects them into Gemini Live's system prompt on every call. Owners set the website URL during onboarding; `/api/onboard/website-ingest` crawls once (SSRF-guarded, robots-respecting) and stores a summary in `business_configs.website_md`, which is editable from `/dashboard/memory` → "Website Knowledge".
- Gemini Live calls typed tools exposed by the app under `/api/voice/tools/*` — `business_knowledge_lookup`, `calendar_find_slots`, `calendar_book_appointment`, `send_follow_up_email`, `send_follow_up_sms`, `capture_caller_details`. Calendar + email proxy through Nango (Google Workspace / Microsoft 365, plus **Calendly** as a calendar provider: slot search uses the event type's available times, and "booking" returns a **single-use scheduling link** — detail `booking_link_created` — that the agent texts to the customer, since Calendly cannot create bookings on the invitee's behalf). Calendly also connects **directly** without Nango: the owner pastes a Personal Access Token on `/dashboard/integrations` (`calendly_connections`, token encrypted at rest; transport in `src/lib/calendly/client.ts`, resolver key `calendly-direct`) — same tool behavior, zero OAuth-app setup. SMS uses the metered Telnyx path; capture writes to `coworker_logs`.
- **Vagaro** connects directly (no Nango, no Zapier): the owner pastes their merchant Client ID/Secret on `/dashboard/integrations` (`vagaro_connections`, secret encrypted at rest; client-credentials token manager in `src/lib/vagaro/client.ts`). When connected, Vagaro **wins calendar-provider resolution** — `calendar_find_slots` runs a real availability search and `calendar_book_appointment` creates the appointment on the merchant's book (owner-picked default service, else closest duration match). Inbound Vagaro webhooks land on `/api/webhooks/vagaro?business=…&token=…` (per-tenant verification token), start `webhook`-channel AiFlows with `source: "vagaro"`, and sync customer events into contacts. Requires the merchant's Vagaro APIs & Webhooks access (Vagaro-gated approval). Authentication is a **per-tenant gateway token** (see [Per-tenant gateway tokens](#security-per-tenant-gateway-tokens)); the shared `ROWBOAT_GATEWAY_TOKEN` remains a fallback during the transition.
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

## Data residency (enterprise, opt-in)

Enterprise tenants can opt in to **physical data residency**: their customer
content (contacts, conversations, transcripts, emails — the
`RESIDENCY_MOVED_TABLES` in [src/lib/residency/tables.ts](src/lib/residency/tables.ts))
lives in a Postgres on THEIR OWN VPS, fronted by a bearer-authenticated data
API published on the tenant tunnel at `data-<businessId>.<zone>` →
`127.0.0.1:8091` ([vps/data-api/](vps/data-api/)). Off by default for
everyone; the enterprise-only gate is enforced server-side
([src/lib/residency/tier-gate.ts](src/lib/residency/tier-gate.ts)).

`businesses.data_residency_mode` drives the rollout, flipped from the admin
business page (Data residency card) or `POST /api/admin/data-residency`:

- **`supabase`** (default) — everything central; code path byte-identical to
  pre-residency.
- **`dual`** — DB triggers journal every content write to
  `residency_write_journal`; a per-minute cron (`residency-replay` Edge fn →
  `/api/internal/residency-replay`) drains it to the box in strict order.
  A down box only lags (journal grows, drain resumes); it never loses or
  reorders. Confirmed rows are deleted — central holds content in transit,
  not at rest.
- **`vps`** — dashboard content reads come FROM THE BOX
  ([src/lib/residency/read.ts](src/lib/residency/read.ts)), with **no silent
  fallback**: a down box is a visible error, never stale central data.

Per-tenant enablement runbook (one deal at a time, no fleet rollout):
1. flip `dual` → `npx tsx debug/residency-backfill.ts --business <id> --drain`
2. gate: `npx tsx debug/residency-parity.ts --business <id>` must PASS
3. flip `vps` (reads now from the box; redeploy publishes the tunnel hostname
   + stack via the same orchestrator/redeploy env gates)
4. purge central history: `npx tsx debug/residency-purge.ts --business <id> --apply`
   (parity-gated, journal-must-be-empty, trigger-muted so the purge never
   replicates as deletes; live engine state — contacts, threads, chat, flows —
   deliberately stays central until the engine's own reads are residency-routed)

DR: a 6h systemd timer on the box streams `pg_dump → gzip → AES-256` and
uploads **ciphertext only** to `business-backups/residency/<id>/`; the
passphrase is escrowed in `residency_backup_keys` (service-role-only,
rotatable per deal). Per-deal compliance knobs (`POST /api/admin/residency-backup`):
`residency_backup_destination='onbox'` keeps even ciphertext on the box
(in-region for Canadian tenants), and `custody='customer_held'` drops the
plaintext passphrase forever (fingerprint only — the customer owns DR).
Canadian (`vps_region='ca'`) and BYOS placements REQUIRE residency ≥ `dual`
before provisioning; see [docs/COMPLIANCE-CANADA.md](docs/COMPLIANCE-CANADA.md)
for the full data-flow map, subprocessor list, and contract artifacts. Restore with `npx tsx debug/residency-restore.ts
--business <id> [--apply]`. Hardware migrations for residency tenants FAIL
CLOSED in `migrate-vps-size` — the box datastore is the only copy of purged
history, so the move is manual: fresh backup → migrate → restore → flip.

## Operating the VPS fleet (`debug/`)

One-shot operational + diagnostic scripts for the live per-tenant VPS fleet
live in [`debug/`](debug/README.md). They run locally with `tsx`, read
credentials from the repo-root `.env`, and talk to the boxes over the
Hostinger API + SSH. They are **not** part of the app bundle and **not** under
the test coverage gate (coverage is scoped to `src/lib/**`); the reusable,
tested primitives they build on live in `src/lib/db/vps-ssh-keys.ts` and
`src/lib/hostinger/*`.

One-shot ledger — a new `applied_oneshots` table (service-role only) plus
`scripts/oneshot/_ledger.ts`; the active flow-patching scripts now record
every `--apply` with the business and the patched flow IDs. "Has this run
everywhere?" is a one-line query going forward.

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

> ⚠️ These touch production (service-role key + decryptable VPS SSH keys via
> `SECRETS_ENCRYPTION_KEY`, and they recreate live containers). Before running
> or writing anything here, read the **Security rules (agents & operators)**
> section of [`debug/README.md`](debug/README.md) — key handling, no-secret-
> output, mandatory SSH host-key pinning, custody semantics, and the dry-run
> convention.

## Security: posture summary (buyer-facing)

The narrative below is the sales/questionnaire-ready synthesis of the controls
detailed in the sections that follow. Keep it in lockstep with the code — it is
shown to prospects' security reviewers, so nothing in it may overstate what
ships.

> **Your customers' data lives where you can point to it.** New Coworker is
> built around per-tenant physical isolation: every business runs on its own
> dedicated server with its own SSH keypair, its own gateway credential, and
> its own outbound-only tunnel — one credential opens exactly one box, so no
> tenant's compromise can reach another's data. For enterprise deals with
> residency requirements, the sensitive layer — contacts and AI memory, call
> transcripts, SMS and email content — physically resides on a Canadian server
> or on hardware you own, with a documented migration and purge runbook,
> parity verification before cutover, and encrypted disaster-recovery dumps
> whose decryption key you can choose to hold yourself: in that mode we keep
> only a fingerprint and provably cannot read your backups. Bring-your-own-
> server placements aren't taken on trust — an automated preflight verifies
> disk encryption, co-tenancy, and hardware posture before any data lands, and
> hourly posture reports alert on drift afterward.
>
> **Defense in depth, verified rather than promised.** Every stored secret
> gets two independent layers: the database denies by default (row-level
> security everywhere, secret tables readable by no client role at all, an
> event trigger that automatically re-locks any new function), and on top of
> that, SSH private keys and backup passphrases are wrapped in application-
> layer AES-256-GCM encryption — a database dump alone exposes nothing, and
> reads fail closed rather than ever handing ciphertext to a live system.
> Fleet operations are protected against network interception end to end:
> each server's SSH host key is captured at provision and every subsequent
> platform connection — deploys, backups, wipes — verifies it strictly, so a
> machine-in-the-middle produces a loud, typed failure instead of a session.
> Tenant servers expose no public attack surface (default-deny firewall, all
> services loopback-bound, ingress via outbound-only tunnel), telecom
> webhooks are signature-verified and rate-limited, and the production
> database passes its security advisor with zero extension/configuration
> warnings on our side of the fence.
>
> **Privacy is operational, not aspirational.** Data lifecycle controls exist
> as running code: configurable per-tenant retention windows automatically
> prune aged transcripts, messages, and email history — on the tenant's own
> server too, not just centrally; a verified end-user erasure request deletes
> one person across every content table on both stores, and the audit trail
> records a cryptographic fingerprint rather than re-creating the identifier
> it erased. Account cancellation ends in a real wipe — data, backups, phone
> numbers, and (for BYOS) the box itself. The baseline is where you'd expect
> it: TLS on every hop, payments fully delegated to Stripe so card data never
> touches the platform, role-based authorization with security-logged
> refusals, and a published subprocessor list with honest cross-border
> disclosure (AI voice processing and telecom carriage) ready for your
> privacy officer's assessment. All of it is held in place by engineering
> guardrails — a 100%-coverage test gate, static security analysis, and
> automated review on every change — so the posture you're buying is the
> posture that ships next month too.

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
- **App-layer encryption at rest for stored secrets**: `vps_ssh_keys.private_key_pem`
  and `residency_backup_keys.passphrase` are wrapped in an AES-256-GCM envelope
  keyed by `SECRETS_ENCRYPTION_KEY` ([src/lib/crypto/secret-encryption.ts](src/lib/crypto/secret-encryption.ts)) —
  a DB dump or leaked service-role key alone no longer exposes them. Reads
  fail closed on undecryptable rows; plaintext pass-through exists only for
  rollout ordering (the production stock was converted via
  `debug/encrypt-secrets-backfill.ts --apply`, which is idempotent for any
  future re-run). Gateway tokens stay plaintext BY DESIGN (the value itself
  is the symmetric HMAC secret on the box).
- **Data lifecycle: retention windows + end-user erasure (admin-only).**
  `businesses.data_retention_days` (min 30, NULL = keep forever) is enforced
  by a daily sweep (pg_cron → Edge `data-retention-sweep` → internal Next
  route → [src/lib/privacy/retention.ts](src/lib/privacy/retention.ts)) that
  prunes content history past the window — on the tenant's box too for
  dual/vps residency tenants; contacts are exempt. Verified privacy requests
  (PIPEDA / Law 25 / CCPA erasure) run through
  [src/lib/privacy/deletion.ts](src/lib/privacy/deletion.ts) via
  `POST /api/admin/data-deletion`: one person's rows are deleted across every
  content table, central AND box, matching identifiers literally
  (ILIKE-escaped) including phone aliases; the `coworker_logs` audit row
  stores a sha256 fingerprint of the identifier, never the identifier itself.
  An unreachable residency box fails the request loudly instead of reporting
  a false "deleted".
- **"RLS enabled, no policies" is the deny-all design, not an oversight.** The
  Supabase advisor reports INFO-level `rls_enabled_no_policy` findings for a
  set of service-role-only tables (secret stores like `vps_ssh_keys`,
  `vps_gateway_tokens`, `residency_backup_keys`, `api_keys`; tenant content
  like `voice_call_transcripts`, `email_log`, `sms_outbound_log`,
  `customer_profiles`; and operational tables like `vps_inventory`,
  `data_backups`, `webhook_subscriptions`). These tables are **never** read
  through the anon/authenticated PostgREST path — every access goes through
  the Next.js server (service role) after its own auth checks. RLS enabled +
  zero policies means anon/authenticated roles get an unconditional deny at
  the database layer; adding policies would only widen access. Auditors
  should read those INFO findings as confirmation the lockdown is active.
- **Extensions live outside `public`** (`citext`, `pg_net` → `extensions`
  schema, advisor 0014) so extension objects can't be shadowed by or confused
  with application objects; pg_net's callable surface stays in its own `net`
  schema by design.
- **Per-tenant gateway tokens** replace the old platform-wide shared secret for
  all VPS ↔ app authentication — see
  [Security: per-tenant gateway tokens](#security-per-tenant-gateway-tokens) for
  the table, inbound/outbound binding, PENDING→CONFIRMED lifecycle, and rotation.
- **Per-VPS box hardening** (UFW default-deny, outbound-only tunnel, key-only
  SSH, root-only secrets) is provisioned identically on every box — see
  [Security: per-VPS box hardening & isolation](#security-per-vps-box-hardening--isolation).
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

## Security: per-VPS box hardening & isolation

Every tenant VPS gets an identical, automatically-provisioned security posture
— nothing is hand-configured per machine, and everything revocable is
controlled centrally (DB/API operations, no SSH session required). Layers, in
order from the wire inward:

- **Network — default-deny, one inbound port.**
  [bootstrap.sh](vps/scripts/bootstrap.sh) enables UFW with
  `default deny incoming`; the only inbound rule is SSH/22, plus an internal
  allowance for the Docker bridge subnet to reach host Ollama (:11434). Any
  80/443 rules are explicitly deleted. Every service on the box (Rowboat
  :3000, voice bridge :8090, aiflow-render :8080, residency data-api :8091,
  llm-router :11435) binds `127.0.0.1` or the private Docker network only —
  there is no public web surface. The residency Postgres binds no host port
  at all.
- **Ingress — outbound-only Cloudflare tunnel.** The box never accepts an
  inbound internet connection: `cloudflared` dials OUT to Cloudflare, and the
  per-tenant tunnel's ingress rules (managed remotely via the CF API,
  `config_src=cloudflare` — [tunnel.ts](src/lib/cloudflare/tunnel.ts)) map the
  `<biz>`, `voice-`, `render-`, and `data-` hostnames to loopback ports.
  Hostnames exist only for services that actually run on that box (no render
  hostname on starter, no data hostname without residency), so a public route
  can never point at a nonexistent backend.
- **SSH — per-box keys, no passwords.** Provisioning mints a unique ed25519
  keypair per VPS (`vps_ssh_keys`, RLS-on/no-policies) and a hardened sshd
  drop-in enforces `PasswordAuthentication no`,
  `PermitRootLogin prohibit-password` (key-only root — the orchestrator
  deploys as root with the per-box key), `MaxAuthTries 3`, and no X11/TCP
  forwarding; the drop-in is `sshd -t`-validated before reload so a bad
  config can't lock the fleet out. fail2ban bans brute-forcers,
  unattended-upgrades patches the OS, and Hostinger's Monarx malware scanner
  is installed at purchase.
- **SSH host-key pinning — TOFU at provision, strict after.** The box's host-key
  fingerprint is captured on the first connection after a (re)provision and
  stored on the key row (`vps_ssh_keys.host_key_fingerprint`); every later
  platform SSH (deploys, backups, wipes, probes, vault sync) verifies strictly
  against it via [src/lib/hostinger/ssh-pinned.ts](src/lib/hostinger/ssh-pinned.ts).
  A mismatch aborts with a typed `HostKeyMismatchError`. Known caveat: the very
  first connection to a fresh image is trust-on-first-use — the pin closes the
  MITM window for the fleet's steady state, not that initial handshake. Flows
  that re-image a box clear the pin (adopt/recreate, BYOS host corrections);
  fresh provisions start on a new unpinned row.
- **Application auth — one unique bearer per tenant.** Each box's
  `ROWBOAT_GATEWAY_TOKEN` is its own 256-bit token (next section): it
  authenticates platform→box calls, signs the box's tool-call JWTs, and
  authenticates box→platform callbacks. **One token opens one box** — a
  compromised VPS can impersonate only its own tenant. The residency data-api
  additionally does a timing-safe multi-token check (rotation overlap), rate
  limits every route, and rejects any table outside the moved-tables
  whitelist.
- **Secrets on the box.** Every `.env` written by
  [deploy-client.sh](vps/scripts/deploy-client.sh) is `chmod 600` root-only,
  and a box holds only **its own** credentials — its gateway token, tunnel
  token, and backup passphrase; never another tenant's, and never central DB
  credentials. Residency backups are AES-256-encrypted on-box before upload,
  so central Storage only ever holds ciphertext.
- **Central control & revocation.** Rotating/revoking a gateway token,
  deleting a tunnel, expiring an SSH key, pausing a tenant, or flipping
  residency mode are all central DB/API operations.

Two honest caveats: (1) the Cloudflare Access service-token edge gate on
`data-*` hostnames (defense-in-depth in front of the bearer check) is
deferred until the residency client plumbing needs it — the bearer gate alone
protects the data plane today; (2) SSH keys, gateway tokens, and backup
passphrases are escrowed centrally, so per-box isolation protects tenants
from **each other** and shrinks a single-box compromise to one tenant — it
does not remove the platform as the root of trust.

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

## AiFlow webhook trigger (Meta Lead Ads etc.)

AiFlows can start from an inbound webhook: `POST /api/public/v1/flow-events`
(bearer = the tenant's `nck_` public API key) enqueues a run for every enabled
`webhook`-channel flow whose conditions match; the JSON payload is flattened
into `{{trigger.windowText}}` so `extract_text` parses lead fields with no
browser. This is how Meta (Facebook/Instagram) Lead Ads reach the flow engine —
via a Zapier ("Send Lead to Coworker" action) or Make.com bridge, no Meta App
Review required. The canonical, owner-facing setup doc is the in-app guide at
`/dashboard/aiflows/guides/meta-leads` (installs the starter flow, mints the
key, walks the bridge setup, and shows deliveries live).

## Telnyx voice inbound (ops note)

**§6 HTTP semantics (shipped vs matrix shorthand):** The failure matrix highlights **403** for **bad webhook signature** (no processing, no answer). For many **logical** failures after verify (unknown DID, quota, bridge unhealthy, etc.), the handler deliberately returns **HTTP 200** with Telnyx **`hangup` / `speak`** (or equivalent) so Telnyx treats delivery as successful and **does not** retry the webhook as a transport failure—see Telnyx [webhook retries](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks). That is an intentional tradeoff: clearer PSTN UX and less duplicate traffic vs strict “non-2xx for every failure class.”

The `telnyx-voice-inbound` function may return **HTTP 200** with a Telnyx `hangup`/`reject` action for logical failures (missing fields, subscription/period gating) for the same reason. Hard failures after answer may still surface as **5xx**; rely on logs and telemetry for diagnosis.

## Budget enforcement (SMS / voice / AI)

System-level, per-business budget gates apply to ALL relevant traffic regardless of whether an AiFlow is involved:

- **Voice (hard refuse):** every inbound/outbound call that uses Google/Gemini voice must pass `voice_reserve_for_call` / `reserveVoiceBudget` ([supabase/functions/_shared/voice_reserve.ts](supabase/functions/_shared/voice_reserve.ts)) BEFORE the leg is established. No budget → the call/leg is not established (see the Telnyx voice inbound ops note above). Outbound AiFlow calls (`outbound_call` voice step) originate via [telnyx-voice-originate](supabase/functions/telnyx-voice-originate/index.ts): it first runs a READ-ONLY pre-dial probe (`checkVoiceBudgetAvailable` → the `voice_check_availability` RPC) so an over-budget tenant's callee is never even rung, then dials, captures the `call_control_id`, then `reserveVoiceBudget` BEFORE answer/media — the post-dial reserve is the AUTHORITATIVE gate (the probe is best-effort: an `indeterminate` result falls through to dial because the reserve hangs the leg up before answer if refused, so no minutes are billed). Outbound flows can be placed manually ("Place call") or auto-dialed on a schedule: the `ai-flow-worker` `enqueueDueOutboundCalls` sweep places the call on each due occurrence with exactly-once via the `voice_outbound_dial_log` ledger (unique `flow_id, dedupe_key`), then calls the same origination function.
- **SMS (hard stop at the monthly cap):** every customer-facing outbound SMS atomically reserves a slot via `try_reserve_sms_outbound_slot` (row-locked monthly cap + pre-increment) before hitting Telnyx; on `monthly_sms_limit` the send is refused (the reply is suppressed and the owner gets a one-time cap alert). This is parity with voice — a hard stop on the actual SMS limit, independent of how the reply text was generated. Enforced at every customer-facing send site:
  - Node: `sendTelnyxSms(..., { meterBusinessId })` — `app/api/dashboard/messages/send`, `app/api/voice/tools/sms`, `app/api/rowboat/tool-call`.
  - Edge: `sms-inbound-worker` (AI reply) and `ai-flow-worker` (`send_sms` / group SMS to the lead, and team-offer SMS) reserve via the `try_reserve_sms_outbound_slot` RPC.
- **AI chat spend (graceful degrade, NOT a hard stop):** when a business is over its AI token budget, the SMS/chat reply degrades to the local model ([supabase/functions/_shared/chat_spend_cap.ts](supabase/functions/_shared/chat_spend_cap.ts)) rather than refusing. The SMS SEND that carries that reply is still hard-gated by the SMS cap above.

**NOTHING is exempt from metering** (policy set Jul 14 2026 — the previous
"operational exemptions" list is gone). Every outbound SMS counts against the
tenant's monthly pool via the same `daily_usage.sms_sent` ledger the quota UI
reads. Traffic classes differ only in what happens AT the cap:

- **Customer-facing sends** (AI replies, composer, tools, AiFlow customer
  texts, missed-call auto-texts, scheduled texts): `try_reserve_sms_outbound_slot`
  — hard stop at the cap after the purchased-bonus spill, exactly as before.
- **Operational sends** — owner alerts ([src/lib/notifications/dispatch.ts](src/lib/notifications/dispatch.ts),
  Edge `notifications`), AiFlow owner notices (`sendOwnerSms` / `notify_owner`),
  the provisioning "your Coworker is live" SMS ([src/lib/provisioning/orchestrate.ts](src/lib/provisioning/orchestrate.ts)),
  teammate offer-reply acks, the Safe-Mode inbound forward + owner reply
  prompts ([telnyx-sms-inbound](supabase/functions/telnyx-sms-inbound/index.ts) /
  [sms-inbound-worker](supabase/functions/sms-inbound-worker/index.ts)), and
  STOP / HELP / START compliance auto-replies: `meter_sms_operational_send`
  (Node: `sendTelnyxSms(..., { meterMode: "operational" })`, Edge:
  `_shared/sms_operational_meter.ts`) — counted as plan usage, bonus spill,
  or explicit **overage**, but never REFUSED and never throttled. Rationale:
  STOP/HELP/START replies are legally required; the "you hit your SMS cap"
  alert must outrun the cap it reports; Safe Mode exists so a paused AI never
  silently eats customer texts. Failed sends release the counted slot.

## All work and code modifications must follow this flow

For any changes use a worktree and never stop to ask for permission to continue always continue with your work by using this flow: Branch -> PR -> babysit CI + Bugbot to green -> merge (per PR merge policy). Then after the successful merge do the post-merge steps below, return back to main -> **clean up the worktree** (mandatory, see below).

### Post-merge: what CI does vs what you still do

**CI does automatically on every push to main** (the `Vercel Deploy` job, in
order, each step blocking the next): apply pending Supabase migrations
(`supabase db push` — fails loudly on ledger drift, never auto-repairs),
bulk-deploy **every** edge function in `supabase/functions/` (verify_jwt pins
come from the tracked `supabase/config.toml` — a new function MUST get a
`[functions.<name>] verify_jwt = false` entry there), then deploy the app to
Vercel production. PRs get the same drift detection early via the
`Supabase Drift Check` job, so drift is caught at review time. **Watch the
main run to green after merging** — a failed migration blocks the app deploy
by design.

**Still manual after merge (when the change calls for it):**
- VPS fleet redeploys when `vps/` changed (`tsx debug/update-all-vps.ts`,
  voice-bridge redeploy) — per-box SSH keys never leave the laptop.
- Seeds / one-shot scripts (`scripts/oneshot/`, ledger-recorded).
- Worktree cleanup (below).

### Worktree cleanup (mandatory after merge)

Never leave a worktree behind once its PR is merged. Orphaned worktrees have
previously left `next-server` dev processes running for days, pinning ~3.5 CPU
cores and draining the laptop battery. After returning to main:

1. **Kill anything still running out of the worktree** — dev servers
   especially. Check with `ps aux | grep newCoworker-wt-` (or
   `lsof +D /Users/brianlane/newCoworker-wt-<name>`) and kill any PIDs found
   (`kill`, then `kill -9` if they don't die).
2. **Remove the worktree** from the main repo:
   `git worktree remove /Users/brianlane/newCoworker-wt-<name>` then
   `git worktree prune`. Worktrees live at `/Users/brianlane/newCoworker-wt-*`.
3. **Delete the merged local branch**: `git branch -d <branch>`.
4. **Verify**: `git worktree list` shows only the main checkout, and
   `ps aux | grep newCoworker-wt-` finds nothing.