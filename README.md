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
rate. Membership Checkout (signup and plan change) may optionally include
discounted recurring usage packs (voice / SMS / chat) that renew with the
membership: 5% month-to-month, 10% on 12-month, 20% on 24-month. Quantities
are allowed per pack. Usage packs are non-refundable to customers: a New
Coworker money-back or admin force refund carves the pack line dollars out of
the refunded invoice, voids the matching grants, and excludes pack-funded
usage from the at-cost usage carve-out so those units are never charged
twice. Standalone top-ups from Dashboard → Billing stay
at the full catalog price.

**Auto-reload** (Dashboard → Billing) buys another pack automatically when a
tenant's remaining capacity falls below a threshold they set, the same shape
Telnyx and Google AI Studio use on our own vendor accounts. Three things are
worth knowing before touching it:

- It measures **plan-included remaining plus pack remaining**, not pack-only.
  A pack-only threshold would charge a first-time user the moment they flip
  the toggle, while their included allowance sits untouched.
- It charges a card the tenant authorizes **separately** from the membership
  card, through a hosted `mode: "setup"` Checkout, because the membership card
  was collected under a subscription mandate that does not cover ad-hoc
  merchant-initiated top-ups. The consent record (user, timestamp, IP, copy
  version) lives in `usage_pack_auto_reload_cards` and is what we produce if a
  tenant disputes an unattended charge.
- Grants are keyed `pi_<paymentIntentId>`, joining `cs_<sessionId>` (manual
  Checkout) and `inv_<invoiceId>:<category>:<packId>` (recurring add-ons) on
  the same unique column. **The manual pack Checkouts mirror `checkoutKind`
  onto their PaymentIntent**, so any listener on `payment_intent.succeeded`
  must gate on `metadata.autoReload === "1"` or every manual purchase grants
  twice under two different keys that DB idempotency cannot reconcile.

Guardrails, tightest first: a unique `attempt_key` per cooldown bucket (two
concurrent sweeps cannot both charge), a per-family cooldown, a monthly dollar
ceiling (mandatory for chat credit, which raises the cap rather than being
consumed), and auto-disable after three hard declines. A 3DS challenge pauses
without counting as a decline. A dispute claws the grant back, disables every
rule, and revokes the card. Fail-closed on
`USAGE_PACK_AUTO_RELOAD_ENABLED`; the pg_cron sweep runs every 15 minutes and
is a no-op until that is set.

**RCS is Enterprise-only** (Jul 2026): each tenant needs their own branded
Telnyx RCS agent ($600 + $100/mo carrier fees, priced cost-plus per deal) —
a shared agent cannot route inbound replies for more than one tenant. Before
enabling any new agent, run the **enterprise RCS onboarding e2e runbook** in
[PRDs/tier-economics-jul-2026.md](PRDs/tier-economics-jul-2026.md) ("RCS:
Enterprise-only decision" section); it encodes the Telnyx provisioning gotchas
(null `profile_id`/`webhook_url` silently drops inbound) and the outbound /
fallback / inbound verification steps. Per-tenant enablement lives on the
admin business page ("Messaging channel (RCS)" card).

## Architecture

- Agent runtime: Rowboat
- Local inference: Ollama
- Voice: Telnyx Call Control + VPS media bridge (Gemini Live real-time audio when the bridge has `GOOGLE_API_KEY`)
- KVM2 / KVM4 local fallback model: `llama3.2:3b` (KVM1 ships no local model)
- KVM8 local fallback model: `qwen3:4b-instruct`

Rowboat talks to a small `llm-router` sidecar on the VPS (`vps/llm-router/`) which forwards `gemini-*` traffic to Google's OpenAI-compatible endpoint and everything else to Ollama's `/v1` API. The SMS `dispatcher` agent stays on Ollama; the voice `voice_task` agent uses `GEMINI_ROWBOAT_MODEL` (default `gemini-3.7-flash`). No Bifrost layer.

### The voice callers hear (per tenant, live)

`business_telnyx_settings.voice_name` picks the Gemini Live prebuilt voice for a
tenant's calls, from the admin business page ("Voice & SMS DID" card, every
tier). It is **live-applied**: the bridge reads it in the per-call settings query
it already runs, so a change lands on the NEXT call with no redeploy, which is
what makes auditioning voices practical.

Resolution order is tenant choice, then the box's `VOICE_NAME` env (a per-box ops
override), then the platform default **`Kore`**
(`DEFAULT_GEMINI_LIVE_VOICE` / `DEFAULT_VOICE_NAME`).

**The bridge now ALWAYS sends a voice.** It used to send `speechConfig` only when
`VOICE_NAME` was set, which left the choice to Gemini's per-model default: that
default is undocumented, differs by model, Google warns it can change, and two
identically-configured boxes were observed answering in different voices. A
caller hearing a different person week to week is a brand defect, so we ask
explicitly.

The allow-list is Google's full published set (30 voices) with their one-word
character labels in the dropdown, in
[src/lib/plans/enterprise-models.ts](src/lib/plans/enterprise-models.ts), mirrored
standalone for the VPS in
[vps/voice-bridge/src/voice-name.ts](vps/voice-bridge/src/voice-name.ts) and as a
CHECK constraint on the column. `tests/voice-name-lockstep.test.ts` pins all four
together, so widening the set cannot half-land.

> The voice deliberately does NOT live in `businesses.enterprise_models`
> anymore. That blob is enterprise-tier only and applies only at the next box
> redeploy, which made a cosmetic choice both gated and slow; `enterprise_models`
> keeps the three MODEL ids. Note the guard there: a translate-flavored live
> model (`gemini-3.5-live-translate-preview`) satisfies "must be live" but
> supports no tools and no system instructions, so it would silently strip every
> tool and the whole persona from a tenant's phone coworker. It is rejected in
> that slot.

### Voice knowledge + tools

- The voice bridge loads `/opt/rowboat/vault/{soul,identity,memory,website}.md` (mounted read-only from Rowboat's vault) and injects them into Gemini Live's system prompt on every call. Owners set the website URL during onboarding; `/api/onboard/website-ingest` crawls once (SSRF-guarded, robots-respecting) and stores a summary in `business_configs.website_md`, which is editable from `/dashboard/memory` → "Website Knowledge".
- Gemini Live calls typed tools exposed by the app under `/api/voice/tools/*` — `business_knowledge_lookup`, `calendar_find_slots`, `calendar_book_appointment`, `send_follow_up_email`, `send_follow_up_sms`, `capture_caller_details`. Calendar + email proxy through `src/lib/workspace/proxy.ts`, which dispatches on the connection row's `transport` column: **Google Workspace is first-party** (our own verified OAuth client, Aug 2026), Microsoft 365 is still Nango-brokered while it migrates, plus **Calendly** as a calendar provider: slot search uses the event type's available times, and "booking" returns a **single-use scheduling link** — detail `booking_link_created` — that the agent texts to the customer, since Calendly cannot create bookings on the invitee's behalf). Calendly also connects **directly** without Nango: the owner pastes a Personal Access Token on `/dashboard/integrations` (`calendly_connections`, token encrypted at rest; transport in `src/lib/calendly/client.ts`, resolver key `calendly-direct`) — same tool behavior, zero OAuth-app setup. Bookings completed on Calendly fire the `appointment_booked` AiFlow goal event two ways: the ~1/min booking-goal sweep (`src/lib/ai-flows/calendly-booking-goals.ts`, works on every Calendly plan) and — when the tenant's paid Calendly plan allows it — a real-time `invitee.created` webhook the sweep auto-subscribes lazily (`calendly_webhook_subscriptions`, platform-minted signing key encrypted at rest; signed receiver at `/api/webhooks/calendly`). Bookings that PREDATE a run are covered too (the booked-then-enrolled gap, Jul 19 2026): the ai-flow-worker calls `/api/internal/aiflow-booking-precheck` (core `src/lib/ai-flows/booking-precheck.ts`) synchronously before a run's first communication step in a flow watching `appointment_booked` — a lead with an active future-start booking gets ZERO texts, greeting included — and the sweep widens its firing set to active future-start bookings whenever a jumpable run was created inside the young-run window (~15 min), so a failed-open precheck is caught within a minute, long before any nudge. Both are pinned by `tests/worker-integration/calendly-booking-goal-gap.itest.ts`. Two notes from the 2026-07 feature audit: (1) **the direct PAT is the only Calendly transport** — production had zero Nango `calendly` rows in `workspace_oauth_connections`, and the dead Nango branches (`calendlyRequest`'s proxy arm, the thrown-403 plan-gating arm, the `"calendly"` entry in the calendar resolver's fallback keys) were REMOVED in the Jul 2026 dead-code sweep: `calendlyRequest` now returns null (= not connected) for any non-direct key, and a legacy Nango `calendly` row can no longer resolve as a calendar connection; (2) **key-rotation soft spot**: rotating `INTEGRATIONS_ENCRYPTION_KEY` without re-encrypting `calendly_webhook_subscriptions.signing_key_encrypted` makes the webhook receiver 500 and the ensure path warn every sweep tick (that failure shape bypasses the retry cooldown) — the polling sweep keeps working throughout, so the impact is latency only, but re-encrypt the rows as part of any rotation. SMS uses the metered Telnyx path; capture writes to `coworker_logs`.
- **Vagaro** connects directly (no Nango, no Zapier): the owner pastes their merchant Client ID/Secret on `/dashboard/integrations` (`vagaro_connections`, secret encrypted at rest; client-credentials token manager in `src/lib/vagaro/client.ts`). When connected, Vagaro **wins calendar-provider resolution** — `calendar_find_slots` runs a real availability search and `calendar_book_appointment` creates the appointment on the merchant's book (owner-picked default service, else closest duration match). Inbound Vagaro webhooks land on `/api/webhooks/vagaro?business=…&token=…` (per-tenant verification token), start `webhook`-channel AiFlows with `source: "vagaro"`, and sync customer events into contacts. Requires the merchant's Vagaro APIs & Webhooks access (Vagaro-gated approval). Authentication is a **per-tenant gateway token** (see [Per-tenant gateway tokens](#security-per-tenant-gateway-tokens)); the shared `ROWBOAT_GATEWAY_TOKEN` remains a fallback during the transition. **Booking-intelligence parity with Calendly (Jul 2026)** — appointments booked OFF-platform (the merchant's own Vagaro page, front desk) get the full Calendly-stack treatment: an `appointment` **created** webhook event fires the shared `appointment_booked` goal machinery in real time (`src/lib/ai-flows/booking-goal-fire.ts` — the provider-neutral fan-out both providers now use), the pre-send precheck (`src/lib/ai-flows/booking-precheck.ts`) matches the run's lead against upcoming Vagaro appointments so an already-booked lead gets zero nurture texts, and the SMS/voice/Messenger booking-status preamble (`src/lib/ai-flows/contact-booking-context.ts`) reports upcoming/canceled Vagaro appointments (no reschedule lineage on Vagaro — a moved appointment reads as booked at its new time). **Calendar triggers** work for Vagaro-only tenants: the ~1/min poller lists appointments through `src/lib/ai-flows/vagaro-poll.ts` (all four modes; customer name/phone/email land in the trigger window text), and the webhook receiver fires `event_created` / `event_canceled` in real time through the poller's own enqueue core — shared `cal:` dedupe keys make poll/webhook double-observation a no-op. Webhook appointment events also **sync the booking ledger** (created → record external claim, updated → move it, deleted/canceled → drop it), so `calendar_reschedule_appointment` / `calendar_cancel_appointment` can locate off-platform bookings (Vagaro resolution is ledger-only). All of it parses the approval-gated v3 API shapes defensively and fails open to the pre-parity behavior.
- **Acuity Scheduling (Squarespace)** connects directly too, and is the lowest-friction of the dedicated booking providers: the owner pastes their **User ID and API Key** from Acuity's own Integrations → API page (`acuity_connections`, key encrypted at rest). No OAuth client, no approval from Squarespace, no add-on to buy. When connected, Acuity **wins calendar-provider resolution** over every workspace calendar but sits BEHIND Vagaro: a tenant with both keeps resolving to Vagaro, because silently moving a live tenant's bookings to a different book is the one unacceptable outcome. `calendar_find_slots`, `calendar_book_appointment`, `calendar_reschedule_appointment` and `calendar_cancel_appointment` all operate on the merchant's real Acuity book. Four API traits shape the implementation and are worth knowing before touching `src/lib/acuity/client.ts`: **availability is DATE-scoped**, not range-scoped, so `findAcuitySlots` fans out day by day behind a month prefilter, a 7-day cap and an early exit at 3 slots; the **rate limit is per egress IP** (10 req/s) and therefore shared by the whole fleet, so the budget is enforced globally through the durable Postgres limiter keyed `acuity:global` and an exhausted budget REFUSES rather than calling; there is **no last-modified field**, so `event_canceled` gating is driven by our own observation shadow (`acuity_appointment_state`) which stamps the first sighting of a transition and re-emits that same value forever after; and **cancel is irreversible**, so the cancel core verifies the appointment's start against the booking ledger and refuses rather than guessing. Calendar triggers work through `src/lib/ai-flows/acuity-poll.ts` (all four modes, windows rounded outward to whole local days because the listing is date-granular, windows run sequentially to respect the shared budget). Acuity merchants keep their own public booking site, so the native self-serve booking page is deliberately skipped for them, exactly as for Vagaro and Calendly. **Booking-intelligence parity with Calendly and Vagaro (Aug 2026)**: appointments booked OFF-platform (the merchant's own Acuity page, front desk) get the same stack: an appointment `scheduled` webhook fires the shared `appointment_booked` goal machinery in real time (`src/lib/ai-flows/booking-goal-fire.ts`), the pre-send precheck (`src/lib/ai-flows/booking-precheck.ts`) matches the run's lead against upcoming Acuity appointments so an already-booked lead gets zero nurture texts, and the SMS/voice/Messenger booking-status preamble (`src/lib/ai-flows/contact-booking-context.ts`) reports upcoming and canceled Acuity appointments (no reschedule lineage on Acuity: a move edits the appointment in place, so it reads as booked at its new time; canceled state comes from the canceled-only listing). The ~1/min booking-goal sweep and its young-run widening remain Calendly-only, so for Acuity, as for Vagaro, webhook-at-booking plus precheck-at-first-send are the whole booking-goal surface.
- See [docs/VOICE-ROLLOUT.md §9](docs/VOICE-ROLLOUT.md) for the Phase 2 rollout runbook.

## Memory knowledge graph (shadow rollout, Jul 2026)

Beside the markdown memory (`memory_md` + `memory_archive_md`, ranked at
retrieval time by `src/lib/memory/retrieval.ts`), every tenant has a per-tenant
knowledge graph: `memory_entities` / `memory_facts` rows built through
deterministic resolution and supersedence (`src/lib/memory/graph-write.ts`).
The graph is the durable who/what layer: people, organizations, places, and
the relationships between them, collapsed onto canonical nodes no matter which
channel the information arrived on.

**Modes.** `business_configs.memory_graph_mode` is `inherit` (default), `off`,
`shadow`, or `active`. `inherit` follows the fleet-wide default stored in
`admin_platform_settings` under `memory_graph_default_mode` (code fallback:
`shadow`). Always resolve through `resolveMemoryGraphMode`
(`src/lib/memory/graph-db.ts`, ~60s cache), never read the column raw. In
`shadow`, graphs build and every knowledge lookup records a graph-vs-memory
comparison while live answers stay byte-identical; in `active`, graph facts
ride the knowledge-lookup prompt alongside ranked memory. Flips are made from
the admin business-page card or `POST /api/admin/memory-graph`; a per-tenant
flip schedules a vault sync so the on-box projection ships (shadow/active) or
wipes (off) immediately.

**Trust model.** Every entity and fact carries `source`, `trust` (0-3), and
`attributed_to`:

| Trust | Who | Examples |
|---|---|---|
| 3 | Owner-canonical | owner chat/SMS capture, roster, contacts, pinned notes, profile, identity_md, backfill |
| 2 | Business systems/content | bookings, doc record fields, document bodies, website crawl |
| 1 | Identified customers | voice calls, customer SMS, replied email, Messenger/Instagram/WhatsApp leads |
| 0 | Anonymous | webchat leads, webhook/AiFlow leads, unanswered inbound email |

Supersedence respects trust: a new fact retires only same-or-lower-trust
facts for its (subject, predicate), so a caller's claim can never replace an
owner statement (the KYP lesson as a model, not a wall). Trust <= 1 sources
never merge phones/emails/aliases onto canonical entities, and retrieval plus
the on-box notes render their facts as attributed claims ("claimed by
+1480... (unverified)").

**Source coverage is a REQUIRED contract** (same spirit as the tool parity
contract below): `src/lib/memory/kg-sources.ts` maps every content surface in
the platform to a graph-ingestion decision, and
`tests/kg-source-coverage.test.ts` pins it three ways (live sources must have
`kg-source: <name>` marked call sites, entries must be well-formed, and the
hand-pinned surface inventory must stay fully mapped). **Any new content
surface (new channel, new content table) must add a registry entry and an
inventory line, or its PR fails CI.** Deterministic mappers live in
`graph-deterministic.ts` (zero model cost); conversational extraction rides
the customer-memory summarizer boundary and the DM lead-capture tools
(`graph-conversational.ts`); long-form content (documents, website, identity)
chunks through `graph-longform.ts`.

**Shadow comparison.** Every shadow/active lookup writes a `kg_retrieval_events`
row (question, answer, graph context vs ranked-memory context, counts;
90-day prune in the daily retention sweep; part of the end-user erasure
surface). `/admin/memory-graph` renders it at a glance: fleet default toggle,
per-tenant modes, verdict buckets (graph won / both / memory only / neither),
stat tiles, and per-event side-by-side expanders. The rollout playbook is
shadow-first: backtest offline, let shadow accumulate, review the verdict
split, then flip tenants to `active` (a human decision, never automatic).

**On-box projection.** The vault sync ships the graph to each tenant's VPS as
Obsidian-style entity notes plus `graph.jsonl` under `/opt/rowboat/memory/graph/`;
the chat-worker compiles `graph.jsonl` into a local SQLite `graph.db`
(`vps/chat-worker/graph-db-build.mjs`, content-hash freshness). Off-mode
tenants get the wipe on every sync.

**Cost.** All LLM extraction meters into the `memory_graph` spend surface, and
one daily per-tenant fuse covers every extraction path:
`MEMORY_GRAPH_DAILY_EXTRACTION_CAP` (default 200/day, enforced by reading
today's call count back from the spend ledger). `MEMORY_GRAPH_EXTRACT_MODEL`
overrides the extractor model (default `gemini-3.5-flash-lite`).

**Ops (read-only, engineering key, no sends):**

```bash
tsx debug/kg-backfill.ts --business <uuid>                    # dry-run memory_md backfill
tsx debug/kg-backfill.ts --business <uuid> --apply            # land it (idempotent)
tsx debug/kg-backfill.ts --business <uuid> --sources voice,sms,email   # widened dry run
tsx debug/kg-backtest.ts --business <uuid> --sources voice,sms,email   # widened graph, then
                                                              # memory-vs-graph replay report
```

## Testing

Run unit tests with:

```bash
npm test
```

Run the worker-integration suite (the REAL edge workers and Node-side cores
against a REAL local Postgres) with:

```bash
npm run test:worker-integration
```

It needs a local stack first (`supabase start`, then `supabase functions
serve`); the header of `vitest.worker-integration.config.ts` carries the exact
setup, and CI runs it as its own job.

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

> ⚠️ **The `edge-residency-replay` cron is intentionally UNSCHEDULED while
> zero tenants use residency** (migration
> `20260812000200_unschedule_residency_replay.sql`): with no dual/vps
> tenant it burned ~1,440 no-op Edge invocations/day. The Edge function,
> internal route, journal table, and triggers all remain deployed. **Step 0
> of the runbook below re-schedules it** — `dual` mode does NOT replicate
> without this cron, so never flip a tenant to `dual` before completing
> step 0.

Per-tenant enablement runbook (one deal at a time, no fleet rollout):
0. **re-schedule the replay cron** — run the `cron.schedule(
   'edge-residency-replay', '* * * * *', …)` block from
   `supabase/migrations/20260804000000_residency_write_journal.sql`
   (SQL editor or a new migration), then verify:
   `select jobname, schedule, active from cron.job where jobname = 'edge-residency-replay';`
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

Incident reviews live in `docs/` — see
[docs/INCIDENT-2026-07-KYP-ONBOARDING.md](docs/INCIDENT-2026-07-KYP-ONBOARDING.md)
for the KYP Ads signup (seven defects: webhook-teardown provisioning, DID
search abort, CA messaging profile, dead SMS sender + wrong recipient,
un-normalized owner phone, invisible owner SMS, adopted-box tunnel token),
each with its hot fix and permanent fix, plus the **adoption-pool checklist**
every new per-tenant box resource must be added to.

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

**Internal smoke/e2e target: the New Coworker (HQ, internal) tenant**
(`8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d`, srv1806097, +1 602 313 1823 — also
the homepage demo voice line and the site webchat). Every smoke/e2e-style
`debug/` script defaults to it, so test writes (memory rules, SMS sends, LLM
turns, Gemini Live sessions) burn our own budget on our own box — never a
customer's. There is no separate smoke tenant or box: the old "NCW Flow Test"
tenant and the KVM1/KVM2 smoke clones were retired when HQ was onboarded
(`scripts/oneshot/onboard-hq-tenant.ts`). The hermetic `tests/e2e/*` suite
(CI "E2E (live AI + AiFlows)") is fixture-based and targets no live tenant.
See [debug/README.md](debug/README.md#internal-test-tenant-new-coworker-hq-internal).

**HQ's box is the fleet's one piece of SHARED hardware** (Jul 2026): VM 1806097
also hosts JobArms, our own second product (`jobarms-render` +
`cloudflared-jobarms` on `127.0.0.1:8085`, files under `/opt/jobarms-render`,
tunnel in the JobArms Cloudflare account). The registry is
[src/lib/vps/shared-hardware.ts](src/lib/vps/shared-hardware.ts), and every
destructive fleet path consults it: `debug/migrate-vps-size.ts` refuses without
`--shared-box-ack`, the admin-panel hardware migration refuses outright (a
re-image destroys the co-tenant with no backup of ours to restore), and
provisioning logs a loud co-tenancy warning rather than refusing, since it is
the recovery path. Two Chromium sidecars now share 1 vCPU / 4GB with a realtime
voice bridge, so the `memory_headroom` posture check
([vps/scripts/heartbeat.sh](vps/scripts/heartbeat.sh)) is the first thing to
read when HQ feels slow. **No customer box is shared, and none should be**: the
per-tenant isolation described under
[Security: per-VPS box hardening](#security-per-vps-box-hardening--isolation)
depends on it.

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
- **Data API grants are explicit; nothing is auto-exposed.** The project
  opted in early (`supabase/migrations/20260820100400_revoke_default_data_api_grants.sql`)
  to the Supabase platform default that reaches every existing project on
  October 30, 2026: new tables, views, sequences, and functions in `public`
  receive NO automatic grants to `anon`/`authenticated`/`service_role`.
  Every migration that creates an object must grant access explicitly in the
  same file (service_role only, unless the table is deliberately
  client-readable via RLS policies); `tests/migration-grants.test.ts`
  enforces this in CI and [supabase/migrations/CLAUDE.md](supabase/migrations/CLAUDE.md)
  documents the convention. The companion sweep
  (`…20260820100500_revoke_legacy_deny_all_table_grants.sql`) also revoked
  the legacy anon/authenticated grants on every existing RLS-on/no-policies
  table, so a deny-all table is no longer one accidental
  `disable row level security` away from the anon PostgREST path.
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

Three honest caveats: (1) the Cloudflare Access service-token edge gate on
`data-*` hostnames (defense-in-depth in front of the bearer check) is
deferred until the residency client plumbing needs it — the bearer gate alone
protects the data plane today; (2) SSH keys, gateway tokens, and backup
passphrases are escrowed centrally, so per-box isolation protects tenants
from **each other** and shrinks a single-box compromise to one tenant — it
does not remove the platform as the root of trust; (3) **one box in the fleet
is not single-tenant: our own internal HQ box** (VM 1806097), which since Jul
2026 also runs the JobArms render sidecar and whose SSH key that product's
deploy therefore holds in decrypted form. It carries no customer's data, every
customer box remains ours alone, and the co-tenancy is recorded in
[src/lib/vps/shared-hardware.ts](src/lib/vps/shared-hardware.ts) so the fleet
tooling refuses to re-image it by accident.

## Security: per-tenant gateway tokens

Historically every tenant VPS shared one platform-wide `ROWBOAT_GATEWAY_TOKEN`. That
token is used three ways: (1) the bearer on VPS → app calls (`/api/voice/tools/*`,
the workspace proxy (Nango or first-party, per row), custom-integration credentials/call, `aiflows/send-owner-email`,
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

## Admin "view as": full access, and what keeps it on the right row

The platform admin can drive the owner dashboard as any tenant. An httpOnly
cookie carries the target business id (set by `POST /api/admin/view-as`,
honored only when the signed-in user is the admin, 4h cap, entry audited as
`view_as` in the admin audit trail).

**It is not read-only.** It used to be: roughly 50 tenant-facing routes
carried an `isViewAsActive` 403 ("View-as is read-only; exit view-as to make
changes"). That guard existed because those routes resolved "the" business
from the SIGNED-IN user's email, so an impersonating admin's save would have
landed on the ADMIN's own business while the page showed a customer's. Since
Aug 2026 the resolution itself is view-as aware, so the guard is gone and the
admin can perform any action for any tenant. Two mechanisms do the work:

- **Business-scoped writes** either take an explicit `businessId` (role-checked
  with `requireBusinessRole`, which admins pass) or resolve it through
  `resolveActiveBusinessContext`
  ([src/lib/dashboard/active-business.ts](src/lib/dashboard/active-business.ts)),
  which returns the view-as pin with role `owner`. Either way the write lands
  on the tenant being viewed. **If you add a tenant-facing mutation, resolve
  the business one of those two ways.** Re-deriving it from `user.email`
  reintroduces exactly the wrong-tenant bug the old 403 was papering over.
- **User-scoped writes** (login email, UI locale, the auth-user teardown
  inside account deletion, the clickwrap ledger) are keyed on an auth user,
  not a business, so they go through `resolveViewAsTargetUser`
  ([src/lib/admin/view-as.ts](src/lib/admin/view-as.ts)): under view-as it
  resolves the impersonated OWNER's auth user, and returns `userId: null` when
  the tenant's `owner_email` has no login behind it (pending/placeholder
  owner). **Callers must refuse on that null** rather than fall back to the
  signed-in user, which would apply the change to the operator's own account.

### Payer identity vs actor identity

Removing the refusal from a route is not the whole job: the route's own
caller-identity fields have to be classified too. Bugbot caught this on the
billing routes, and the split is the rule to follow:

- **Payer / account identity is the TENANT.** The Stripe `customerEmail`, the
  `upsertCustomerProfile` email, and `ownerAuthUserId` (which the lifecycle
  planner turns into a `delete_auth_user` op) all resolve through
  `resolveViewAsTargetUser`. Left on the caller, a plan change would attach the
  OPERATOR's customer profile to a customer's subscription, open Checkout under
  the operator's address, and, worst of all, queue deletion of the operator's
  own login when cancelling someone else's plan.
- **Actor / consent identity is the CALLER.** The `userId` handed to Stripe
  metadata is read back as `consent_user_id` ("who authorized this charge"), so
  naming the tenant there would fabricate a consent record. Same reasoning as
  the clickwrap ledger below. The auto-reload card routes keep the caller for
  exactly this reason.

### The UI has to name the account it is editing

The user-scoped APIs retarget server-side, so any surface that renders "your"
identity next to a form those APIs serve must retarget with them, or an
operator edits a tenant while reading their own address.
`loadSettingsContext` therefore returns `accountEmail` (the tenant's
`owner_email` under view-as), and `/dashboard/settings/account` renders that
rather than `user.email`.

Three cards deliberately do NOT retarget, because they act on the caller's live
browser session rather than through an API we control, and no session-scoped
API can act on someone else's browser. Each carries a visible
`OwnLoginNotice` under view-as
([src/components/dashboard/OwnLoginNotice.tsx](src/components/dashboard/OwnLoginNotice.tsx)),
which is the shared home for that warning:

| Card | Why it cannot follow the tenant |
| --- | --- |
| Password | `changeAccountPassword` re-authenticates the session with `signInWithPassword`. It takes the caller's address through a separate `callerEmail` prop; passing the tenant's would break every password change under view-as. |
| Passkeys | `supabase.auth.passkey.*` enrolls the device holding the session. |
| Sign out everywhere | `/api/auth/signout` revokes the caller's cookies (and clears the view-as cookie). |

Do not "fix" a labeled card by feeding it the tenant's identity: the label is
the fix, and the alternative is a form that silently fails or edits the wrong
account. The tenant-side equivalents live in their own card instead
([src/components/dashboard/TenantCredentialsCard.tsx](src/components/dashboard/TenantCredentialsCard.tsx),
rendered only under view-as), and both are audited:

- **`POST /api/account/password-reset`** emails the tenant Supabase's recovery
  link. Deliberately a RESET, not a set: `auth.admin.updateUserById({ password })`
  would work, and is not used, because it would leave the operator holding a
  live customer credential they then have to transmit somehow. The tenant picks
  the password from their own inbox and the operator learns nothing. Composes
  with `/api/account/email`: if the mailbox is lost too, change the address
  first, then send the reset. Rate limited per TARGET so a mis-clicking
  operator cannot flood a customer's inbox.
- **`GET`/`DELETE /api/account/passkeys`** lists and revokes the tenant's
  passkeys via `auth.admin.passkey.*` (needs `createSupabaseAdminPasskeyClient`,
  a separate factory because the experimental flag should not be on for every
  server path).

**There is no way to enroll a passkey for a tenant, and there never will be.**
A passkey is minted by the tenant's own authenticator after a user-verification
gesture, and the private half never leaves their device. Supabase's admin API
reflects that by offering list and delete only. This is not a permission we
lack; it is a thing that cannot exist for anyone. The operator's path is to get
the tenant signed in (the reset above) and let them add it themselves. The card
says so rather than leaving an operator hunting for a missing button. The language card is labeled for the mirror-image reason: the save
targets the TENANT's stored locale while the buttons show the operator's own UI
language, which stays put.

Three deliberate carve-outs:

- `/api/account/email` under view-as applies the change IMMEDIATELY
  (`auth.admin.updateUserById` + `moveBusinessesToNewOwnerEmail`) instead of
  the owner's confirm-by-link flow: the admin cannot click a link sent to the
  tenant's mailbox, so there is nothing to reconcile later.
- `/api/account/delete` still re-verifies the CALLER's own password. That
  check proves the session is not hijacked; the admin does not know the
  tenant's password, and should not.
- `/api/legal/accept` REFUSES an impersonating admin, and it is the ONLY
  refusal left in the product. This is a policy line, not a wrong-row hazard:
  a `terms_acceptances` row evidences that a SPECIFIC PERSON agreed, and nobody
  can agree on someone else's behalf, so an operator-recorded row is fabricated
  however it is labeled. A labeled `admin_view_as` source shipped briefly in
  PR #1420 and was withdrawn the same day with zero rows written; do not
  reintroduce it. The dashboard layout also does not raise the clickwrap gate
  under view-as, so the refusal never strands an operator behind a modal they
  are not allowed to satisfy. The tenant clears it on their next sign-in.

One platform limit, not a policy gate: the connector Disconnect
([src/app/api/integrations/mcp/route.ts](src/app/api/integrations/mcp/route.ts))
still skips the OAuth revoke unless the caller's own login is the connected
one, because Supabase's `auth.oauth` API only ever acts on the caller's
grants. An unconditional revoke there would destroy the admin's own Claude
access while leaving the tenant's connector alive.

## Production checklist (high level)

- Set **`INTERNAL_CRON_SECRET`** for scheduled invocations of Edge functions that use `assertCronAuth` (e.g. `sms-inbound-worker`, **`voice-settlement-sweep`** — runs **`voice_run_maintenance_sweeps`** for stale settlements, zombie **`voice_active_sessions`**, ended-and-settled **`voice_active_sessions`** (the `ended_sessions_reaped` counter: rows whose call finished normally, which nothing deleted before migration `20260822071559`), stale **`voice_reservations`**, stuck **`sms_inbound_jobs`**, and expired **`stream_url_nonces`** — **`voice-low-balance-alerts`**, **`telnyx-voice-failover`**). Do **not** set **`CRON_ALLOW_SERVICE_ROLE_BEARER`** in production — that flag exists only so local dev can reuse the service role as the bearer when no dedicated cron secret is configured.
- Schedule **`voice-low-balance-alerts`** with the same cron auth; set Edge secrets **`RESEND_API_KEY`**, **`MAILER_EMAIL`**, **`CONTACT_EMAIL`** (optional reply-to) so owners get email when included voice headroom drops below **300s** (`low_balance_alert_armed` is cleared after send).
- New-signup ops alerts (first-time provisioning complete) require app env **`RESEND_API_KEY`** and **`OPS_NOTIFICATION_EMAIL`** (defaults to `team@newcoworker.com` when unset).
- **`telnyx-voice-failover`**: default **`mode: "speak"`** (or omit `mode`) runs §8 **maintenance `answer` + `speak`** with optional **`VOICE_FAILOVER_MAINTENANCE_MESSAGE`**. **`mode: "transfer"`** + **`TELNYX_FAILOVER_CONNECTION_ID`** (or body `connection_id`) moves the call to a backup Connection. POST JSON `{ "call_control_id": "…", "mode"?: "speak" | "transfer" }`.
- **`stream_url_nonces`**: expired rows are deleted by **`stream_url_nonces_prune_expired`**, invoked from **`voice_run_maintenance_sweeps`** (same schedule as **`voice-settlement-sweep`**). Response JSON includes **`stream_url_nonces_pruned`** (row count).
- Telnyx Edge webhooks use **`telnyx_webhook_try_begin` / `telnyx_webhook_mark_complete`** (claim + completion) so transport retries can finish work; duplicate **completed** events short-circuit. Concurrent deliveries for the same event may receive **503** until the claim lease expires — Telnyx should retry. Optional env: **`TELNYX_WEBHOOK_RATE_MAX_PER_MINUTE`**, **`TELNYX_WEBHOOK_RATE_WINDOW_SEC`** (defaults: 240 per minute per IP per route).
- Structured **`telemetry_events`** (via `telemetry_record` RPC) include: `edge_webhook_rejected` (reason: `size` \| `rate` \| `concurrent_claim`), `telnyx_webhook_signature_reject` (class: `malformed` \| `crypto_mismatch`), `jit_stripe_fail_proceed_cached` / `jit_stripe_fail_block`, `voice_answer_fail`, `voice_concurrent_limit_spoken`, `voice_rollout_stream_disabled`, `voice_mark_answer_issued_fail`, `sms_outbound_reconciled_after_error`, `sms_inbound_*_keyword`, and voice settlement events — wire dashboards/alerts to these types.
- Rollout / kill switches: Edge secret **`VOICE_AI_STREAM_ENABLED=false`** → `telnyx-voice-inbound` answers with speak-only (no stream). Bridge env **`GEMINI_LIVE_ENABLED=false`** → media WebSocket stays up but Gemini Live audio is off.
- Voice bridge deploy: `deploy-client.sh` rsyncs **`${VOICE_BRIDGE_SRC:-/opt/newcoworker-repo/vps/voice-bridge}`** → `/opt/voice-bridge`, rewrites `.env` (so rotated secrets land), runs `docker compose up -d --build --force-recreate`, and polls `http://127.0.0.1:8090/` for up to 40s before marking the deploy healthy. Operators are responsible for staging the repo at `VOICE_BRIDGE_SRC` (bootstrap-time git clone, rsync from orchestrator, or gold-image bake). If no source is present the script logs and skips, matching the pre-Telnyx behavior.
- Telnyx Call Control has **one** webhook URL per Application, but voice events are split across two handlers (`telnyx-voice-inbound` for `call.initiated`, `telnyx-voice-call-end` for `call.hangup`/`call.ended`). Point Mission Control at **`telnyx-voice-dispatch`**; it extracts `data.event_type`, forwards the raw body + Telnyx signature headers to the matching function on the same Supabase project, and returns the upstream response unchanged. The target functions verify the signature themselves — the dispatcher is a routing layer only. Optional env **`DISPATCH_FORWARD_BEARER`** injects an `Authorization` header if the targets were deployed with JWT verification enabled.
- SMS keyword auto-replies (**STOP** / **HELP** / **START**) need **`TELNYX_API_KEY`**, **`TELNYX_MESSAGING_PROFILE_ID`**, and **`TELNYX_SMS_FROM_E164`** on the `telnyx-sms-inbound` function; without them the handler still returns **200** but logs a warning. **`TELNYX_INTL_GATEWAY_E164`** exists in the same code paths but is deliberately UNSET everywhere: it was built for a dedicated international from-number before Telnyx's verdict that US long codes are domestic-only (see "International reachability" below), so today no number can fill it. The code stays dormant and future-proof; do not set the variable unless a sender type with international outbound actually ships.
- After first-time deploy (or any time you reset the cache columns), backfill `subscriptions.stripe_current_period_{start,end}` from Stripe so voice quota gating works before the next subscription lifecycle webhook runs: `npx tsx scripts/backfill-stripe-subscription-periods.ts` (dry-run), then re-run with `--apply`. Requires `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`.

## Claude connector (remote MCP)

Owners can add New Coworker to Claude (claude.ai / Claude Desktop) as a
**custom connector**: a remote MCP server at **`/api/mcp`**
([src/app/api/mcp/route.ts](src/app/api/mcp/route.ts), Streamable HTTP only,
stateless — tool logic lives in `src/lib/mcp/**` under the coverage gate).
Authentication is **OAuth 2.1 via Supabase Auth's OAuth server**: Claude
discovers the issuer through the RFC 9728 metadata at
`/.well-known/oauth-protected-resource`, self-registers (dynamic client
registration), and sends the owner through login + consent at
**`/oauth/consent`** ([src/app/oauth/consent](src/app/oauth/consent/page.tsx);
decision handler `POST /api/oauth/decision`). Every tool call then presents a
Supabase access token, verified via `auth.getClaims`
([src/lib/mcp/auth.ts](src/lib/mcp/auth.ts)) and **role-checked per business
through the same permission matrix as the dashboard** (`src/lib/authz/policy.ts`)
— no admin bypass, no separate credential to mint.

- Tool set (`src/lib/mcp/tools/*`): reads (businesses, contacts, SMS threads,
  recent events, call transcripts, Task Center), `send_sms` (same metered
  Telnyx path as the dashboard/Zapier — logged to `sms_outbound_log` with
  `source: 'mcp'`), calendar find-slots/book (shared calendar core: Vagaro /
  workspace proxy / Calendly / CalDAV), contact create/update (fires the same
  `contact_created` / `tag_changed` / `owner_assigned` automation hooks as
  dashboard edits), AiFlow CRUD + `trigger_flow` (definitions validated by
  `parseAiFlowDefinition` + binding checks; `get_flow_schema` returns the
  authoring vocabulary), and agent CRUD (tier-capped).
- Owner self-serve tools (added Aug 2026, the one-shot ask classes):
  `update_business_profile` (hours + timezone through the same core as
  Settings, with the profile_md refresh + vault sync; deliberately refuses
  phone changes), `get_business_knowledge` / `update_business_knowledge`
  (owner-only section splices of `business_configs.identity_md` through the
  identity editor's exact pipeline — whole-document rewrites are structurally
  impossible), and `update_coworker_tool_settings` (flip a Settings →
  Coworker tools toggle per surface; takes an explicit surface list because
  a policy reaches only the surfaces written).
- Ops prerequisites (one-time, production Supabase dashboard): enable
  **Authentication → OAuth Server** with dynamic client registration, and set
  the authorization path to `/oauth/consent` (local config in
  `supabase/config.toml` `[auth.oauth_server]`).
- **Cloudflare must not bot-block Anthropic's backend.** The OAuth steps run
  in the user's browser, but the authenticated `initialize`/tool-call POSTs
  come from Anthropic's servers (egress `160.79.104.0/21`, UA `Claude-User`)
  and look like bot traffic to the edge. The `newcoworker.com` zone carries a
  WAF custom rule ("MCP connector allowlist", created 2026-07-17) that
  **skips** Super Bot Fight Mode + managed rules + Browser Integrity Check /
  UA blocks for that IP range on `/api/mcp` and `/.well-known/*`; the zone's
  "Block AI bots" setting must also stay off for these paths. Symptoms when
  this regresses: Claude shows "Couldn't connect" (unauthenticated probe
  blocked) or "Authorization with the MCP server failed, ofid_…" (OAuth
  succeeds, verification POST 403s at the edge with zero origin trace) —
  check Cloudflare Security → Events before suspecting the app. Free-plan
  Bot Fight Mode ignores WAF skip rules entirely and must stay OFF.
- Owner-facing setup lives on `/dashboard/integrations` → "Claude connector"
  (paste `https://<app>/api/mcp` into Claude → Settings → Connectors).

## ChatGPT app (OpenAI Apps SDK)

The same MCP server, served to ChatGPT at **`/api/mcp/chatgpt`**. Worth
knowing up front: OpenAI retired `ai-plugin.json`, and a ChatGPT app today
**is** a remote MCP server plus listing metadata, so the transport, the tools,
the OAuth, and the per-business role checks above carry over unchanged.

**Live since 2026-08-11**, verified end to end against production: discovery,
dynamic client registration, consent, token exchange, and tool calls returning
real data in a ChatGPT conversation. Adding it needs a **paid** ChatGPT plan
(developer mode under Settings, Connectors, Advanced); the connector UI does
not work on Free.

A route per client rather than one shared endpoint, because in stateless
Streamable HTTP only `initialize` carries `clientInfo`: every later tool call
is an independent request whose only client signal is a User-Agent, so a
shared endpoint could not attribute traffic without guessing. `MCP_ROUTES`
([src/lib/mcp/routes.ts](src/lib/mcp/routes.ts)) is the one source of truth,
and the handlers are built once per client by
[src/lib/mcp/server.ts](src/lib/mcp/server.ts).

What OpenAI demands that Claude never did: a `title`, three behavior
annotations (`readOnlyHint` / `destructiveHint` / `openWorldHint`, whose
absence is the most-cited rejection cause), an `outputSchema` plus
`structuredContent` on every result, `search` and `fetch` tools, and a
plain-text domain proof at `/.well-known/openai-apps-challenge`.

**Do not clone the Anthropic WAF rule.** It allowlists one tidy egress range;
OpenAI publishes ~270 CIDRs that rotate, so the rule has to be conditioned on
path rather than IP. Full detail, the Supabase OAuth findings, the rollout
order, and the submission checklist live in
[docs/CHATGPT-APP.md](docs/CHATGPT-APP.md).

## Ask AI companion (dashboard)

Every /dashboard page carries a floating "Ask AI" launcher
([src/components/dashboard/companion/CompanionLauncher.tsx](src/components/dashboard/companion/CompanionLauncher.tsx),
mounted once in the dashboard layout, hidden on /dashboard/chat itself). It
opens a slide-over panel that is the SAME conversation as /dashboard/chat:
same POST/GET/threads endpoints, same active thread (one `is_active` per
business by partial unique index), and the same transport state machine via
the shared `useDashboardChatTransport` hook, so the page and the panel stay
in sync like two tabs would. The panel is deliberately leaner than the page:
Chat + History tabs, route-aware suggested prompts
([src/lib/dashboard-chat/companion-prompts.ts](src/lib/dashboard-chat/companion-prompts.ts)),
a text-only composer (attachments live on the full page, linked from the
panel), and draft cards using the same sessionStorage hand-off as the page.
The companion is NOT gated on admin view-as: the full /dashboard/chat page
already works while impersonating, and the panel mirrors the page. The chat
API stays the authority on what an impersonating admin can do, and since
Aug 2026 the answer is "everything the owner can": the caller's email holds
no role on a foreign tenant, so the route falls back to the view-as cookie's
pinned business and resolves owner for exactly that business, handing the
pinned id to the bridge caller so the per-call `requireMcpBusinessRole`
agrees. All copy lives under `dashboard.companion.*` in BOTH message
catalogs; the client subset registers `dashboard.companion` in
`src/i18n/client-messages.ts`.

## Google Workspace OAuth: one client, three consumers

Gmail and Calendar are first-party as of Aug 2026: we hold the tokens, and
`src/lib/workspace/proxy.ts` dispatches on the connection row's `transport`
column (`nango` | `direct`) rather than on the provider key. `provider_config_key`
stays `google` on both transports, which is what keeps every resolver, the
connection cap, cleanup, and every AiFlow mailbox binding transport-blind.

### The client is shared, and that is the main hazard

**One OAuth client (`354099628168-...`) serves two consumers:** Supabase Auth
"Log in with Google" at `/login`, and this first-party workspace flow. One
careless edit in the Cloud Console breaks **site login**, not just integrations.
Its secret lives in two places that must never diverge: Vercel
(`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) and the Supabase Auth Google
provider config.

Nango was a third consumer until 2026-08-13, when the `google` integration was
deleted there. That is also why the client-secret rotation is no longer urgent:
its point was that Nango still held a working secret for a verified client.

### The scope set is frozen, in code, on purpose

Seven scopes, listed in `src/lib/google/workspace-scopes.ts` and pinned by
`tests/google-workspace-scopes.test.ts`. Two of them are what Google actually
reviewed: `gmail.modify` (RESTRICTED, and the reason an ADA-CASA AL1 assessment
exists at all) and `calendar.events` (sensitive).

**Adding a scope is a compliance event, not a code review.** Per
`google-oauth-assets/casa/recert-runbook.md`, any new sensitive or restricted
scope, or any change to consent-screen configuration, requires a fresh
verification request, and verification cannot be inherited. The test fails with
that cost spelled out rather than a bare array diff.

Store what Google GRANTED (`oauth_scope` on the row), never what we requested.
Granular consent lets an owner untick boxes, and one production tenant is proof:
KYP Ads holds a calendar-only grant with no `gmail.modify` at all.

### Redirect URIs: adding is safe, removing is not

Authorized domains are DERIVED from the redirect URI list, which the console
states outright. So:

- **Adding** a URI under a domain already listed is client config. Safe. The
  first-party callback shipped with no console change because
  `/api/auth/callback/google` was already registered, left over from code deleted
  in Apr 2026.
- **Removing** `https://api.nango.dev/oauth/callback` drops `nango.dev` out of
  authorized domains, which IS a consent-screen change. Deferred to the June 2027
  recertification window, when a re-review costs nothing extra.

### Refresh tokens do not rotate

Unlike Zoom and Microsoft, Google keeps the same refresh token, so
`src/lib/google/client.ts` has no optimistic-concurrency fence and does not need
one. Do not add it back by analogy. It keeps an in-process single-flight only so
pollers waking together make one token call instead of N.

Only `invalid_grant` deactivates a row. `invalid_client` stays `request_failed`,
because that is what a botched secret rotation looks like and treating it as a
dead grant would soft-disable every tenant at once.

### Reconnect is cross-transport, and that is how the migration happened

An owner on Nango who clicks Connect Google gets their EXISTING row flipped in
place, same row id, so every `send_email` binding, email trigger and
`shared_calendar_id` survives. `scripts/oneshot/import-google-nango-tokens.ts`
does the same without the owner present, by redeeming the refresh token Nango
holds against our own client. Both leave the Nango grant alive and record it in
`metadata.migrated_from_nango_connection_id`, which `debug/nango-audit.ts`
refuses to reclaim while that key is set.

**For Google this is now history rather than a live path.** All three tenants
migrated on 2026-08-13 and the integration was deleted from Nango the same day,
which took its connections with it, so there is no Google grant left to roll back
to and the dangling pointers were cleared. The machinery stays because Microsoft
is still mid-migration and uses the identical path.

One consequence worth knowing, fixed in #1352: an identity probe of a Google row
can no longer go through Nango, so `fetchWorkspaceAccountIdentity` routes it
through the transport-aware seam. A Nango-only probe would fail, and a failed
probe inserts a duplicate row rather than adopting the existing one.

### Disconnect revokes at Google, and the ordering is deliberate

Google publishes a scoped revoke endpoint, so for a direct Google row
`DELETE /api/integrations/workspace` presents the **refresh** token to
`https://oauth2.googleapis.com/revoke`, which kills the whole grant, access
token included. Revoking the access token instead would leave the refresh token
able to mint more, so Disconnect would not mean disconnected. Outlook has no
equivalent: Microsoft publishes nothing like Zoom's `POST /oauth/revoke`, so an
Outlook row's teardown is deleting the ciphertext and waiting out the token
lifetimes (`docs/OUTLOOK-INTEGRATION.md`).

The sequence is read, delete, revoke, and each position matters:

- **Read before the delete**, because deleting the row destroys the only copy of
  the ciphertext.
- **Revoke after the delete**, matching the snapshot-then-delete-then-revoke
  contract in `src/lib/nango/cleanup.ts`. A failed delete must leave the tenant
  fully intact rather than holding a row whose grant we already killed.
- **Never fail the request on a failed revoke.** It logs
  `google.revoke_failed` and returns 200, because the row IS gone; a Google
  outage must not stop an owner from disconnecting.

This was in the migration plan and shipped late, in #1360. Between Aug 13 and
then, Disconnect deleted our copy and left the grant live on the owner's Google
account, which is the same defect the Zoom section calls out as "leaving the app
authorized after a Disconnect".

### The client can be deleted for inactivity

Google deletes OAuth clients unused for six months, and token refreshes do not
appear to count, only authorizations do. Losing the client loses the verification
with it. The annual recert reminder checks the Last used date; see the runbook's
inventory section.

## Zoom OAuth: two clients, one app

The published "New Coworker OAuth" Marketplace app carries TWO credential
pairs, and the difference matters more than it looks. A Marketplace **update**
(a new scope, a new event subscription) exists only on the **development**
client until Zoom approves it. So a Zoom reviewer testing an update has to
authorize against the development client id, while every real tenant keeps
using production. Sending the reviewer to the production authorize URL is what
got the July 2026 update bounced back.

- **Selection is per business, at connect time.**
  `resolveZoomClientEnvForBusiness` ([src/lib/zoom/oauth.ts](src/lib/zoom/oauth.ts))
  returns `development` for ids listed in `ZOOM_DEV_OAUTH_BUSINESS_IDS`
  (in practice one, the Zoom Review Sandbox tenant) and `production` for
  everyone else. It deliberately does NOT fall back to production when
  `ZOOM_DEV_CLIENT_ID` is unset: a silent fallback is the original bug.
- **The choice rides inside the signed state** (`c: "d"`, emitted only for
  development) so the callback redeems the code against the client that
  minted it even if the allow list changed mid-flow. A state with no marker
  reads as production, which is what makes the deploy seamless.
- **It is then persisted** on `zoom_connections.oauth_client_env`, because
  refresh and revoke must present the SAME pair for the life of the grant.
  The wrong pair gets a 401 `invalid_client`, which the refresh path reads as
  a dead grant and soft-disables a healthy connection, and which the revoke
  path swallows entirely, leaving the app authorized after a Disconnect.
- **The Secret Token is APP-LEVEL and cannot attribute a delivery.** One
  value covers both credential pairs (verified July 2026: the token shown on
  the Development Access page is the exact value production webhook
  validation has been passing with), so every delivery verifies under
  `ZOOM_SECRET_TOKEN` and the signature only proves the delivery is ours.
  Attribution comes from elsewhere: `app_deauthorized` carries the
  `client_id` in its payload (`resolveZoomClientEnvFromClientId` maps it to
  an env, unrecognized ids fall back to wiping both), and
  `recording.transcript_completed` carries nothing, so transcript routing
  matches the host's connections under either client and lets the
  per-business import ledger absorb the dev+prod double delivery. Without
  the payload scoping, deauthorizing the development client would wipe the
  token pair of a production tenant sharing a Zoom account.
  `ZOOM_DEV_SECRET_TOKEN` exists only as a hedge against Zoom ever issuing
  distinct tokens; leave it unset.
- **Turning it off after approval** is env-only: clear
  `ZOOM_DEV_OAUTH_BUSINESS_IDS`, redeploy, then
  disconnect and reconnect the sandbox so it moves back to production. Do it
  before the dev credentials are ever regenerated, or the pinned row refreshes
  into `invalid_grant` and shows up as "Needs reconnect".

`/integrations/zoom/authorize` is the listing's **Direct Landing URL**: signed
out it bounces to `/login?redirectTo=...` and comes back, signed in it offers
the Authorize button. It is a standalone route because the dashboard layout's
unauthenticated redirect is a fixed `/login?redirectTo=/dashboard` and a
server layout cannot see the current pathname.

## Google Meet: the fallback video link

Zoom is a whole integration. Google Meet is a **flag on the calendar insert**,
and the difference explains everything about its shape.

A Meet link is not created by a separate service. It is created BY the Google
Calendar event: `bookOnProvider` sends `conferenceData.createRequest` plus
`?conferenceDataVersion=1` and Google answers with a `hangoutLink`
([src/lib/google/meet.ts](src/lib/google/meet.ts)). So there is no OAuth app,
no token table, no webhook, and **no new scope**: `calendar.events` already
covers it, which matters because
[workspace-scopes.ts](src/lib/google/workspace-scopes.ts) documents a new
sensitive scope as a fresh Google verification, not a code change.

- **Zoom wins; Meet is the fallback.** The Zoom decorator runs first, and
  `wantsMeet` requires `zoomMeeting === null`. That IS the precedence rule:
  there is no resolver to keep in step, and a tenant never gets two links.
- **Google calendars only.** Microsoft and CalDAV have no event that could
  carry a Meet conference. So does **platform mode** on the booking page,
  which writes a synthetic `platform:<uuid>` id and no calendar event at all,
  and is by definition the case where no Google account exists. Those tenants
  keep Zoom as their only video option. This is the boundary of the design,
  not a gap to close later.
- **Opt-in, default off** (`businesses.google_meet_enabled`, toggled on
  Dashboard → Integrations → Google). Zoom's off switch is "do not connect
  Zoom"; Google is already connected for mail and calendar by tenants who
  never asked for video, so defaulting this on would have put a join link on
  every in-person appointment in the fleet on deploy day.
- **The conference rides the request that creates the appointment**, so a
  calendar that refuses `hangoutsMeet` (secondary calendars, which is what
  `ensureSharedCalendar` makes, do not reliably allow it, least of all on a
  personal `@gmail.com`) would answer 400 and take the BOOKING with it. The
  Meet insert therefore goes through `workspaceProxyStatusForBusiness`, and a
  4xx re-books once with no conference. A failure with **no** status (timeout,
  socket reset) is deliberately never retried: a timeout that did create the
  event would book the slot twice.
- **Nothing to move, delete, or clean up.** The conference belongs to the
  event, so a reschedule PATCH (which sends no `conferenceData`, and the
  default `conferenceDataVersion=0` preserves rather than clears) leaves the
  link alone, and a cancel deletes it with the event. `zoom_meeting_id` stays
  Zoom's lifecycle handle and must never receive a Meet value: nine call sites
  read it and immediately call the Zoom API. Meet gets its own terminal
  column, `calendar_booking_dedupe.meet_join_url`.
- **The link reaches the customer through OUR channels only.** Nothing sets
  `sendUpdates`, so Google sends no invitation mail for us. That is why the
  one re-read for a still-pending conference is load-bearing: if it comes back
  empty the appointment is real and the event shows a join control, but the
  confirmation text and email have no link to quote.

## Public self-serve booking page (Bookings)

Every business can hand out ONE public booking link, `/book/<ncb_token>`
(capability token, plaintext by design like the webchat site key; no login,
no account). Visitors pick a duration and a slot on a Calendly-style
two-panel page (EN/ES, visitor-timezone rendering) and book; the write rides
`bookCalendarAppointment`, so Zoom decoration, the `calendar_booking_dedupe`
ledger, `appointment_booked` goal fan-out, and contact filing (tag `Booking
Page`, channel `booking_page`, fires `contact_created` so round-robin lead
assignment picks an on-shift employee) behave exactly like AI-made bookings.
The tag and the channel answer different questions and both are kept: the tag
is the ORIGIN and never expires, the channel is the LAST touch and moves with
every later interaction. The page filed under `webchat` until migration
`20260822160258`, which made the contact badge, the CSV export, the MCP read
tool, and the AI preamble all claim a visitor who only filled in a form had
chatted with the widget. The **owner alert is
the exception** and is fired by the page itself rather than by the booking
core, for two reasons: a page booking was made by the VISITOR, so the copy
must not credit the AI coworker for it, and the alert reports who is on the
hook, which is not known until the contact is filed and the assignee is
stamped. See "What the owner is told when a booking lands" below.
Owner management lives on the **Bookings** sidebar page
(`/dashboard/bookings`, below Employees). The page auto-provisions, enabled,
the first time the owner opens Bookings (safe because the token is
unguessable until shared; Vagaro/Calendly tenants are skipped since booking
lives on the provider's own page).

The page reads as Calendly does, because the alternative confused owners:
one scheduling link on a single line at the top (Copy, live toggle, and a
"Customize" disclosure holding the vanity slug, the blurb, and the rotate
button), then **Meetings** as the centerpiece, then everything that
applies to all of them folded into one collapsed "Applies to every meeting"
section (when people can book, who bookings go to, confirmations and
reminders, waitlist), then the upcoming-bookings list. Meeting types are
the ONLY way to define what gets booked: the page carries the shared
policy, never a competing duration, questionnaire, or heading of its own.
A visitor reads the business name plus the meeting's own name, which is why
there is no page-level heading field at all: `booking_pages.title` is gone,
column included. It had lost its editor and its public render in two earlier
passes but kept naming provisioned meetings, so deleting your last meeting
resurrected a heading you could no longer see. Any page with no meetings
still gets one automatically, now always named "Book a call", carrying the
page's description, shortest duration, and questions across
(`ensureDefaultMeetingType`, plus a backfill migration for pages that
predate this), so an owner always lands on a list rather than an empty
page.

- **Meeting types** (`src/lib/booking-page/meeting-types.ts`): the page is
  the shared policy; a meeting type is what a visitor actually books
  ("Discovery call, 60 min", "Support call, 30 min, questionnaire, always
  Ana"). Each type has its own shareable URL, `/book/<page>/<typeSlug>`,
  rendering that meeting ALONE, no picker and no hint that others exist,
  exactly like a Calendly event link: sharing a discovery-call link must
  never expose the catalog. The bare page link is the menu (visible types
  only; one visible type skips the menu, zero types is the original
  duration-picker flow), and a `hidden` type is Calendly's "secret event",
  bookable by direct link but off the menu. An unknown or disabled type
  slug renders the branded "not available" screen, never the menu.
  Inheritance is NULL in storage and resolved in one pure place
  (`effectiveTypeSettings`): a type owns its duration, name, and
  description, and may override the questionnaire (an explicit `[]` means
  "this meeting asks nothing", which is why the column is nullable), the
  assignment (the employee travels WITH the mode, so a type declaring
  round-robin cannot borrow the page's fixed person). Nothing collects
  money yet, so the dashboard shows no price field: the payment columns
  stay as schema hooks only. The booked type is stamped on the
  ledger row (`meeting_type_id`, null on AI bookings and pre-types rows);
  deleting a type never deletes the appointments people hold.
- Availability = live provider free/busy (Google/Microsoft via
  `getWorkspaceBusyBlocks`, CalDAV) intersected with
  `businesses.business_hours` (no hours set = weekdays 9-5; a partially
  specified schedule treats missing days as closed) on a 30-minute
  business-local grid, capped at 14 days by default. Slot responses carry
  only coarse starts, never event data; both public endpoints
  (`/api/book/slots`, `/api/book/submit`) are durably rate-limited and
  CSRF-exempt with the `/api/widget/*` rationale. Slot ends are ALWAYS
  start plus elapsed duration (DST-pinned in `tests/booking-page-slots`,
  the BizBlasts DST lesson).
- Submission re-verifies the slot against live availability before the
  write; the dedupe ledger + attendee guard make the write idempotent, so a
  visitor race re-offers slots instead of double-booking.
- **No calendar integration required (platform mode)**: with zero
  connections the feature stands on its own. Availability = business hours
  minus the booking ledger's own upcoming bookings (each blocks a
  conservative hour), and a booking IS a confirmed `calendar_booking_dedupe`
  row (synthetic `platform:` event id) with the same Zoom decoration, goal
  fan-out, owner alert, and contact filing; the Bookings page's upcoming
  list is the calendar of record and the public confirmation shows the
  Zoom join link directly (no invite email exists in this mode).
  Connecting Google/Microsoft/CalDAV later upgrades the page to provider
  mode automatically.
- **A provider only ever ADDS availability signal**: when a connected
  provider's busy data is unreadable (outage, scope-starved consent), slot
  listing degrades instead of taking the page down. Degradation serves the
  **last-known-good busy snapshot** first: every successful provider fetch
  writes its spans through to `booking_busy_cache` (one row per business,
  service-role only), and a failed fetch reads that snapshot back (24h
  staleness bound, `BUSY_CACHE_MAX_AGE_MS`) unioned with the ledger, so a
  time the provider reported busy stays blocked through the outage. With
  no fresh snapshot it falls back to the platform baseline (business hours
  minus the ledger). The Bookings dashboard's "cannot read availability"
  warning tells the owner reads are failing either way; only provider
  events created DURING the outage are invisible (double-booking those is
  possible) until the connection heals, and bookings keep landing on the
  provider when its write path still works. Cache reads and writes are
  best-effort (`src/lib/booking-page/busy-cache.ts`): a cache error
  degrades exactly like a cache miss.
- **Invitee self-serve** (`/book/manage/<ncbm_token>`): every page booking
  gets its own per-BOOKING capability token, carried on the confirmation, so
  the visitor can reschedule or cancel without texting the business. The
  token shape is deliberately disjoint from the page token, so a leaked
  manage link can never act as the business's booking page. A well-formed
  manage link that no longer resolves (usually a visitor re-clicking the
  emailed link after cancelling) renders a "no longer active" explanation,
  not a 404; the app-wide branded 404 (`src/app/not-found.tsx`) covers
  junk URLs and every other `notFound()` with expired-link-aware copy. In provider mode
  the reschedule/cancel CORES own the change (the provider sends its own
  updated or cancelled invitation); in platform mode the ledger row IS the
  appointment, so it is moved or deleted directly and the freed time goes to
  the waitlist exactly like a provider-side cancellation. A new time must be
  a slot the page is offering right now (the same re-verify the public
  submit does), the page's `min_notice_minutes` closes the window near the
  appointment ("contact the business"), and a Calendly reschedule-link
  answer is refused rather than shown as a move that has not happened. The
  token survives a reschedule; AI-made bookings are untouched (no token, no
  behavior change).
- **Confirmations and reminders** (`src/lib/booking-page/reminders.ts`): a
  branded confirmation email at booking time, then an email a day out and a
  text a couple of hours out (lead times per page; 0 turns a channel off).
  The confirmation carries what a bare calendar invite cannot: the time in
  BOTH the visitor's and the business's zone, the video link, and the manage
  link. Sent from the tenant's connected mailbox, so it reads as the business
  writing; tenants without one simply do not get it and the booking is
  unaffected. Every send is CLAIMED on the booking row before it goes out
  (`reminders_sent`, conditional update), so an overlapping tick, a retry, or
  a mid-sweep redeploy can never text someone twice: an owner would rather a
  reminder be missed than doubled. A missed exact moment still sends while
  the appointment is in the future, since a late reminder beats none. Texts
  ride the STOP-list gate and the metered Telnyx path like every other
  customer-facing send, and both follow the contact's stored language. Scope
  is keyed on a `booking_source` stamp rather than the manage token, so page
  bookings are the only ones swept (AI, voice, and synced appointments never
  opted in) and a booking whose manage-link stamp failed is still reminded.
  Entry point `/api/internal/booking-reminder-sweep`, kicked ~1/min by the
  ai-flow-worker tick.
- **Who the booking is for** (`src/lib/booking-page/assignment.ts`): a page
  books either the business as a whole (`any`, the original behavior, no
  assignee recorded), the team (`round_robin`), or one employee (`fixed`).
  The mode is visible to the visitor AS AVAILABILITY: an assigned page reads
  the roster regardless of the require-staff toggle and offers only times
  somebody who could take the booking is actually working. Round robin picks
  the eligible member with the LIGHTEST upcoming load (tie broken by who has
  waited longest, then a stable id), so a week emptied by cancellations
  self-corrects instead of a rotation pointer compounding the imbalance. A
  `fixed` page whose employee left falls back to the whole roster rather than
  showing no times, and a booking that cannot be assigned (nobody on shift by
  the time it lands) is recorded unassigned and logged: the visitor already
  holds the time, so a bookkeeping gap never becomes a lost appointment.
  The assigned member is texted the moment a booking lands on them (who,
  when, how long, from the business's own number), owner-toggleable per
  page (`notify_assignee`, on by default: the person who must show up
  should hear about it); the STOP list applies to staff numbers like
  anyone else's, and a failed text is logged, never surfaced (the booking
  and the visitor's confirmation are already durable). A retry that fills
  a missing assignment sends the text then, the first moment the booking
  has an owner to tell. The OWNER's own alert names that person rather than
  reporting the lead as unowned, which is what it used to do while the
  platform was texting the assignee seconds later.
- **What the owner is told when a booking lands**
  (`src/lib/calendar-tools/unassigned-booking-alert.ts`, copy in
  `src/lib/email/templates/booking-owner-alert.ts`): one alert, three states,
  because "who is on the hook" has three real answers and the alert used to
  express only one of them.

  | State | When | What it says |
  | --- | --- | --- |
  | `solo` | no ACTIVE `ai_flow_team_members` row | just the booking. No "owner", "assign", or "teammate" anywhere: there is nobody to assign to and the owner is on the hook by definition |
  | `covered` | the booking's `assignee_member_id`, else `contacts.owner_employee_id` | names that person, and drops the warning |
  | `unowned` | a roster exists and nobody holds this lead | the original warning, plus the one action that fixes it |

  The assignee outranks the contact owner: the question is who shows up to
  THIS meeting. The button deep-links to `/dashboard/customers/<e164>`, where
  the owner picker is, rather than to a bare `/dashboard`. Two fail
  directions are deliberate: an unreadable roster count assumes a team (a
  solo owner seeing team copy is a wording miss, a team losing the warning is
  a no-show), and a holder whose name will not resolve degrades to the
  warning rather than emailing a blank name. Gated on
  `notification_preferences.unassigned_booking_alerts`, ON by default, which
  covers all three states.

  Running late costs a wider crash window, so the alert is **claimed on the
  booking row** before it goes out (`calendar_booking_dedupe.owner_alerted_at`,
  the same conditional-update shape `assignee_member_id` uses). A request that
  persists the booking and then dies leaves the claim open, so the visitor's
  idempotent resubmit sends the alert nobody sent; an ordinary resubmit finds
  it taken and stays quiet. A claim that cannot be WRITTEN alerts anyway on
  the first pass (a possible duplicate beats an appointment nobody knows
  about) and stays silent on a resubmit (where "already told" is the
  overwhelming case). A gap-fill retry alerts even when the claim is gone,
  because who has it is genuinely new.

  One race remains and is known: flow-driven lead assignment runs in the
  AiFlow worker, so `contacts.owner_employee_id` can land after the booking
  returns. The booking page's own assignee is resolved synchronously and is
  fully covered; a delayed re-check before sending would close the rest.
- **Intake questions** (`src/lib/booking-page/intake.ts`): up to five
  owner-defined questions in the white-glove questionnaire's vocabulary
  (choice, multi, text, textarea), answered inside the booking form. Two
  validators at two trust levels: the OWNER's stored list is normalized
  leniently (junk questions are dropped, never fatal, so settings rot cannot
  take the public page down), the VISITOR's answers are checked strictly
  (required answered, choices from the offered options, all lengths capped)
  and a miss refuses BEFORE any slot claim. Answers to questions that no
  longer exist are discarded, not refused: the owner may have edited the
  page under an open form. Each question has an Ask toggle: pausing keeps it
  saved for next month instead of forcing a delete-and-retype, and a paused
  question never reaches the public form (a paused REQUIRED question must
  not block bookings). Answers travel with the appointment: the provider
  event's notes, and structured `intake_answers` on the ledger row.
- **Payment hooks, schema only** (v3 groundwork): `payment_required`,
  `payment_amount_cents`, `payment_currency` on `booking_pages` and
  `payment_status` on the ledger, with the ONE invariant already enforced:
  a page marked as requiring payment refuses public bookings (409 with
  contact-the-business copy) until collection ships, so it can never hand
  out free appointments. No dashboard control yet by design; the price pair
  must arrive together (requiring payment without a price is refused).
- **The coworker knows the business's scheduling link, whichever calendar
  they book with** (`src/lib/booking-page/prompt-line.ts`): every
  owner-facing AI surface (dashboard chat, owner SMS, the email coworker)
  gets a system line naming the link and the meetings it books (one meeting
  is named outright, several are listed as the choice the visitor gets),
  resolved by the same provider order the calendar tools use: Calendly
  tenants get their
  Calendly event type's scheduling URL, Vagaro tenants get NO link (their
  site's URL is not held by the platform, and no link beats an invented
  one), and everyone else gets the native booking page, PROVISIONED on
  first need when the owner has never opened the Bookings dashboard (same
  rule as the dashboard's first view: created enabled, token unguessable
  until shared; a page the owner disabled stays off). The
  link is the DEFAULT for a delegation: a bare "schedule Liz through her
  assistant Beth, her email is X" sends Beth the link without the owner
  naming it (an address-supplied delegation is itself the send
  instruction), the model must not bounce a link-or-times menu back to the
  owner, and listed times happen only on an explicit ask. Computed per turn
  and best-effort, so a failed read costs the hint, never the turn. Pinned
  by live-model scenarios in `tests/e2e/beth-delegation.e2e.test.ts`,
  including the bare ask (6/6 hammer runs) with the exact URL asserted in
  the composed email.
- Vagaro/Calendly-resolved tenants deliberately do NOT get the page (Vagaro
  has its own booking site; link-mode Calendly cannot book on the invitee's
  behalf); the Bookings page explains this and calendar resolution order is
  untouched. Deliberate v1 exclusions: round robin / pick-a-person,
  routing forms, embeds; payment COLLECTION (the schema hooks are in).

## Team calendar (shared "NewCoworker" calendar + subscribable feed)

Two mechanisms, one goal: the whole team sees what is booked, wherever it
was booked.

- **The shared "NewCoworker" calendar** (`src/lib/calendar-tools/shared-calendar.ts`)
  lives on the business's connected Google or Microsoft account, created
  lazily on first booking, with employee read-access grants and an all-day
  time-off mirror. Its HOST is resolved independently of who takes the
  bookings (`resolveSharedCalendarHost`, not `resolveCalendarConnection`):
  a merchant who books on Vagaro or Acuity but runs on Google Workspace
  still gets the calendar. Bookings taken on a provider that is NOT the
  host (Vagaro, Acuity, Calendly, CalDAV) are MIRRORED onto it
  (`mirrorBookingToSharedCalendar`); Google/Microsoft bookings are never
  mirrored, because `bookOnProvider` already wrote them there and a mirror
  would duplicate every event. The mirror's event id rides the
  `calendar_booking_dedupe` row so reschedule moves it and cancel deletes
  it: a mirror that outlives its appointment shows the team something
  that is not happening.
- **The subscribable feed** (`GET /api/calendar/<ncbf_token>.ics`,
  `src/lib/calendar-tools/feed.ts`) renders the booking ledger's upcoming
  rows as ICS for ANY calendar app that can subscribe to a URL. It is the
  mechanism that works for every tenant: no Google/Microsoft account
  needed, and none of the dedicated booking tools lets an outside app
  create a calendar (iCloud also refuses CalDAV MKCALENDAR). The token
  (`calendar_feed_tokens`, minted on first ask from the Bookings page's
  "Team calendar link" card) is a plaintext capability like `ncb_`,
  rotatable to revoke every shared copy at once. The feed carries display
  names only, never phones or emails, so a forwarded link cannot leak
  the contact list. Subscription semantics do the lifecycle work: clients
  re-download and replace, so canceled bookings (deleted ledger rows)
  disappear on the next sync and rescheduled ones move (stable UID = the
  ledger row id).

## Every business text is metered

Two ledgers, one rule: nothing reaches Telnyx uncounted. Customer-facing
sends reserve a slot against the tier's monthly cap BEFORE sending
(`try_reserve_sms_outbound_slot`, DB-side and atomic; `sendTelnyxSms` with
`meterBusinessId` on the Next side, the same RPC from the edge workers).
Operational sends (owner alerts, provisioning, the voice-bridge's
missed-call fallback / intake lead summary / transfer pre-alert) count
through `meter_sms_operational_send` instead, tracked without consuming
the customer allowance or being throttled by it. The Jul 2026 audit found
exactly one leak, the three voice-bridge sends, whose comments claimed
"tracked on the Edge/web side" while the outbound webhook was
telemetry-only; the bridge now meters each successful send itself
(`meterBridgeOperationalSms`). If you add a sender, it meters through one
of those two paths or it does not ship.

## International reachability: SMS is NANP-only, voice is not

The single most important deliverability fact on the platform, confirmed
by Telnyx support in ticket #557577 (Aug 2026): **our long-code numbers
cannot originate SMS to any destination outside NANP (+1), at all.** This
is a property of the number type, not configuration. Every messaging
profile whitelists 223 countries (via
`scripts/oneshot/widen-telnyx-destinations.ts`; Canada must be added
explicitly there, since it shares bare +1 and the dial table cannot
represent it, which is exactly how the Aug 6 2026 CA-whitelist outage
happened), every DID still reports
`features.sms.international_outbound: false`, and no profile setting,
API call, or support escalation changes it: "US long codes are for
domestic traffic only." A text to +52, +852, or +44 fails at Telnyx with
error 40309 no matter what.

What this means channel by channel:

- **SMS: +1 only.** The destination gate inside
  `try_reserve_sms_outbound_slot` (denylist, unknown-prefix refusal,
  per-country velocity, per-destination text-unit multipliers from
  `src/lib/sms/destination-rates.ts`) exists so metering and guardrails
  are ready if a capable sender type ever ships, but today every
  non-NANP send dies at Telnyx regardless.
- **Alphanumeric sender (registration pending): one-way only.** The
  supported Telnyx path for international notifications is the
  registered alphanumeric sender NEWCOWORKER. It has no inbound path, so
  it carries owner alerts but never customer conversations, per the RCS
  precedent. Everything is staged behind `TELNYX_INTL_ALPHA_PROFILE_ID`
  (unset = dormant): the dedicated profile exists
  ("New Coworker International Alerts",
  `scripts/oneshot/create-intl-alpha-profile.ts`), the owner-alert
  senders route through it when set, and
  `PRDs/alpha-sender-rollout.md` is the activation runbook, gated on
  Telnyx's registration approval AND written fee confirmation.
- **Mexico: WhatsApp only.** Mexican carriers overwrite ALL alphanumeric
  senders to random local numbers, domestic MX long codes allow
  automated traffic for one-time passcodes only, and a branded two-way
  short code costs $500 to $1,000+ per month with months of carrier lead
  time. Customer messaging for MX tenants is WhatsApp, full stop; the
  Mexico v1 SMS surcharge pricing predates this finding and needs review
  before any MX tenant goes live.
- **Voice: works internationally.** The shared outbound voice profile
  whitelists the same 223 countries, so forwarding legs, warm transfers,
  and owner-notify calls reach international owner phones (for example a
  +852 forwarding number behind a +1 DID). Guardrail: the profile
  carries a fleet-wide **$25/day spend limit** (raised from $10 in Aug
  2026); one marathon international call can exhaust it and block every
  tenant's outbound legs until midnight UTC, so raise it deliberately,
  not reactively, if international forwarding becomes routine.
- **Email, WhatsApp, dashboard: unaffected** by any of this.

The UI keeps owners out of the trap: `src/lib/phone/deliverability.ts`
classifies any typed number (`smsReachability`), and the owner profile
card, the notifications alert phone, and the Safe Mode forwarding cell
all warn as-you-type when a number is outside SMS reach (the forwarding
warning says calls still forward, texts do not). The warnings never block
the save: an international forwarding number is a legitimate,
voice-only setup.

## Cancellation waitlist ("I'll let you know if a spot opens")

When an appointment slot FREES UP, the platform offers it by text to the
customer who asked for an earlier time, encoding the real-life exchange
"if you can come any sooner please let me know" / "I'll let you know if I
have a cancellation" (PR #903). One live `booking_waitlist` entry per
(business, phone) (RLS-on/no-policies), captured two ways: the
`calendar_join_waitlist` coworker tool (texting, dashboard chat, owner
SMS, and voice, wired through the tool parity contract) and the booking
page's "Text me if an earlier time opens up" opt-in. Entries link to the
customer's upcoming booking, so a freed slot is offered only when it is
EARLIER than what they hold, and they expire when that booking starts.

- **Freed-slot detection funnels into ONE core**
  ([src/lib/calendar-tools/waitlist-fill.ts](src/lib/calendar-tools/waitlist-fill.ts)
  `offerFreedSlot`): `calendar_cancel_appointment`, the reschedule tool's
  vacated old start, the calendar poll's observed off-platform
  cancellations (a callback wired in `/api/internal/aiflow-calendar-poll`;
  the canceled customer's identity is derived from the event's
  `Phone:`/`Email:` marker lines), and the Vagaro webhook's cancels and
  moves (the union of the payload start and the ledger-recorded starts).
- **Offer mechanics**: the slot is re-verified against LIVE provider
  availability (fail closed), then the oldest eligible candidate gets ONE
  metered SMS (STOP list fail-closed, `sms_outbound_log` source
  `waitlist_offer`, EN/ES per `contacts.preferred_language`) under a
  compare-and-set hold with the owner's TTL (default 60 min). A lapsed
  hold passes to the NEXT candidate, never back to the same person; the
  actor who freed the slot is excluded, and a canceler's own entries drop.
- **Acceptance rides the normal conversation**: a pending offer is
  appended to the `/api/internal/contact-booking-context` preamble line,
  so a "YES" reply completes through the existing
  `calendar_reschedule_appointment` / `calendar_book_appointment` tools.
  Confirmed bookings resolve entries: fulfilled when the new time beat
  what they were waiting on, otherwise re-pointed (a booking-derived
  window moves with the booking; a still-pending earlier offer stays
  live under its own TTL).
- **Maintenance** (window expiry + hold handoff, `sweepWaitlist`) rides
  the ~1/min calendar-poll tick. Owner knobs (master toggle, ON by
  default; offer hold length) live on `/dashboard/bookings`. Everything
  is best-effort by contract: a waitlist failure can never affect the
  booking, cancel, reschedule, webhook, or poll result that triggered it.

## Writing rule: NO EM DASHES, ever, in any context

**Never use an em dash. Anywhere.** Not in user-facing copy, SMS/email
templates, AI prompts, i18n catalogs, code comments, docs, PR titles/bodies,
commit messages, or blog posts. Use a comma, a period, or a colon instead.
Three layers hold this in place:

- **Every AI worker/model prompt carries a no-em-dash instruction** so
  generated text never contains one: the shared `NO_EM_DASH_PROMPT_LINE`
  (`supabase/functions/_shared/sms_prompt_lines.ts`) is injected on the
  texting-coworker, dashboard/owner-chat, messenger/WhatsApp/webchat, and
  voice surfaces (the voice bridge and blog composers carry lockstep copies).
  Blog output is additionally scrubbed in code (`src/lib/blog/copy.ts`
  `stripEmDashes`, which also runs on admin editor saves).
- **CI guard**: `tests/no-em-dashes.test.ts` fails when an em dash appears in
  the guarded user-facing surfaces (message catalogs, email templates,
  prompt-line modules, notification copy, one-shot flow templates, and every
  file in `.github/workflows/`, which composes the deploy-failure email body
  and subject plus the PR preview-URL comment). Widen its file set as more
  areas are cleaned; never shrink it.
- **Legacy instances** in comments/docs (thousands, pre-rule) are cleaned
  opportunistically: never add a new one, and sweep a file you are already
  editing when cheap. Live tenant flow copy was scrubbed via
  `scripts/oneshot/strip-em-dashes-flows.ts`.

## AI search visibility (AEO)

Buyers increasingly ask an assistant instead of searching, so being readable
and citable by ChatGPT, Claude, Perplexity, and Copilot is a distribution
channel, not an SEO detail. Three pieces hold it up.

**0. One canonical host: `www`.** [src/lib/marketing/site-url.ts](src/lib/marketing/site-url.ts)
is the single `SITE_URL`, and `tests/site-url.test.ts` fails the build if a
hardcoded origin reappears anywhere in `src/`. It used to be copy-pasted into
six files as the APEX while the blog pages quietly used `www`, and since the
apex redirects every path to www, every canonical tag, og:url, and sitemap
entry pointed at a URL that redirects. Import it; never re-declare it.

**1. The crawlers must actually reach us.** Every AI agent we care about is
listed once in [src/lib/marketing/ai-crawlers.ts](src/lib/marketing/ai-crawlers.ts),
whose `kind` drives the whole split: `index`/`fetch` agents (the ones that
answer a question and cite us) are explicitly allowed, `train` agents are
disallowed outright. That registry feeds the served robots.txt
([src/lib/marketing/robots-txt.ts](src/lib/marketing/robots-txt.ts) →
`/robots.txt`), the access probe, and AI-traffic attribution. A crawler that
matches its own robots group ignores `*` entirely, so the disallows
(`/dashboard`, `/admin`, `/api`) are repeated in each group rather than
inherited.

There are **two independent ways to be shut out**, and only the first
produces an error anyone would notice:

- **Transport**: the edge refuses the request. The zone's **"Block AI bots"**
  setting and **Super Bot Fight Mode** both challenge these agents with a 403
  or an interstitial and ZERO origin trace, exactly like the Claude-connector
  failure under [Claude connector](#claude-connector-remote-mcp). Free-plan
  Bot Fight Mode ignores WAF skip rules entirely and must stay OFF.
- **Policy**: transport is fine and robots.txt tells the agent to go away. A
  well-behaved crawler then never requests anything, so every status code is
  200, nothing errors, and the only symptom is silence on `/admin/ai-search`.

The probe checks both. Read-only, no credentials, non-zero exit on either:

```bash
tsx debug/aeo-crawler-probe.ts            # production
tsx debug/aeo-crawler-probe.ts https://…  # any other origin
```

> ⚠️ **Cloudflare's "Managed robots.txt" must stay OFF**
> (AI Crawl Control → Signals). It is a single on/off toggle with no
> append-vs-replace option, and it *creates or updates* the file, which broke
> differently on each host (observed 2026-07-26, before it was disabled):
>
> - `www` got the managed block **prepended to** ours, so seven agents
>   appeared in an allow group and a disallow group at once, and which one
>   won was up to each crawler's parser.
> - The **apex** got the managed block **only**, because the apex serves no
>   origin robots.txt of its own. Nothing disallowed `/dashboard`, `/admin`,
>   or `/api` there, and there was no `Sitemap:` line at all.
>
> Its policy (`search=yes, ai-train=no`) is preserved verbatim in
> [robots-txt.ts](src/lib/marketing/robots-txt.ts), Content-Signal included,
> so turning it off cost nothing and bought one reviewable, tested source of
> truth. **Change the training posture by flipping a token's `kind` in the
> registry, not by re-enabling the Cloudflare feature.** The probe fails if
> the managed block reappears, if our file stops being served, or if the
> served file disagrees with the registry token-for-token.

### Why the above drifted, and the rules that keep it from drifting again

Both defects here (the apex robots.txt and the apex-canonical mismatch) were
live for months, shipped nothing red, and were found only by fetching the site
from outside and reading the bytes. They share one cause worth naming, because
it will recur in other places if it is not:

**Two sources of truth for one served artifact, with nothing reconciling
them.** Cloudflare's dashboard and `src/` both generated robots.txt. Neither
knew about the other, the merge happened at the edge where no test could see
it, and the failure mode was silence rather than an error. The canonical host
was the same shape: `SITE_URL` was copy-pasted into six files plus four inline
literals, so "change the host" was ten edits and any missed one drifted
quietly. The blog pages had in fact already drifted to `www` while everything
else said apex, and nothing noticed.

Standing rules, in priority order:

1. **Generate it in code, or at the edge, never both.** If a Cloudflare (or
   Vercel, or DNS) feature produces a file or header we also produce, turn one
   of them off. An edge feature that "creates or updates" something we own is
   a drift generator, and its output is invisible to CI by construction.
2. **A constant that describes the deployment gets exactly one home.**
   `SITE_URL` lives in
   [src/lib/marketing/site-url.ts](src/lib/marketing/site-url.ts) and nowhere
   else; `tests/site-url.test.ts` fails the build if a hardcoded origin
   reappears in `src/` outside a doc comment. Copy the pattern rather than the
   value. The public contact address is the second instance:
   [src/lib/marketing/contact-email.ts](src/lib/marketing/contact-email.ts)
   owns it, `contactEmail()` resolves it, and `tests/contact-email.test.ts`
   bans both a hardcoded `contact@newcoworker.com` and a re-declared
   `process.env.CONTACT_EMAIL ?? ...` fallback anywhere else in `src/`. It
   had been copy-pasted into seven surfaces, all of them naming an address
   (`team@newcoworker.com`) that deployment had long since replaced. The ops
   inbox (`OPS_NOTIFICATION_EMAIL`) is a separate constant with its own home
   and is not covered by that guard.
3. **Anything only observable from outside needs a probe that runs from
   outside.** Unit tests assert what we *intend* to serve;
   `debug/aeo-crawler-probe.ts` asserts what is *actually* served and fails on
   any disagreement with the registry, in both directions. That reconciliation
   is the only thing that would have caught either defect.
4. **Treat silence as a symptom.** A robots.txt policy block, an edge
   challenge, and a crawler that simply is not interested all look identical
   from the origin: no errors, no logs, nothing. `/admin/ai-search` exists so
   that absence is visible, and the probe exists to tell the three apart.

**Run the probe after any change to the Cloudflare zone, the DNS records, the
hostnames, or `src/lib/marketing/*`** — and periodically regardless, since the
things it watches are changed by vendors, not only by us:

```bash
tsx debug/aeo-crawler-probe.ts                        # apex
tsx debug/aeo-crawler-probe.ts https://www.newcoworker.com
```

> **Known, deliberate, not drift:** the apex serves a **308** (permanent) to
> `www`, configured as a Vercel project domain redirect (`redirect:
> www.newcoworker.com`, `redirectStatusCode: 308`), NOT in `vercel.json` or
> Cloudflare. It was Vercel's default 307 until 2026-07-27; a temporary
> redirect told crawlers the apex was still the real home and to keep it
> indexed, which contradicted the canonical tags, og:url, sitemap, and
> robots.txt that all name `www`, and left authority on any apex inbound link
> only partly consolidated.
>
> `308` rather than `301` because it is the permanent counterpart of the `307`
> it replaced and preserves the request method; Google and Bing treat it the
> same as `301` for canonicalization. **Permanent redirects are cached hard by
> browsers**, so serving content from the apex again would strand anyone who
> already followed this one. That is the cost of reversing, and it is why
> `SITE_URL` moving back to the apex is not a small change.

**2. A brief written for machines.** `/llms.txt` (short index) and
`/llms-full.txt` (adds differentiators, industries, recent posts) are composed
in [src/lib/marketing/llms-content.ts](src/lib/marketing/llms-content.ts) and
served by route handlers, NOT kept as a static file: the facts they state
(prices, included minutes, SMS caps) live in `src/lib/plans/*`, and the static
`public/llms.txt` they replaced had gone stale against the Jul 2026 tier
relaunch without anyone noticing. `tests/llms-content.test.ts` pins the output
against `getPeriodPricing` / `TIER_LIMITS`, so a pricing change that misses
this file fails CI. The module is also under the no-em-dash guard.
`/llms-full.txt` reads the English catalog directly rather than through
next-intl, since the request config resolves the READER's locale and would
otherwise hand a Spanish brief to a crawler sending `Accept-Language: es`.

**3. Tell the index immediately.** ChatGPT's search rides Bing's index, and
Bing is the largest IndexNow participant, so a page can be citable the day it
ships instead of whenever a crawler returns. Two things ping
[src/lib/marketing/indexnow.ts](src/lib/marketing/indexnow.ts):

- **A blog publish**, via `runBlogPublishSideEffects` (both the sweep and
  admin "Publish now"), with the post, `/blog`, and the sitemap.
- **A production deploy that touches public pages**, via the `indexnow-ping`
  job in [.github/workflows/ci.yml](.github/workflows/ci.yml) running
  `scripts/indexnow-submit.ts`. Publishing a post used to be the ONLY trigger,
  so shipping a marketing page announced nothing: the four `/compare/*` pages
  were found only because the sitemap happened to get crawled.

Best-effort by contract everywhere: the module never throws, it cannot
un-publish a post, and the CI script **always exits 0**. A search-engine
notification must never read as a failed deploy, which is also why the ping is
its own job rather than a step in `Vercel Deploy` (see the comment there:
`main-failure-watch.yml` keys its "production did not update" email off that
job's conclusion).

- **Env**: `INDEXNOW_KEY` (8-128 chars of `[A-Za-z0-9-]`, e.g.
  `openssl rand -hex 16`). Unset = feature off. The key is **public by
  design**: it is served at `/indexnow-key.txt` as the ownership proof the
  engines fetch. Served from a fixed path with `keyLocation` rather than the
  protocol's default `/{key}.txt`, so there is no committed filename to keep
  hand-synced with an env var; a key file in the root directory scopes to the
  whole host either way. **CI holds no copy** and needs no GitHub secret: it
  reads the key off the live site, exactly as an engine would.
- **What gets submitted, and why the whole set.** The URL list comes from the
  LIVE sitemap plus the machine surfaces it never lists (`/llms.txt`,
  `/llms-full.txt`, `/sitemap.xml`), never a path-to-URL table: a table is the
  drift shape from the section above, where a new page needs a registry entry
  nobody remembers. The changed-file list decides IF we ping, not WHICH URLs,
  because shared marketing components and the shared copy catalogs genuinely
  can change any page. At ~29 URLs on a handful of deploys a week that is far
  inside the protocol's limits (10,000 per request).
- **Fail CLOSED** (`deployTouchesPublicPages` in
  [src/lib/marketing/indexnow-deploy.ts](src/lib/marketing/indexnow-deploy.ts)):
  no changed-file list, or nothing public in it, means no ping. Deliberately
  the opposite of `e2e-scope.sh`, which fails open. Missing a ping costs a few
  days of latency since the weekly auto-post re-submits the sitemap anyway;
  announcing every URL on every backend-only deploy is the rate-limit-courting
  behavior the protocol asks us not to have.
- **On demand**, when something important just shipped:

```bash
tsx scripts/indexnow-submit.ts --all --dry-run   # print what would go
tsx scripts/indexnow-submit.ts --all
```

- **Manual, one-time**: verify the site in Bing Webmaster Tools and submit
  `https://www.newcoworker.com/sitemap.xml` there (done 2026-07-27; one
  property covers both hosts). IndexNow accelerates recrawl of a known site;
  it does not replace initial verification. **Bing Webmaster Tools → IndexNow
  is where to confirm pings are actually landing** — the submission returns
  202 ("received, key validation pending"), so a 202 alone does not prove the
  key file was readable.

**4. Know whether any of it worked.** `/admin/ai-search` answers the only two
questions that matter: are the assistants READING us (crawler hits, by day and
by operator) and are they CITING us (people arriving with an AI surface as
their `Referer`). Without it the rest of this section is unfalsifiable.

- **Where the write happens**: [src/proxy.ts](src/proxy.ts) `noteAiTraffic`,
  the only place that sees every request WITH its path, before rewrites. A
  normal request costs two header reads and a failed string match; only a
  matched request writes, and the write rides `event.waitUntil` so it never
  delays the response. Proxy runs on the Node.js runtime in Next 16, and
  `after()` is not available there, so `waitUntil` is the primitive.
- **Crawler identity beats referrer**: `ChatGPT-User` fetches on a person's
  behalf and can carry both, and filing that as a referral would inflate the
  human number with robot traffic.
- **Not analytics**: `ai_traffic_events` stores kind, source, operator, path,
  and time. No IP, no session, no user, no query string, and the
  capability-token surfaces (`/book`, `/intake`, `/sign`, `/s/`) are excluded
  so a token can never land in the `path` column. It is platform ops data, so
  it sits outside the per-tenant retention window and the end-user erasure
  surface; the daily retention sweep prunes it at a fixed 90 days beside
  `kg_retrieval_events`.
- **Read the absences.** The page names operators with ZERO hits, which is
  the signature of an edge block and produces no other symptom: run
  `tsx debug/aeo-crawler-probe.ts`, then check Cloudflare Security → Events
  before assuming disinterest. Two guards keep that alarm honest, because a
  false one sends you hunting a Cloudflare problem that does not exist: only
  `OBSERVABLE_AI_OPERATORS` can be listed (an operator whose sole registry
  entry is a robots.txt opt-out control, Google via `Google-Extended`, never
  appears in traffic by definition), and the check is suppressed entirely
  when the row fetch truncates, since the newest N rows cannot prove an
  operator was absent earlier in the window.

## Prospecting (outbound: the coworker finds and emails its own prospects)

Every other channel waits for someone to arrive. Prospecting goes and finds
them: Google Places discovery across the trades and towns a tenant chooses, a
probe of each prospect's own site, a short pitch built from what the probe
actually found, sent from the tenant's own connected mailbox, and then the
email coworker answering whatever comes back. It is off for every business
until an owner switches it on, from Dashboard, Marketing.

Ported from the honedtech Prospector, which proved the shape by hand. What
changed is the last mile: there, a person reads a digest and sends from Gmail.
Here the product does it, which is the point of running our own outreach
through our own product.

### The three modes are the owner's switch

`off` (the default) means the sweep never picks the business up at all.
`manual` discovers and drafts, then waits: the owner reads each draft on the
Marketing page and presses Send or Skip. `auto` sends inside the window and
under the cap. The tenant's "Prospect outreach follow-through" AiFlow is a
second, independent off switch, since disabling it stops the filing half.

### Editing a draft, and having it written again

A draft in the review queue is not take-it-or-leave-it. The owner can rewrite
it in place (Save draft) or have the coworker write it again from the same
findings (Write it again), both from the Marketing page, and both only while
the prospect is still `drafted`: a sent pitch is a thing that happened, and
rewriting the ledger copy of a mail already in somebody's inbox would make the
record disagree with reality. Each is a guarded update on that status, the
same claim Send and Skip use, because the queue can be minutes stale.

**The edit box holds the paragraphs, never the whole email.** That is the same
rule as "why the send is NOT a flow step" below, applied to the dashboard: the
CTA, the signature, the unsubscribe link, and the postal address are
concatenated around whatever the owner submits by `assembleBody`, so an edit
cannot delete the footer, because the footer was never in the box. The
paragraphs live in their own column (`outreach_prospects.pitch_paragraphs`),
written whenever a draft is composed. Rows drafted before that column existed
have only the assembled body, so the panel offers them Write it again rather
than an edit box: handing that body back would put the compliance footer
inside an editable field.

Write it again re-composes from the findings already on the row and does NOT
re-probe the prospect's site. A probe is a network fetch of someone else's
server, and a button an owner can press repeatedly must not become one.

Because the edit box holds only the middle, the panel also prints the whole
email underneath it, read-only, exactly as it will send. Without that, pressing
Write it again reads as though it deleted the CTA, the sign-off, and the
footer: those lines are on screen for a legacy draft (which is shown as one
assembled body) and nowhere at all once the draft becomes editable.

### Write it again, for all drafts

The single-draft button cannot answer the case the settings create. Drafts
outlive the settings that produced them, so changing what the email offers, who
signs it, or the footer address leaves a queue of hundreds still carrying the
old wording, and the review list only renders the first
`REVIEW_QUEUE_LIMIT` (25) of them. **Write it again (for all drafts)** rewrites
every `drafted` row for the tenant, capped by nothing but the queue itself.

It runs in batches of `REWRITE_BATCH_SIZE` (20) behind
`POST /api/dashboard/outreach/rewrite-all`, and the panel loops until the
server reports nothing left. One rewrite is one Gemini tone pass of about a
second, so a single request covering a busy queue would sit behind the edge
timeout and throw away everything it had already done.

The cursor is a timestamp, not an offset: the first call gets back a
`startedAt`, every later call passes it, and each batch reads the drafts whose
`updated_at` is older than it, oldest first. Every rewrite stamps `updated_at`,
so a finished draft leaves the window on its own, and rows that move under the
pass (a sweep sends one, the owner skips one) are simply no longer `drafted`
and drop out. A draft that cannot be rewritten (its findings no longer say
anything checkable) is stamped anyway, under the same drafted-only guard, or
the cursor would read it back forever.

Both buttons compose through one function, so a bulk rewrite cannot drift into
producing a different email from the one a single press previews. Like the
single press, it re-composes from stored findings and probes nobody, and it
replaces anything the owner edited by hand, which is why the panel asks twice
and names the count.

### What makes the pitch persuasive, and the line it will not cross

The mail is four paragraphs: the greeting; what was noticed about them AND what
that usually costs, together in one; what the sender does about it; and the ask.
The cost sentence is the one that earns a reply. An observation on its own
("there is no way to book you online") is an interesting fact about somebody's
website; `COST_BY_FINDING` adds the sentence that makes it worth answering
("people who are still deciding rarely wait long"). The two share a paragraph on
purpose, so the gap and what falls through it read as one thought, and
`PITCH_POLISH_INSTRUCTION` tells the tone pass not to split them apart again.

Each cost line also has to agree with the opening it follows. The
`no_online_booking` opening names two routes in, a call and a form, so its cost
line answers both ("either way the job waits on somebody getting back to them");
answering only the call would contradict the sentence beside it. None of them
may assert a site fact the finding did not establish: "there is no way to text
you" says nothing about what else is on the page, and knowing when their hours
end says nothing about what answers the phone afterwards.

Every cost line describes GENERAL behaviour, never this prospect. No
percentages, no revenue figures, no "you are losing N calls a week", and no
naming a competitor. Those are the sentences a cold email most wants to write
and least deserves to: we probed their site, we did not measure their phone. An
invented number is also the fastest way to be caught out by the one reader who
knows the real one. `PITCH_POLISH_INSTRUCTION` forbids the model the same
things, and `tests/outreach-compose.test.ts` asserts both ends of it.

`COST_BY_FINDING` and `OBSERVATION_BY_FINDING` are keyed the same way and read
in the same breath, so a finding code added to one and not the other would ship
"...noticed X. undefined" to a stranger. A test holds them in step.

### Calling off a whole kind of business

Removing a trade from "Kinds of business to look for" only stops the NEXT
discovery pass. Everything that trade already produced stays in the queue:
prospects waiting to be drafted, and drafts waiting to be read, which in
automatic mode still go out. **Skip these**, on each row of the by-trade
breakdown, retires all of it in one press
(`skipVertical`, `POST /api/dashboard/outreach/verticals`).

Skipped, never deleted, for the same reason a single Skip is: the row is what
keeps the domain out of future discovery, so deleting it would only invite the
sweep to find them again. Only `discovered` and `drafted` are cancellable.
`queued` is already in flight and a sent pitch is a thing that happened, so
neither is touched, and the status filter rides inside the UPDATE rather than
being read first, or a prospect the sweep sends between the page load and the
press would be marked skipped after the fact and vanish from the sent count.

There is no tier gate on it. Stopping outreach costs nothing and is exactly
what a downgraded tenant should still be able to do.

**The row has to show what is still live, or a working skip looks broken.** The
by-trade line is all-time (`drafted` counts every prospect that ever reached a
draft, skipped ones included), so retiring a whole trade changed nothing on
screen: "63 drafted" stayed, beside a Skip button that now had nothing to skip
and a confirm that offered to skip 0. `open` is the fix, counted per trade and
kept in lockstep with `CANCELLABLE_STATUSES`: the row prints "N still to go
out", the button only appears while N is above zero, and the confirm counts the
same N the write will catch. A trade with nothing sent AND nothing open is
dropped from the table entirely, since it answers "which trades reply" with
silence and cannot be acted on either. One send keeps it listed forever, because
that is the reply evidence the table exists for.

Two traps this walked into, both worth keeping in mind for anything else that
acts on a funnel row:

**The funnel is a label, the column is a value.** `summarizeFunnel` groups rows
with a blank vertical under `UNKNOWN_VERTICAL` (`"(unknown)"`), and no row
stores that string. Filtering on it literally matches nothing, so Skip these on
that row reported success and retired none of the prospects it was pointing at.
Both queries translate the bucket into "null or empty" through one shared
constant, so they cannot drift apart.

**Retiring a prospect races the pass that is drafting it.** A drafting pass
spends seconds per prospect (a probe, then a model call), so the owner can call
off the trade while it runs. The final draft write is therefore a guarded
transition off `discovered`, not a blind patch: an unguarded write finished the
compose and moved a just-skipped prospect BACK to `drafted`, and in automatic
mode that draft then went out. Losing the claim drops the compose and records a
note, rather than counting a draft that no longer exists.

### Why the send is NOT a flow step

The obvious design is a `send_email` step in the outreach flow. It is wrong
here: the pitch carries a legally required unsubscribe link and postal
address, and a flow step's body is owner-editable copy, so a well-meaning edit
could delete the footer. The pitch is therefore composed and sent in
[src/lib/outreach/sweep.ts](src/lib/outreach/sweep.ts), where the footer is
concatenated after any AI polish, from code the model never sees. It also
makes `sent_at` evidence (a provider message id came back) rather than an
inference from a mailbox.

The flow still owns everything after the send, which is what an owner should
control: filing the contact, tagging it, and the owner brief. It deliberately
carries no send step at all, and a test pins that.

### Compliance is structural, not aspirational

- A check constraint (`outreach_settings_ready_when_on`) makes any mode but
  `off` impossible without an offer line, and without a postal address unless
  the row carries an explicit waiver. You cannot switch this on without the
  things the email legally needs.
- **The postal-address waiver is Enterprise-only, and it is recorded rather
  than inferred.** `postalAddressRequiredForTier`
  (src/lib/plans/prospecting.ts) exempts Enterprise from typing an address
  into the panel; the save path writes that decision into
  `outreach_settings.postal_address_exempt`, which is the column the check
  constraint reads. So the schema still refuses a Standard tenant with no
  address, and a row that was allowed on without one says why on its face.
  The footer line itself is not waived by default: for an exempt tenant,
  `resolveTenant` falls back to the business profile address
  (`businesses.address`), and only when they have no address anywhere does the
  footer print the unsubscribe line alone. **That fallback belongs to the
  waiver and is not offered to anyone else.** A tier that must type an address
  is blocked without one even when a profile address exists, because the
  panel's blocker and the check constraint both name the typed field, and a
  Marketing page saying outreach cannot run while the sweep sends anyway is
  the worst behavior on offer. The tier is re-read on every send, so a
  downgrade that leaves a stale `postal_address_exempt` behind stops rather
  than riding the profile address. Note the legal position
  this leaves: CAN-SPAM has no Enterprise exemption, so an exempt tenant with
  no address on file is sending commercial mail without the physical address
  the law asks for, on their own compliance judgement rather than the
  platform's.
- Every pitch and every follow-up carries a working prospect-scoped
  unsubscribe link. Unsubscribing stamps BOTH the ledger row and any contact
  holding that address, so a later campaign cannot reach them either.
- Weekdays only, inside a per-tenant window in the tenant's timezone, under a
  per-tenant daily cap (12 by default) that counts follow-ups too.
- One follow-up per prospect, ever, and any reply cancels it. Opt-out
  detection reads only the text ABOVE the quoted history, because our own
  footer says "unsubscribe" and a quoted reply would otherwise suppress a warm
  lead.
- No SMS and no AI calls to prospects: scraped contacts consented to neither,
  the same line `instagramProspectTemplate` draws.
- A prospect with nothing checkable to say about them is never emailed. An
  opening built from a vague compliment is spam whatever the footer says.

### Suppression is wider than sending, on two axes

Any ledger row retires its domain from discovery forever, whatever became of
it (sent, skipped, failed). A partial unique index on `lower(email)` retires
the address too, because one address fronts several businesses (a shared
owner, or one agency running both sites). The address is only discovered at
probe time, so that claim can lose the index; the sweep treats that as a
duplicate to retire rather than an error.

### Everything that can be claimed twice, is claimed atomically

The sweep runs every 5 minutes and passes can overlap, so each of these is a
single guarded UPDATE rather than a read followed by a write:

| Claim | Guard | Why it matters |
| --- | --- | --- |
| Today's discovery | `last_discovery_at` older than today | Places queries are billable, so two passes must not both buy them |
| A first pitch | status still `drafted` | A duplicate cold email is a spam complaint |
| The one follow-up | `nudged_at` still null | The status stays `sent` either way, so status alone does not gate it |

There is also a last-mile suppression re-check immediately before the provider
call, mirroring the campaign sweep: an opt-out landing just after the claim
would otherwise still be mailed.

### Cost

Discovery runs once per business per UTC day and buys a tier-bounded number
of Places queries, stamped before they are bought:
`placesQueriesPerDayForTier` (src/lib/plans/prospecting.ts) gives Standard the
base budget of 6 and Enterprise double that, so the fleet-wide worst case is
always a small known number (today's whole fleet at full adoption is 36
queries a day). The rotation interleaves round-robin across search terms and
advances a full run per day; the honedtech version grouped by vertical and
slid one query at a time, which served a single trade for weeks and read like
a market signal. The optional Gemini tone pass is
metered per business through the shared AI-spend ledger and degrades to the
deterministic pitch on any failure. `GOOGLE_PLACES_API_KEY` must be set, or
the sweep reports "no Places API key configured" per business and does nothing
else.

**The field mask is the Places cost lever, and it is already at Enterprise.**
`places.websiteUri` and `places.nationalPhoneNumber` are Text Search
**Enterprise** fields, and a request bills at the highest tier among the fields
it asks for, so discovery has always billed Enterprise (1,000 free calls a
month, against 5,000 for Pro). Two consequences, both worth knowing before
touching `searchPlaces`:

- Every other Enterprise field is then **free**. `regularOpeningHours`,
  `rating`, and `userRatingCount` are requested for exactly that reason: the
  hours replace regex-scraping the prospect's markup (which finds nothing on
  any site rendering hours in JavaScript), and the review count orders which
  prospects get probed first.
- A field from a HIGHER tier (`places.reviews`, `places.editorialSummary`,
  anything atmosphere-shaped) moves EVERY query up a price band. Check the
  tier, in Google's Text Search field lists, before adding one.
  `tests/outreach-discover.test.ts` asserts the mask exactly, so widening it is
  a deliberate act with a failing test attached.

The legacy `Places API` is deliberately unused: Google closed it to new
customers in March 2025, it carries its own SKUs and quotas, and it returns
less than the New API. More Places surface means more of `places.googleapis.com`
(Nearby Search, when a tenant's area is a radius rather than a list of towns),
never the old endpoints.

### Reading the numbers

Drafted and sent are separate columns, drafts waiting on the owner are
labelled as waiting, and the reply rate is a share of what was SENT. This is
the honedtech lesson encoded: a status email once read "Contacted: 15" beside
an empty sent folder.

HQ is tenant zero (`scripts/oneshot/configure-hq-prospecting.ts`), in manual
mode until the drafts read like something you would have sent yourself.

## Platform blog (newcoworker.com/blog)

**Copy rule: no em dashes in blog posts** (now part of the repo-wide writing
rule above). Enforced in code (`src/lib/blog/copy.ts` `stripEmDashes` runs
on every AI composer output and on admin editor saves), plus a prompt
instruction in every composer. Use commas or periods instead.

DB-backed marketing blog: public `/blog` + `/es/blog` (category filters,
JSON-LD Article schema, RSS at `/blog/feed.xml`, sitemap inclusion, hreflang
when a post carries a Spanish translation), admin CMS at `/admin/blog`
(markdown editor with preview, featured-image upload to the public
`blog-images` bucket, AI assist: draft-from-topic / translate-to-Spanish /
generate-16:9-image via the platform Gemini key), scheduled publishing, and
subscriber email. Tables `blog_posts` / `blog_settings` / `blog_subscribers`
are RLS-on/no-policies (service-role only); core logic lives in
[src/lib/blog/](src/lib/blog/) under the coverage gate.

- **Publish pipeline** (`blog-publish-sweep` Edge fn, pg_cron every 5 min →
  `/api/internal/blog-publish-sweep`): due `scheduled` posts flip to
  `published` (guarded transition), then fan out — every active
  `blog_subscribers` row gets a locale-aware Resend email with an RFC 8058
  one-click unsubscribe (`/api/blog/unsubscribe?token=…`), and the post
  cross-posts to Instagram through the existing Marketing composer
  (`social_posts`) of the business designated in `blog_settings.
  instagram_business_id` (normally the HQ tenant; empty = off). **The
  Instagram caption is the post's excerpt** — no link appended (links aren't
  clickable in IG captions); the excerpt field in the editor is labeled
  accordingly. `instagram_publish_immediately` off (default) = the
  cross-post lands as a composer DRAFT for human review; on = it schedules
  immediately and the social-post-sweep publishes it.
- **Weekly auto post — 4-week category rotation** (`blog-weekly-digest`
  Edge fn, pg_cron Mondays 15:00 UTC → `/api/internal/blog-weekly-digest`,
  core `src/lib/blog/weekly-topics.ts`): ONE post per week, category keyed
  statelessly off the ISO week number (`week % 4`) — **PR digest**
  (`platform-updates`) → **Tutorial** (a how-to about one recently shipped
  feature, grounded in its PR material) → **Business Tips** (brand-voice
  advice; recent tips titles are fed to the prompt so topics never repeat)
  → **Feature deep-dive** (one impactful feature in depth). Idempotent per
  ISO week via the shared `digest_week` key. A topic week that is disabled
  (per-category `blog_settings` toggles), ungrounded (no feature PRs), or
  composes under **150 words** falls back to the PR digest —
  `digest_enabled` is the master off-switch, and `digest_as_draft` /
  `digest_include_image` apply to every auto post.
- **The PR digest itself** (`src/lib/blog/weekly-digest.ts`): fires only
  when MORE THAN 10 PRs merged over its window; Gemini writes a
  plain-English, under-700-word feature roundup (12-year-old reading
  level, enforced in code with one retry then a section-boundary
  truncation) scheduled for the same morning. **Skipped weeks roll
  forward**: the digest window starts at the LAST platform-updates auto
  post (capped at 28 days; first run = trailing 7 days), so features from
  thin/quiet/rotation weeks land in the next digest. **Features only, never bug
  fixes**: label PRs at review time — `blog: feature` includes, `blog: skip`
  excludes; Dependabot / docs / test / chore / bump / one-shot titles are
  dropped outright, and the unlabeled remainder is classified by Gemini
  (classifier failure conservatively drops them). Admin toggles on
  `/admin/blog`: digest on/off, create-as-draft instead of scheduling, and
  include/skip the AI featured image.
- **Env**: `GITHUB_DIGEST_REPO` (`owner/name`) + `GITHUB_DIGEST_TOKEN`
  (repo-read PAT) for the digest's PR listing; `BLOG_DIGEST_TEXT_MODEL` /
  `BLOG_DIGEST_IMAGE_MODEL` override the Gemini models (defaults
  `gemini-3.5-flash` / `gemini-3.1-flash-lite-image`); `RESEND_API_KEY`
  gates subscriber email (unset = publish still works, email skipped).

## Lead pipeline: stage tags the platform writes itself

A pipeline stage IS a contact tag: the Tasks board is a view over
`contacts.tags`, matched case-insensitively against stage names, with no
opportunities table behind it. That design assumed each tenant would author
`update_contact` steps to write those tags. Almost nobody did. The fleet's
heaviest tenant had 21 flows and exactly ONE tag-writing step, so her board
was empty while the engine knew every lead's state perfectly well, and the
Data view's SOURCE column was a dash on every row.

So the platform writes lead state itself, at four moments it was already
instrumented for (each is a sibling call beside an existing `GoalEventKind`
site, not new instrumentation):

| Moment | Where | Stage |
| --- | --- | --- |
| lead filed | `enrichCustomerProfile` (ai-flow-worker) | New Lead |
| teammate claimed | `assignContactOwnerOnClaim` | Contacted |
| customer replied | inbound SMS webhook | Engaged |
| booking landed | every `appointment_booked` goal | Booked |

**Won is never platform-written.** It is a human judgement, and the board's
own move endpoint already owns it.

The write is an ORDINARY tag write firing the ORDINARY hooks (goal events +
`tag_changed` contact events), because a stage tag automations cannot see
would be a second, invisible notion of lead state. Five things keep that from
looping or surprising a tenant, and all five matter:

1. **`sourceFlowId` loop guard.** `contact_events` already excludes the flow
   whose own step caused the write, so a flow that files a lead cannot
   retrigger itself through the "New Lead" tag it caused.
2. **Forward-only.** A contact at or past the target stage is left alone, so a
   re-filed lead is never dragged back from Booked and a repeating trigger
   (every inbound text fires `replied`) transitions exactly ONCE per contact,
   ever. This is what makes the `replied` hook safe.
3. **A hard bound** of three forward moves per contact per pipeline.
4. **Stage-must-exist.** Nothing is written unless a stage with that name
   already exists for the business. A tenant with no pipeline gets nothing and
   pays one indexed select; a tenant who renamed "Contacted" to "Working" gets
   nothing for that moment. Opting in is creating the stage.
5. **`businesses.auto_lifecycle_stages`**, default true, read FAIL-SAFE OFF
   (an unreadable toggle writes no tag). Deliberately the opposite direction
   to `needs_human_team_first`, where the safe direction is "still page
   someone": here a tag write is an irreversible side effect that can start a
   tenant's flow.

A teammate is never staged. The applier drops `type` owner/employee and any
number on the roster, failing SAFE (an unreadable roster is treated as staff),
which is also what keeps a teammate's "1" reply out of the `replied` hook.

**Where the lead came from.** `contacts.lead_source` is stamped fill-only when
a flow first files the lead, derived from that flow's name by
[source_label.ts](supabase/functions/_shared/leads/source_label.ts):
`Clever Lead - Accept` becomes `Clever`, `HomeLight Referral` becomes
`HomeLight`. Fill-only means the FIRST flow to file owns the label. The Data
view prefers a matched `lead_submissions.source` (so webhook leads keep their
exact upstream label) and falls back to this. An explicit `leadSource` field on
the `upsert_customer` step is the obvious follow-up and is deliberately not
built yet: renaming the flow already changes the label.

Pure logic in
[_shared/pipelines/stages.ts](supabase/functions/_shared/pipelines/stages.ts)
(shared by the worker and the app, under the same 100% coverage gate), the
runtime in `_shared/pipelines/lifecycle.ts`, the Next-side wrapper in
`src/lib/pipelines/lifecycle-hooks.ts`. Existing leads are backfilled per
tenant by a one-shot, which fires no hooks and edits no flows.

## Authoring a browse step: see the page, then prove the actions

A `browse_action` step aims at markup we do not control, which makes it the
step type most likely to break and, until Aug 2026, the only one the product
could not test. "Test with a contact" SIMULATES browse steps (see
`_shared/ai_flows/test_mode.ts`: it echoes the action list and never opens a
browser), so a selector's first real trial was a live lead, days later,
silently. Both halves of the fix run through the tenant's OWN aiflow-render
sidecar with the tenant's own saved login, so what the owner sees is what the
flow will see.

**Open this page** (`BrowseActionPagePicker`, `POST /api/aiflows/probe-page`).
Paste a real lead URL and get the page's actual controls: buttons by visible
text (falling back to `aria-label` for icon-only ones), dropdowns with their
real option labels, text fields (`name` first, placeholder when there is no
name), and `data-test` handles. Clicking one writes the action. This is
`debug/portal-dom-probe.ts` moved where an owner can reach it; that tool
exists because the first ReferralExchange update sequence was written blind,
the note field turned out to be `textarea[name="message"]` rather than a
placeholder, and the step timed out on action 4 in production for weeks.

**Try these actions** (`BrowseActionTryPanel`, `POST
/api/aiflows/check-actions`). Runs the step's sequence as a DRY RUN and
reports per action: `ready`, `blocked` (there but not yet clickable),
`absent`, or `missing_option` with the choices the dropdown does offer, plus
a screenshot and whatever the page reported about itself.

Three properties worth keeping:

- **Read-only structurally, not by a flag.** The sidecar routes the dry run
  to its own responder that calls `checkActions` and never `performActions`,
  and the page picker sends no `actions` array at all. Resolution mirrors
  `runAction` per kind and the actionability verdict comes from the same
  `probeLocator` the while-present loop acts on, so a check cannot disagree
  with the thing it predicts.
- **A new sidecar MODE is a new PATH, never a request flag.** The app deploys
  on merge; `vps/aiflow-render` only updates on a manual per-tenant redeploy,
  so there is always a window where the dashboard is new and a box is old. An
  old box does not reject an unknown `checkOnly` field, it IGNORES it, and its
  `if (actions)` branch performs them: the button promising to change nothing
  would click a live claim button. `POST /check-actions` returns 404 on an old
  box instead, and the app says "this business's browser service has not been
  updated yet". `debug/redeploy-aiflow-render.ts` greps the synced files for
  the responder and exits non-zero if it is missing.
- **The limit is in the UI, not hidden.** A dry run judges the page AS LOADED,
  so an action that only exists after an earlier click (a wizard page, a box
  inside a modal) reads as absent. That is stated under the results, because
  an owner not told it would "fix" a step that works. Simulating the sequence
  would mean performing it.

The whole-sequence appear budget is SHARED rather than per action. Only an
absent target waits, so 15 absent actions at `CLICK_TEXT_APPEAR_MS` each would
not fit inside the single response the tunnel caps at roughly 100s, the same
ceiling that forced `MAX_FOREACH_ITEMS` from 25 down to 6.

## AiFlow edit history and undo

Every change to an AiFlow's definition or name appends the PRIOR state to
`ai_flow_definition_versions`, so any edit can be reversed. This is a
database TRIGGER (`ai_flows_snapshot_definition`, migration
20260822182135), not an app-code helper, for the same reason the
`ai_flow_runs` revision counter is one: writers do not opt in, so a
forgetful path cannot skip it. That matters more here than there, because
`ai_flows` has many writers outside `src/lib` (dozens of `debug/` and
`scripts/oneshot/` scripts write the table straight through PostgREST).

Why it exists: `updateAiFlow` overwrites `definition` in place, and the AI
paths replace the WHOLE definition. The owner coworker's `edit_aiflow` tool
does not patch a flow, it regenerates it through a model from the current
JSON plus the instruction, so an unwanted edit is not reconstructible after
the fact and cannot be reversed by describing the opposite change (that
writes a third version). MCP's `update_flow` swallows a whole definition
object the same way. Before this, the only rollback anywhere was by hand:
one-shots stashing a `previous_definition` blob in
`applied_oneshots.details`.

An enabled-only flip does NOT create a version. It is already tracked by
`enabled_changed_at`, and snapshotting it would bury real edits under toggle
churn. Restoring likewise never changes `enabled`: an undo that silently
switched an automation back on would be a bigger surprise than the edit it
reverses.

### Attribution: a write-only carrier, cleared every time

A row-level trigger cannot see application context, so writers stamp
`ai_flows.edit_source` / `edit_actor` in the same UPDATE and the trigger
copies them onto the version row. Those two columns are **write-only**: the
trigger consumes and nulls them on every update, so they always read back
null.

Persisting them would be worse than useless. A column that kept its value
would be inherited by the next writer that forgot to stamp, so an
unattributed edit by a debug script would be recorded as coming from
whichever surface edited the flow last, and a false attribution in an audit
trail is worse than an absent one. Nothing is lost: a version row records
the source of the edit that REPLACED it, so the newest row's source is the
provenance of the definition that is live right now.

Current sources: `dashboard`, `dashboard_restore`, `ai_edit_dashboard`,
`ai_edit_sms`, `ai_edit_slack`, `ai_edit_email`, `mcp`, `mcp_restore`,
`white_glove`. An unstamped writer lands in the history with a null source,
which reads as "nobody said", never as a surface.

### Undoing

- Dashboard: a "Recent changes" panel on the flow detail page
  (`AiFlowHistory`, `GET`/`POST /api/aiflows/[id]/versions`). It lists the
  most recent versions (`FLOW_VERSION_LIST_LIMIT`, 20) with what the edit that
  replaced each one DID, in the same plain English the AI confirm handshake
  reads back, and a Restore button. The
  history shipped first and reached only the AI tools, so until this panel an
  owner who broke a flow in the builder had no visible way back, and every
  edit they made in it was a one-way door.
- Owner coworker (dashboard chat and owner-SMS): `undo_aiflow_edit`, sharing
  the `edit_aiflow` Settings toggle rather than carrying its own, the way
  `list_aiflows` shares `run_aiflow`'s. A surface allowed to rewrite a live
  automation must always be allowed to take that rewrite back.
- MCP: `list_flow_versions` (what changed, when, from which surface) and
  `restore_flow_version` (no `version_id` undoes the last edit).

The version rows hold the state BEFORE each edit and nothing about the edit
itself, so describing one means pairing a row with whatever replaced it: the
next-newer row, or the live definition for the newest row. That off-by-one
lives in `src/lib/ai-flows/version-history.ts` with tests rather than in the
component, where nothing would check it.

Restores go through `updateAiFlow` rather than writing `ai_flows` directly,
so a restore validates like any other edit and is itself snapshotted. Undo
is therefore undoable, and reverting the wrong change is not a second
unrecoverable event.

## Editing an AiFlow by AI: the confirm handshake

`edit_aiflow` is a TWO-call protocol. The first call compiles the edit, diffs
it against the live definition and STAGES it in `ai_flow_pending_edits`,
writing nothing to `ai_flows`. The second call, carrying the token the first
returned, applies the staged bytes.

The gate used to be a sentence in the tool description ("Use ONLY after the
owner explicitly confirmed the exact changes") and nothing enforced it. A
model handed a written-out multi-part spec reasonably reads it as already
confirmed, because the owner did write it all out. On the owner-SMS surface
that meant one text message could rewrite live automations in a single turn.

**The compiled definition is stored, not recompiled on confirm.** This tool
does not patch a definition, it regenerates the whole thing through a model,
so the same instruction run twice can produce two different results.
Confirming a described change and then applying a freshly generated one would
make the confirmation meaningless. The bytes the owner agreed to are the bytes
that land.

Three things are re-checked at confirm time, each refusing rather than
guessing:

- **Single use.** The claim is a compare-and-swap in the WHERE clause, so two
  confirmations arriving together cannot both apply. A replayed token says
  "already applied once", not a generic failure.
- **Still fresh.** `base_updated_at` must still match the flow's
  `updated_at`. If the flow moved in between, the owner's yes was given to a
  diff that no longer describes what is live.
- **Same automation.** A token staged against another flow is refused.

### Blast radius: what an edit is allowed to do, and where

`ai_flow_runs.current_step` is a flat index over the FLATTENED definition
(see `_shared/ai_flows/branching.ts`), so inserting a step near the top
renumbers everything after it and resumes every parked run on the wrong
instruction. `src/lib/ai-flows/edit-diff.ts` computes the first index where
the two flattened id lists disagree and compares it against the furthest
`current_step` among the flow's in-flight runs (`highestActiveRunStep`, which
reuses `CANCELABLE_RUN_STATUSES` rather than re-listing the non-terminal
states).

| Risk | What it means | Text surfaces (SMS, email) | Rich surfaces |
| --- | --- | --- | --- |
| `none` | the instruction changed nothing | refused, nothing staged | refused |
| `wording` | same steps in the same order, different field values | staged, confirm normally | staged |
| `behavioral` | a field changed on a step that acts on a page we do not control (`browse_action` / `browse_extract`), or a `when` guard changed on any step | **refused**, pointed at the dashboard | staged with the risk named |
| `structural` | steps added, removed or reordered, or the trigger changed | **refused**, pointed at the dashboard | staged with the risk named |
| `in_flight` | the divergence sits at or before a parked run's index | **refused** | staged with the risk named |

The line that draws: **by text you can change what an automation SAYS;
changing what it DOES needs the owner looking at it.** That is why appending
to the end of a flow is only `structural` and inserting at the top with runs
parked is `in_flight`: an append leaves the old id list as a prefix of the
new one, so no live index changes meaning.

`behavioral` exists because the id list is not a good enough proxy for that
line. A changed CSS selector leaves the steps in the same order with the same
ids, so it used to classify as `wording` and one text message could repoint a
claim button at a label that does not exist. That failure is invisible: the
flow keeps running, the click resolves to nothing, and the lead sits unclaimed
for days. The step's TYPE is read off both the before and after definitions,
so a step turning INTO a browse step under the same id cannot slip through as
wording. A `when` guard counts for the same reason on any step type: every
message in the flow can be untouched while what the automation does changes.

It sits BELOW `structural` deliberately. Nothing renumbers, so no parked run
resumes on the wrong instruction; the class is about what an owner can judge
from a sentence on their phone, not about blast radius through live runs.

The vocabulary is also a CHECK constraint on `ai_flow_pending_edits.risk`, and
`stagePendingEdit` writes the classifier's answer straight into it. Adding a
class to the TypeScript union without widening the column makes the refusing
half work and the allowing half fail at INSERT, which is how `behavioral`
first shipped. `tests/ai-flow-pending-edit-risk-lockstep.test.ts` reads the
vocabulary out of the migrations and pins it against the classes the real
classifier produces, in both directions.

## Two more limits on AI edits: scope, and unanswered questions

### One automation per turn

A turn can make several tool calls, so one message could otherwise rewrite
three automations before anyone read a word of it. `FLOW_CHANGES_PER_TURN` is
1: the first change goes through the normal confirm handshake and any
further one in the same turn is refused with "one automation per message".

Only calls that COMMIT count. Staging is deliberately uncapped, because
staging writes nothing and letting the model describe what it would do to a
second automation is useful. An `edit_aiflow` call counts only when it
carries a `confirmationToken`; an `undo_aiflow_edit` always counts. A refused
change does not spend the slot.

This is what makes a written-out multi-part spec ("change these six things
across the flows") land as a conversation rather than a batch: it is a
project, not a message, and the owner's confirmation stays meaningful because
they approved ONE described diff.

### An unanswered question blocks staging outright

The edit compile returns `{ definition, questions }`. `questions` is what the
model had to GUESS about: which teammate, which of two similarly named steps,
how long a wait should be, whether a change applies to one branch or all of
them.

A non-empty list refuses to stage at all. No token is issued, so the apply
call is unreachable until the owner has answered. That inverts the default
from "act unless unsure" to "cannot act until resolved".

The model still returns its best definition alongside the questions, so the
questions never become a way to avoid doing the work. A model that answers
with a bare definition instead of the envelope degrades to "no questions"
rather than failing to parse, which is also what the self-repair retry does:
its prompt is about fixing validation issues, not about intent, so the
questions from the first pass still stand.

`ai_flow_pending_edits.ambiguities` is therefore always empty by
construction. It is kept, and re-checked at confirm time, as defense in
depth: a row that somehow carries one can never be applied.
## The owner finds out anyway

An approved edit is not the same as the owner still knowing about it
tomorrow. A text thread scrolls, and the surface most likely to be used away
from a laptop is the one whose history is hardest to go back through. So an
AI-applied change leaves two traces the conversation cannot swallow:

- a `system_log` event, `aiflow_changed_by_ai`, carrying the flow, the
  action, the edit source, the actor and the diff lines,
- an owner notification whose SMS body names the one thing that reverses it
  ("undo that") and whose button lands on that automation.

`src/lib/ai-flows/change-notice.ts` owns both, and both are best effort: a
change that landed must never be reported as failed because an alert did not
send.

**Dashboard and one-shot edits are deliberately NOT announced.** The owner is
looking at the automation when they edit it in the builder, and we are
already in the loop on a white-glove change. An alert for something you just
watched yourself do is the kind of noise that teaches people to ignore
alerts. The announced sources are exactly the AI ones: `ai_edit_sms`,
`ai_edit_email`, `ai_edit_slack`, `ai_edit_dashboard`, `mcp`, `mcp_restore`.

## AiFlow team routing: claim notices (SMS + optional email)

`route_to_team` offers a lead to the roster (reply "1" to claim, "2" to pass,
"86" to release; a "1" still claims LATE, up to 24h after the offer window
lapsed, via the inbound webhook's reopen path in
`supabase/functions/_shared/ai_flows/late_claim.ts`). The owner is told the
outcome by SMS (`claimedNotifyTemplate` / `ownerFallbackTemplate`). Because a
late claim finalizes WITHOUT replaying post-route steps, a flow-authored
`send_email` after the route step can never report it, so the step also takes
an optional **`claimedNotifyEmail`** (templated address): the worker emails it
at CLAIM FINALIZATION for on-time claims, late claims (subject marks them as
superseding the earlier no-claim notice), auto-assignments, and "86" releases
(Jul 2026, PR #883). Delivery is best-effort from the tenant's AI mailbox
(logged to `email_log`, idempotency-keyed like the SMS notices; failures log
`ai_flow_claim_email_failed` and never fail the durable claim); an address
that renders undeliverable degrades to SMS-only. Available in the visual
builder ("Also email the claim outcome to"), the AI flow author, and MCP flow
CRUD; scrubbed from cross-tenant library copies. Off by default; first
enabled on Amy Laidlaw's five lead-routing flows
(`scripts/oneshot/set-amy-claim-notify-email.ts`, ledger-recorded).

### A teammate is never a lead, however the step addressed them

One rule, three gates, so a roster member is treated as staff on every channel:
the inbound SMS webhook's employee gate (PR #154), the voice bridge's staff
persona, and now **outbound AiFlow sends**. A number on the tenant's active
`ai_flow_team_members` roster (or one of the business's own derived numbers) is
an INTERNAL recipient no matter how the step names it, so the text never rides
the branded RCS agent, never parks until morning on the lead's quiet hours,
never gets lead-engagement link tracking, and is **never filed or renamed as a
customer**.

The gap this closes (the Dave Lane defect, Amy Laidlaw, Jul 25 2026): a
post-claim hand-off addressed the claimer through a templated phone var,
`to: "{{vars.claimed_agent_phone}}"`. Only `toAgentName` and an employee
`toRef` counted as internal, so the send filed a lead customer profile, and the
one guard it had checked for an EXISTING non-customer `contacts` row, which a
teammate who had never been a contact did not have. He was inserted as a NEW
CUSTOMER, and because that run's portal extraction produced no lead phone the
engine treated the recipient AS the lead, stamping the LEAD's name on the
teammate's row. Two independent layers now hold the rule:

- **The send step recognizes the recipient** (`activeRosterMemberByPhone` in
  `supabase/functions/ai-flow-worker/index.ts`): a resolved number on the
  active roster flips the send internal. A roster read error deliberately fails
  OPEN here, keeping lead-side semantics rather than pushing a genuine lead's
  overnight text out immediately.
- **The filing guard is roster-aware** (`isNonLeadNumber` → the shared
  `staffNumberCheck`, the same detection `update_contact`'s tag protection
  uses): it fails SAFE, so an unverifiable roster skips filing. It is
  deliberately NOT gated on `businesses.aiflow_protect_staff_contacts`: that
  toggle exists so a business can maintain lead-state TAGS over its own team,
  whereas filing a teammate as a customer under a stranger's name is never
  wanted. A business that genuinely wants team contact rows creates them as
  `type='employee'`, which the stored-type check already skips.

Author hand-offs with **`toAgentNameVar`** on `send_sms` / `send_whatsapp`
(the counterpart of `route_to_team`'s `agentNameVar`): the var's value is
resolved against the live roster at run time by name (exact, first name, unique
prefix) or by an E.164 that is on the roster, so
`"toAgentNameVar": "claimed_agent"` texts whoever claimed the lead and puts
`{{agent.*}}` in scope. Empty or `"none"` (nobody claimed) skips the step; an
unresolved name fails it readably rather than texting the wrong person. Being a
var NAME rather than a person's name, it survives library scrubbing untouched.

Pinned by `tests/worker-integration/staff-recipient-not-filed.itest.ts` (real
worker, real Postgres, real Telnyx hop). Rows filed before the fix are cleaned
by `scripts/oneshot/fix-staff-contact-rows.ts`, which deletes only while the
row still looks like the untouched artifact.

### Per-employee lead availability (four flags on the roster row)

Being ON the roster and TAKING LEADS IN ROTATION used to be the same bit, and
they are not the same decision. The gap (Amy Laidlaw, Jul 20 2026): routing her
HomeLight referrals to Amy AND Dave simultaneously required Amy on
`ai_flow_team_members`, because broadcast claims are matched by roster phone.
Roster membership is global, so that one change also entered the owner into the
round-robin rotation of every unpinned `route_to_team` step in the tenant.

`ai_flow_team_members` carries four independent flags, all default TRUE. They
are **two axes, not a list**: does the ENGINE choose the recipient or does the
FLOW name them, and is it one person or the group?

|  | ONE recipient | the GROUP |
|---|---|---|
| **engine chooses** | `routing_enabled` (round robin, `lead_auto_assign`, `preferContactOwner`) | `team_broadcast_enabled` (`broadcastAll`, the team-first handoff) |
| **a flow names them** | `named_routing_enabled` (`agentName` / `agentRef` / `agentNameVar`) | `named_broadcast_enabled` (an explicit `agentNames` list) |

Employees page labels, in the same order: Leads in rotation, Whole-team offers,
Leads named to them, Group offers that name them.

**Each mode reads only its own flag.** Nothing is inferred from another flag's
value, which is what lets "no rotation leads, but reachable when a flow asks
for me" exist as a setting (Amy's shape), and its opposite too. `active =
false` and time off still supersede all four, and a member skipped by whichever
flag applies falls through to the owner fallback with the existing
`ai_flow_pinned_agent_missing` / `ai_flow_no_agent_available` shape. That log
names the switch **for the mode being tried**, so a pinned member is never
reported as having "lead rotation" off when the setting that skipped them was
"leads named to them".

> `named_routing_enabled` arrived after the first three (Jul 26 2026). The
> original rule was blunter: a pin obeyed `routing_enabled`, so turning off
> rotation also made the person unreachable by name. That conflated "stop
> feeding me the rotation" with "never send me a lead". Defaulting the new flag
> to TRUE deliberately restores pins on a rotation-off member.

Enforcement is a single chokepoint: `filterRosterByAvailability`
([supabase/functions/_shared/ai_flows/engine.ts](supabase/functions/_shared/ai_flows/engine.ts))
takes an `AvailabilityMode` and is called by the only three lead-selection
sites: `resolveBroadcastAgents` (mode from whether the list is `"all"`),
`pickNextAgent` (mode from whether a pin is in play), and `contactOwnerAgent`
(always rotation, since ownership preference is the engine choosing). A
null/absent flag reads as available, so pre-migration rows and any query that
forgot the columns behave exactly as before.

**Not gated, deliberately.** Teammate hand-off SENDS (`send_sms` `toAgentName` /
`toAgentNameVar` / a templated phone that resolves to a roster row) are staff
messaging, not lead distribution, and every staff-detection read
(`staffNumberCheck`, `businessSelfNames`, `activeRosterMemberByPhone`) stays
flag-blind, or a rotation-off teammate would start being filed as a
customer again, which is the defect two sections up. **Owner notices are
untouched** by all four, on both notification pipelines. The `[AiFlow]` one
(keep-for-owner alerts and their nudges, the roster-exhausted fallback, claim
notices) resolves `business_telnyx_settings.forward_to_e164` and never reads
the roster at all. The `[Coworker]` urgent-alert one DOES read the roster
since Jul 31 2026, but only to answer a different question: an alert about
one contact goes to whoever owns that contact
([contact_owner_target.ts](supabase/functions/_shared/contact_owner_target.ts),
below), and it reads `active` plus a phone, flag-blind, for exactly the reason
this section gives. Paging the teammate who already claimed a lead is
stewardship, not distribution.

Editable on the Employees page (per member, under Edit), through the CSV
import/export (`lead_rotation`, `named_leads`, `named_group_offers`,
`whole_team_offers`), and by asking the coworker (see `manage_employee` below).
Live on Amy Laidlaw: rotation off, whole-team offers off, named leads and named
group offers on (`scripts/oneshot/set-amy-roster-availability.ts`,
ledger-recorded), which restores her pre-broadcast lead distribution while
keeping the HomeLight offer and leaving her reachable by name.
Pinned by `tests/worker-integration/roster-lead-availability.itest.ts`.

### Roster changes by asking (`manage_employee`)

Roster edits happen away from a laptop ("Sandy starts today, her cell is 602
555 0134"), so the roster is editable by the coworker: add, update (name,
number, email, hours), deactivate, reactivate, and set the three availability
flags. One core, `src/lib/employees/manage-tool.ts`, over the same db helpers
the Employees page uses, so the AI path and the page cannot drift.

Surface posture is `flag_contact_spam`'s, and this is the sharpest case for it:
**inline-only on verified owner surfaces** (dashboard chat at the
`manage_settings` bar, the owner-SMS operator turn) plus the MCP connector
(`list_employees` / `create_employee` / `update_employee`, same role bar).
It is **never seeded to the Rowboat texting coworker**, because that agent
talks to customers, and a customer must not be able to talk their way onto the
roster that receives leads (encoded in the `DASHBOARD_NAME_MAP` exemption in
`tests/agent-tool-seed-parity.test.ts`). Off on the email coworker and webchat.

The write itself is strict where guessing is expensive: a name that matches two
teammates returns both with their numbers instead of picking one, an off-roster
number never falls back to name matching, and a duplicate number names the
person who already holds it. The tool description makes the model read a new
teammate's number back digit by digit, and confirm before deactivating anyone
or turning rotation off.

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

### Direct Meta Lead Ads connection (no bridge)

Alongside the bridges, tenants can connect Facebook **directly** from
`/dashboard/integrations` (Lead sources → "Meta Lead Ads"): our platform Meta
app (`META_APP_ID` / `META_APP_SECRET`) runs Facebook Login
(`/api/integrations/meta/connect` → `/callback`, HMAC-signed state), the owner
picks a Page, and we subscribe it to `leadgen` webhooks
(`meta_connections` — RLS-on/no-policies, tokens AES-256-GCM encrypted via
`INTEGRATIONS_ENCRYPTION_KEY`; the page token is permanent so there is no
refresh flow). Deliveries land on `/api/webhooks/meta` (GET = Meta's
`hub.challenge` handshake gated by `META_WEBHOOK_VERIFY_TOKEN`; POST =
`X-Hub-Signature-256`-verified), which fetches each lead's answers via the
Graph API and enqueues the same webhook flow event the bridges send —
`source: "facebook_lead_ads"`, leadgen id as the idempotency key — so
existing flows work unchanged (`src/lib/meta/*`). Meta's App Review cleared
Aug 11, 2026 with Advanced Access for `leads_retrieval`, the `pages_*` set,
Messenger, Instagram DM, and both WhatsApp permissions, so ANY Facebook
account can connect; the bridges remain as the fallback path. The one
rejection, `instagram_content_publish`, keeps Instagram publishing
app-role-only until a resubmission with an end-to-end screencast clears
(details in `PRDs/whatsapp-meta-app-config.md`).

**The Conversions API dataset is entered by the owner, never discovered.**
The Conversion Leads feedback loop (pipeline stage → `/{dataset_id}/events`,
`src/lib/meta/capi*.ts`) needs a CRM dataset that, per Meta's platform flow,
only the ADVERTISER can create: Events Manager → Connect data sources → CRM.
The owner pastes that numeric id into the Meta card on
`/dashboard/integrations` (`PATCH /api/integrations/meta {datasetId}`), and a
reconnect that re-picks the SAME Page keeps it. We do not derive it: the
`POST /{page_id}/dataset` call we shipped in #807 is absent from Meta's public
Graph API reference and answers every caller with `(#200) App does not have
page_events permission on the Page`, identically for a page token and for a
user token holding `ads_management` + `business_management`, and
`page_events` belongs to no use case and appears nowhere in this app's
privilege list. Without a dataset the stage events simply defer, then expire
at Meta's 7-day window; nothing errors.

### When a Meta token dies, somebody gets told

A page token can stop working with nobody touching New Coworker: the owner
changes their Facebook password, loses their Page admin role, or removes the
app. Every call then fails with Meta error code **190**.

Until this shipped, nothing noticed. `META_ERROR_CODE_BAD_TOKEN` had **zero
call sites**, so leads were dropped (Meta gets a 200 and never redelivers, and
there is no dead-letter row), Messenger and Instagram replies burned three
retries each and dead-lettered, Instagram publishing stamped the raw Graph
error onto the post, and CAPI uploads burned all ten attempts per event and
then expired at Meta's 7-day window. The integrations card said "Connected"
the whole time.

`isMetaTokenDead(err)` is the classifier, and it matches **only** code 190,
never a timeout and never a 4xx in general: acting on it tells a paying
customer their integration is broken and asks them to redo their OAuth, so a
missed 190 costs one more failed call while a false one costs their trust.

`reportMetaCallFailure(businessId, err, { surface })` is what catch blocks
call. It ignores anything that is not a dead token, flags
`meta_connections.token_invalid_at`, and escalates **once** via
`dispatchUrgentNotification` (kind `meta_connection_broken`), following the
`calendar_connection_broken` pattern: marker log written BEFORE the dispatch,
because the failure mode of at-least-once here is repeatedly texting someone
that their integration is broken. Wired at five surfaces: lead fetch,
messenger send, comment reply, Instagram publish, CAPI upload.

**`token_invalid_at` is a new column, not a reuse of `is_active`.** That flag
is the OWNER'S PAUSE SWITCH: it renders as "paused" on the card, and both the
publish sweep and the CAPI drain read it as "defer, do not fail". Overloading
it would tell an owner who paused their own connection that their token died,
and make a dead token look like a deliberate pause to two sweeps. The card
reads a derived `needs_reconnect`, shows "Needs reconnect" (the same wording
and tone Zoom and Slack use for a dead grant), and outranks "Connected",
which is the whole point: the connection LOOKS complete.

A dead token is terminal in the messenger worker (`meta_token_expired`, no
retries: retrying cannot mint a credential), and a successful lead fetch
clears the flag so a reconnect heals the card without waiting.

**One thing that had to be fixed first:** `src/lib/meta/capi.ts` hand-rolls
its own fetch instead of going through `graphRequest`, so it never carried
Meta's error codes at all and the entire CAPI path was blind to 190. It now
parses them the same way.

### The two required Meta app callbacks (deauthorize, data deletion)

Meta requires every app that touches user data to answer two POSTs, and we
answered neither until now: a person removing New Coworker in Facebook
Settings left a row reading `active` with a live-looking token forever, and a
Meta-originated deletion request got a 404 and a recorded compliance failure.

Both arrive as a form-encoded **`signed_request`**, not the JSON +
`X-Hub-Signature-256` shape the main webhook uses. `src/lib/meta/signed-request.ts`
verifies it: HMAC-SHA256 over the RAW payload segment (not a re-encoding of
the decoded JSON, which would fail on any key-order difference), timing-safe
compare, and the `algorithm` field pinned so a future downgrade cannot pass.
Both routes live under `/api/webhooks/`, which `src/proxy.ts` exempts from
CSRF, and the signature is their ONLY authentication.

| Callback | Route | Register at |
| --- | --- | --- |
| Deauthorize | `POST /api/webhooks/meta/deauthorize` | App Dashboard → Facebook Login → Settings → Deauthorize callback URL |
| Data Deletion Request | `POST /api/webhooks/meta/data-deletion` | same panel → Data Deletion Request URL |

**They join on an app-scoped id, which we did not store.** The payload names
the person only by ASID, so `meta_connections.meta_user_id` now records it,
captured from `/me?fields=id,name` at connect. Existing rows backfill with
`debug/meta-backfill-user-ids.ts`: a connection drops its user token on
activation, so `/me` there answers with the Page, but `/debug_token` on the
page token reports the Page as `profile_id` and the authorizing person as
`user_id`. Rows that cannot be reached stay unmatchable until the owner
reconnects, and the script says so rather than reporting success.

**Scope is deliberately narrow, and this is the important part.** A request
DELETES the connection row: both tokens, the account name, and the Page and
Instagram identifiers go with it. Deleted rather than blanked, because a
blanked row keeps `status: "pending"` and the integrations card reads any
pending row as an in-progress Page pick, showing "Almost there" and then "No
Pages found" instead of a clean disconnected state. It does NOT touch the tenant's
contacts, leads, or conversations. Those are the business's own records about
its own customers, held on a different basis; erasing a company's CRM because
an administrator removed a Facebook app would be both wrong and
unrecoverable. Meta's requirement is to delete what Facebook gave us about
the requester, and the requester is the person who authorized the app, not
the tenant's customers. The status page says this in plain words.

Deletion additionally records a row in `meta_data_deletion_requests` and
returns Meta's documented `{ url, confirmation_code }`, pointing at
`/privacy/data-deletion/status?code=...`.

The status it records is the honesty-critical part. Matching nothing is
`no_data`, a real and complete answer. Matching N and deleting all N is
`completed`. Matching N and deleting fewer is **`failed`**, never
`completed` and never `no_data`: telling someone their data is gone, or that
we never held any, while it is still here are both lies to a person
exercising a privacy right, so that case routes them to a human.

Both routes answer **200 on every path**, including a rejected signature.
Meta retries neither and reads anything else as a broken integration; Meta's
own docs say a malformed answer can get the callback removed or the app
disabled. A forged signature severs nothing.

### Webhook fields are subscribed at TWO levels, and both are required

This is the trap that made five shipped features receive nothing, so it goes
first. Meta delivers a field only when BOTH of these are set:

| Level | Where | Script |
| --- | --- | --- |
| **App** | `POST /{app-id}/subscriptions`, per object | `debug/meta-app-subscriptions.ts` |
| **Page** | `POST /{page_id}/subscribed_apps` | `debug/meta-resubscribe-pages.ts` |

Adding a field to `META_PAGE_SUBSCRIBED_FIELDS` and re-subscribing every Page
does **nothing on its own**: the app is not asking for the field, so Meta
sends none and the new handler sits there receiving no deliveries, silently.
`feed`, `messaging_referrals`, `message_echoes`, `live_comments`, and
`message_template_status_update` were all shipped, all page-subscribed, and
all inert until the app level was set.

The `instagram` and `whatsapp_business_account` objects have **no page-level
step at all**, so for those the app level is the only subscription there is.

Both scripts are dry-run by default, idempotent, and read back after writing.
The app-level one writes the UNION of current and wanted fields, because
POSTing a field list REPLACES it and a field somebody added in the dashboard
must not be silently dropped.

**Adding a webhook field is therefore three steps:** handle it in
`src/lib/meta/webhook.ts`, add it to `WANTED` in
`debug/meta-app-subscriptions.ts` (and to `META_PAGE_SUBSCRIBED_FIELDS` if it
is a `page` field), then run both scripts with `--apply`.

### Comments on your posts: trigger, and reply back (Instagram AND Facebook)

Both surfaces land on the same `/api/webhooks/meta` callback, but they arrive
in COMPLETELY different shapes:

| | Instagram | Facebook Page |
| --- | --- | --- |
| object / field | `instagram` / `comments` | `page` / **`feed`** |
| comment id | `value.id` | `value.comment_id` |
| text | `value.text` | `value.message` |
| commenter | `value.from.username` | `value.from.name` |
| the post | `value.media.id` | `value.post_id` |
| flow source | `instagram_comment` | `facebook_comment` |
| resolved by | IG professional account id | Page id |

**The `feed` field is the whole Page firehose**, carrying posts, likes,
reactions and shares as well, so the parser filters to `item === "comment"`
AND `verb === "add"`. Without the item check a like fires a flow; without the
verb check an edit fires it a second time and a removal fires it on a comment
that no longer exists. On both surfaces the account's OWN comments are
suppressed, or our public reply arrives back as a new comment and answers
itself.

Instagram needs `instagram_manage_comments` at Advanced Access; Facebook
needs `feed` at BOTH subscription levels (see the section above). **A Page's
subscription is fixed when it connects**, so adding a field does nothing for
Pages already connected: run `debug/meta-resubscribe-pages.ts --apply` (dry
run by default), which is idempotent and is the tool for every future field
too.

The payload's top-level scalars are published as NAMED trigger keys as well
as inside `{{trigger.windowText}}`, so a step can say
`{{trigger.comment_id}}`, `{{trigger.comment_text}}`, `{{trigger.username}}`,
`{{trigger.media_id}}` (`webhookTriggerScope`, bounded at 40 keys / 500 chars
each; the reserved keys `channel` / `windowText` / `url` / `from` /
`event_id` always win, so a payload cannot rewrite what the trigger was).
This applies to every webhook source, bridges included.

The **`reply_to_comment` step** answers it, in one of two modes:

| `replyMode` | Instagram | Facebook | Limits |
| --- | --- | --- | --- |
| `public` | `POST /{comment_id}/replies` | `POST /{comment_id}/comments` | the 2,200-char comment ceiling |
| `private` | `POST /{page_id}/messages`, `recipient: {comment_id}` | identical | **ONE per comment, ever**, within 7 days (during the broadcast, for a Live) |

The private reply is the SAME call on both: the Messenger Send API on the
Page node, addressed by `recipient.comment_id`. Only the public edge differs.

**Facebook PUBLIC replies need `pages_manage_engagement`, which our app does
not hold.** They fail gracefully rather than erroring at anyone: Meta answers
with a permission code, the bridge route reports `permission_not_granted`,
and the step SKIPS with a note saying New Coworker is not approved for that
yet and that nothing is wrong with their connection. Still read from Meta's
answer rather than a hardcoded scope list, so the day App Review grants it
the same call simply starts working with no deploy.

That reading is **scoped to the Facebook public path** and nowhere else.
Meta's permission codes (10 / 200 / 299) are not App-Review-specific:
Messenger answers 10 for a send outside the allowed window, which is exactly
the private-reply case that must keep reporting Meta's own words, and the
same codes cover a tenant revoking a scope we ARE approved for. The Facebook
public reply is the one path where the cause is known, because the permission
is missing from our app for everyone. Instagram public replies and private
replies on both networks keep the ordinary `refused` detail.

**Which network is derived, never authored.** The step has no `platform`
field; the planner reads `{{trigger.from}}`, so a run started by
`facebook_comment` answers on Facebook and anything else on Instagram. An
owner cannot pick the wrong one, and a flow written for Instagram cannot
accidentally post on a Facebook Page.

The private node is the PAGE id because we are a Facebook Login app; the
`/{ig_user_id}/messages` form in Meta's docs is the Instagram Login variant
on `graph.instagram.com` and 400s here. Permissions:
`instagram_manage_comments` for both, plus `pages_messaging` for private.

Same bridge shape as `send_whatsapp`: the Deno worker cannot call Graph, so
it POSTs `/api/internal/instagram-comment-reply` with the cron bearer. That
route owns the **failure taxonomy**, which is the load-bearing part. Because
a private reply is single-use, a refusal is reported as a SKIP
(`reason: "refused"`, carrying Meta's own words into `actions_taken`) and a
retryable outcome (`send_failed`) is limited to an allowlist of transient
Meta codes plus 5xx/timeouts. A retryable allowlist, not a permanent-error
list: Meta does not enumerate the refusal codes for these paths, and erring
the other way would spam a commenter's inbox.

The "Instagram comment follow-up" starter uses `public` deliberately, gated
on the comment not being spam. Spending the single private reply on a
generic acknowledgement would burn the only message the owner has left for
the real answer.

### Messenger + Instagram DM conversation channel

A connected Page's Messenger (and linked Instagram professional account's DM)
conversations are answered automatically: `entry[].messaging[]` events arrive
on the same `/api/webhooks/meta` callback, land in
`messenger_conversations`/`messenger_messages` (Meta `mid` dedupes
redeliveries), and enqueue `messenger_jobs` reply jobs. The internal worker
(`/api/internal/messenger-worker`, kicked inline by the webhook + swept
per-minute via the `messenger-jobs-sweep` Edge cron) runs the platform Gemini
engine (`src/lib/messenger/engine.ts` — same persona vault, spend fuse, and
restricted customer tool surface as webchat, with lead capture landing on the
conversation + contacts with `last_channel='messenger'`) and replies through
the Messenger Send API with the tenant's page token. Sends are refused once
Meta's **24-hour standard messaging window** closes — nudges beyond it ride
SMS once the AI captures a phone number. A NEW conversation also fires a
first-contact webhook flow event (`source: "facebook_messenger"` /
`"instagram_dm"`, conversation id as the idempotency key). The owner's
Messenger inbox lives at `/dashboard/messenger` (with manual replies through
the same window-gated send path); its sidebar item only renders for
businesses with an active Meta connection.

### WhatsApp channel (conversations + outbound)

Tenants connect a WhatsApp Business Account via Meta's **Embedded Signup**
(`WhatsAppIntegrationCard` → `/api/integrations/whatsapp`: one-time code →
business token, WABA webhook subscribe, stock utility templates
auto-registered; stored encrypted in `whatsapp_connections`). Inbound
messages arrive on the same `/api/webhooks/meta` callback as
`object: "whatsapp_business_account"` and ride the messenger pipeline with
`platform='whatsapp'` (`page_id` holds the `phone_number_id`, `psid` the
customer's `wa_id`; wamid dedupes redeliveries) — same Gemini engine, 24h
window gate, first-contact flow trigger (`source: "whatsapp"`), and inbox
(`/dashboard/whatsapp`, threads shared with `/dashboard/messenger`; both
sidebar items are connection-gated).

Outbound is everywhere SMS is, through ONE policy helper
(`src/lib/whatsapp/deliver.ts`): free-form text when the recipient's 24h
service window is open, otherwise the pre-approved **utility template**
(`nc_owner_alert` / `nc_contact_followup` — Meta bills the tenant per
template message; templates still in review skip with an honest note).
Surfaces: the AiFlow `send_whatsapp` step (planner in
`_shared/ai_flows/steps.ts`, executor bridges to
`/api/internal/whatsapp-send` with the cron bearer), owner urgent alerts
(4th delivery channel in `notifications/dispatch.ts` + the Deno mirror,
toggle `whatsapp_urgent`; the companion `whatsapp_replaces_sms` preference
makes WhatsApp stand IN FOR the alert text rather than accompany it, which
is the answer for owners on non-NANP phones SMS cannot reach at all, and it
is honored only while WhatsApp can actually deliver — an ACTIVE connection
(not merely a row: an inactive one refuses with `connection_inactive`, and
the deliverable check fails toward false where the applicability check fails
toward true), the channel toggle on, and never for a page redirected to a
teammate's phone — recording the SMS row as `skipped: whatsapp_preferred`),
the dashboard coworker `send_whatsapp` tool
(inline + Rowboat + MCP connector), and manual inbox replies. Every
outbound send is appended to the conversation transcript so replies thread
into the inbox. Meta app config steps live in
`PRDs/whatsapp-meta-app-config.md`.

For Mexican tenants WhatsApp is not one channel among several, it is the
ONLY two-way customer messaging channel: SMS cannot leave NANP at all and
Mexican carriers strip alphanumeric senders (see "International
reachability" above). Any MX onboarding or feature work should treat the
WhatsApp connection as required, not optional.

## Voice call routing: the AI answers the call itself (`answerFirst`)

A `voice_ai_intake` step normally takes over only after every `ring_handoff`
missed. With **`answerFirst`** the order inverts: the AI answers the partner's
call immediately and the ring steps become the fallback for when it cannot run
(no voice budget, unhealthy bridge, refused DTMF). Built for a referral line
that calls within seconds of texting its alert, where **pressing the accept
digits is what claims the referral**, so a human picking up is not what wins it.

- **The accept sequence is authored, not hardcoded**: `acceptDigits`
  (`[{ digit, afterSeconds }]`, in order, so an IVR announcement can finish
  first) then `mediaStartSeconds` before the Gemini bridge attaches, so the AI
  never greets hold music while the partner dials the customer. Defaults: press
  `1` at 3s, media 2s later. The whole sequence runs inside ONE Telnyx webhook,
  so `AI_FIRST_MAX_DELAY_SECONDS` (5s) caps it, enforced at author time and
  clamped again at runtime by dropping trailing waits rather than pressing
  early. A longer announcement needs the continuation driven off a later Telnyx
  event instead of stretching that handler.
- **The AI knows what the alert said.** `briefFromSmsContaining` (e.g.
  `"HomeLight Referral"`) makes the answer path read the newest matching inbound
  text straight from `sms_inbound_jobs` and stamp it onto
  `ai_takeover.context_note`, which the bridge already injects as "What you
  ALREADY KNOW about this person". This cannot come from the flow run: the
  partner texts and then calls about four seconds later, while the ai-flow-worker
  ticks roughly once a minute, so no flow step has executed when the AI picks up.
- **`voice_brief` briefs a call ALREADY in progress.** An SMS-triggered flow
  finishes reading the partner's portal about a minute into the call; that step
  calls `voice_set_call_brief`, which **appends** to the same `context_note`
  (never overwrites, so the alert brief survives), and the bridge polls the field
  every ~15s and tells the model mid-conversation to use the details **and
  acknowledge they just arrived**, so the customer is never asked to repeat
  themselves. It plans a skip when no var contributed, so a dry extraction cannot
  dilute what the AI knows, and it is a recorded no-op when no call is live.
- **`alsoNotifyE164` / `alsoNotifyRef`** send a second copy of the post-call
  summary (the lead details to the agent working it, a copy to the owner).
- Every failure before the media attaches leaves the session `ringing` and
  transfers to step 0, so a live customer is never dropped because the AI could
  not run. Telemetry: `voice_ai_first_started` / `voice_ai_first_fallback`
  (with the failing stage).
- `resolveBridgeTarget` / `attachAiStream` live in
  [supabase/functions/_shared/voice_ai_attach.ts](supabase/functions/_shared/voice_ai_attach.ts),
  shared with the takeover path in `telnyx-voice-call-end` so the two can never
  drift. Both fail closed: no signing secret, a stale bridge heartbeat, or no
  configured origin means no attach.

Live on Amy Laidlaw's HomeLight live transfer. Enabling it for a tenant needs a
voice-bridge redeploy (`tsx debug/redeploy-voice-bridge.ts --business-id <uuid>`)
for the mid-call brief and the second summary recipient.

## Voice call routing: star-framed alerts (`options.starAlerts`)

A voice warm-handoff flow can frame every alert text it sends in a row of
asterisks, the same `****************` framing the $1M+ keep-for-owner lead
alert uses, so a live transfer is unmissable among routine notifications.
Off by default, per flow, and it changes NOTHING else: no extra sends, no
timing change, and the message bodies stay byte-identical.

Set it in the visual builder ("Frame this flow's alert texts in a row of
asterisks", shown only on voice flows), through the AI author, or via MCP.
`compileVoiceFlow` snapshots the flag onto the handoff context
(`star_alerts`) that `telnyx-voice-inbound` persists on
`voice_handoff_sessions.context` at chain start, so both senders read it off
the session row mid-call: `telnyx-voice-call-end` frames the missed/answered
warm-transfer notices (the `hl:` keys, recipient AND owner copy) and the
voice bridge frames the AI intake summary. The frame itself is
[supabase/functions/_shared/star_block.ts](supabase/functions/_shared/star_block.ts)
(idempotent, so an already-wrapped body never stacks rows), with lockstep
`STAR_ROW` copies in `scripts/oneshot/realtor-retrigger-guard.ts` and
`vps/voice-bridge/src/intake.ts` pinned by `tests/star-block.test.ts`.

Live on Amy Laidlaw's HomeLight live-transfer flow
(`scripts/oneshot/set-homelight-star-alerts.ts`, ledger-recorded): the owner
copy telling her Dave missed the transfer lands the instant before her own
phone rings, and Telnyx keeps HomeLight's caller id on the transfer leg, so
the framed text is how she recognizes the ring. Turning it on for a tenant
needs a voice-bridge redeploy (`tsx debug/redeploy-voice-bridge.ts
--business-id <uuid>`) for the intake-summary half; the warm-transfer notices
follow the edge deploy. Legacy `voice_handoff_chains` rows cannot carry the
flag and stay plain.

## Live translator mode (interpret a call after the transfer)

The AI worker has always handled a Spanish-speaking caller in Spanish (Gemini
Live is speech to speech and multilingual, and every customer-persona call
carries the bilingual `customerLanguageLine`). What it could not do was help
once a HUMAN joined: `transfer_to_owner` bridges the caller to the owner or a
teammate and the bridge then issues `streaming_stop` so the two of them talk
privately. If they do not share a language, that hand-off is exactly where the
call fails.

With **translator mode** armed, the AI stays on the bridged call and interprets
between them, in the first person, both directions.

- **The whole mechanism is one Telnyx parameter.** `stream_bidirectional_target_legs`
  defaults to `opposite`, meaning injected audio reaches only the PSTN party;
  `both` makes the AI audible to the caller AND the human. Paired with the
  `both_tracks` fork we already request (which is what lets the AI hear both
  sides), that is a three-way with no conference.
- **It must be armed at ANSWER time, not at transfer time.** Telnyx cannot
  re-point a running stream's target legs, and restarting the stream would tear
  down the Live session (transcript, reservation, and everything the caller
  already said). So every site that attaches a bridge stream reads the tenant
  column: `telnyx-voice-inbound` at answer, and `attachAiStream` in
  `telnyx-voice-call-end` for the AI-takeover and outbound-answered paths.
  `both` is inert until a second leg exists, so an armed call that never
  transfers behaves exactly like any other call.
- **It engages only when someone actually needs it.** Being armed says the
  human CAN hear us; a separate gate (`resolveInterpretDecision` in
  [vps/voice-bridge/src/translator-gate.ts](vps/voice-bridge/src/translator-gate.ts))
  answers whether anybody needs translating, and BOTH have to pass. The gate
  takes the caller's language from the contact's stored `preferred_language`,
  or from what they have actually said on this call (scored by the same
  `detectCustomerLanguage` the SMS side learns language with, mirrored into the
  bridge as a lockstep copy). No language difference, no interpreter: the AI
  detaches exactly as it did before the feature existed, and logs
  `voice_bridge_translator_mode_skipped` with its reason so a decline is as
  diagnosable as an entry.

  This was missing until 2026-08-18, and the gap is what call 5634b7f0 was:
  an armed tenant, an all-English outbound seller call, a warm transfer to a
  teammate, and an AI that stayed on the line and answered his "Hello. Hello."
  with "Hola. ¿Hola?". The cue had no languages to name (`caller_language:
  null` in the entry telemetry) so the model invented a pair, prompted by the
  one Spanish-looking thing on the call: a mis-transcribed "¿Tú?". The
  fleet-wide default-on migration had already claimed this gate existed ("the
  AI already decides to interpret only when someone actually needs it"); now it
  does.
- **The persona switch is a coordinator cue**, `translatorModeCue`
  ([vps/voice-bridge/src/system-instruction.ts](vps/voice-bridge/src/system-instruction.ts)),
  delivered through `sendRealtimeInput({ text })` like the wind-down cues. It is
  deliberately absolute: interpret each turn and do nothing else, speak in the
  first person as whoever is talking, never answer a question yourself, no tools,
  and stay silent between turns. On the transfer path it NAMES both languages,
  and its type requires them: the older shape accepted an unknown caller
  language and fell back to "say what they said in the caller's language", which
  is the wording that let the model choose for itself. A model that keeps its receptionist reflexes is
  worse than no interpreter, because the human believes they are hearing the
  caller. Tool calls are ALSO refused in code while interpreting, since Gemini
  Live cannot un-declare tools mid-session.
- **Wind-down cues are suppressed** while interpreting (a "say goodbye now" cue
  would be spoken to two humans having their own conversation), and the
  interpreted stretch is bounded by `VOICE_TRANSLATOR_MAX_MS` (default 30 min).
  That ceiling is a runaway guard, not a spend policy: when it fires the AI
  detaches quietly and the two humans keep their call. The diagnostics heartbeat
  keeps running throughout, so an interpreted call is as observable as any other.
- **Fails safe.** If the cue cannot be delivered the call falls back to today's
  detach, and an unarmed call can never enter the branch at all.

**What the owner sees afterwards.** An interpreted call keeps transcribing past
the transfer, so the call view says so instead of claiming the transcript stops
at the handover. From `voice_call_transcripts.interpreted_from_turn_index`
onward it also stops attributing inbound turns to the caller by name: Telnyx's
`both_tracks` fork carries both humans into ONE Gemini input stream (the bridge
reads `media.payload` and ignores `media.track`) and the transcription comes
back undiarized, so after the bridge a turn is genuinely either party. Labelling
it "Caller" put the teammate's words in the lead's mouth on call 5634b7f0.
Telling the two apart would need per-track diarization the platform does not
have.

**Cost, and it is deliberate: the tenant pays for what they use.** An interpreted
call meters BOTH legs (the caller leg through AI settlement, the human leg
through `voice_meter_forwarded_call`) and runs Gemini Live for the whole human
conversation instead of the first few seconds. That is accurate rather than
punitive: Telnyx bills the platform per leg and the model really is listening the
whole time. Remember voice has no overage, it hard-refuses the NEXT call once the
pool is spent, so heavy use makes the 300-second `voice-low-balance-alerts` email
load-bearing. The admin toggle and the owner's phone card both say so.

**ON by default** since `20260821006000_translator_mode_default_on.sql`;
`business_telnyx_settings.translator_mode_enabled` remains a per-tenant kill
switch on the admin business page ("Voice & SMS DID" card), and applies to the
NEXT call, not one in progress. It shipped opt-in for one reason: arming sends
`target_legs=both` on EVERY call, and the open question was whether that would
loop the AI's audio back into its own `both_tracks` fork on an ordinary
one-party call. Verified on HQ 2026-07-25 (70s armed call: 11 cleanly
alternating turns, zero assistant text transcribed as inbound, clean settlement)
so the parameter is inert until a second leg exists, and an opt-in was the wrong
shape for a capability that already only engages when someone needs it.

Translator mode is INDEPENDENT of the warm-transfer toggle. An earlier cut
coerced it off whenever transfer was off, which fought the default and silently
opted tenants out; interpreting self-gates at runtime instead (it needs a
transfer, or a staff request, to engage at all). A bridge code change still needs
a voice-bridge redeploy (`tsx debug/redeploy-voice-bridge.ts --business-id
<uuid>`); the arming half ships with the edge deploy.

### Staff can also ask for an interpreter directly

The other direction: the owner or a teammate calls their OWN business line, says
they need a translator, and then adds the customer themselves (carrier three-way
or a conference). The AI interprets for the rest of that call.

This path needs no telephony work at all, which is why it is a tool rather than a
dial-out. The AI is already audible on the staff member's own leg, and whatever
they merge in hears it through that same leg's audio, so `opposite` (the Telnyx
default) is already correct and there is no arming to get wrong. The AI dialing
the customer itself would mean building an outbound dial-and-bridge path with its
own budget gate and robodial surface, for a worse version of what a phone's merge
button already does.

- **`start_translator_mode`** ([vps/voice-bridge/src/tool-declarations.ts](vps/voice-bridge/src/tool-declarations.ts)),
  handled bridge-locally like `transfer_to_owner`. It sends the same
  `translatorModeCue` with `entry: "staff_request"`, which frames the other party
  as someone the colleague is adding, uses the language they named (while still
  following what it actually hears), and tells the AI to **wait quietly through
  the dialing and hold tones** instead of narrating them.
- **Staff only, enforced twice.** The declaration is withheld from customer
  callers (`CUSTOMER_EXCLUDED_TOOLS`, the mirror of the existing
  `STAFF_EXCLUDED_TOOLS`) and the handler refuses a non-staff requester again,
  because asking the receptionist to start interpreting silences it for the rest
  of the call. Staff identity is the v2-signed caller number
  (`resolveCallerIdentity`), never something the model decides.
- **Interpreting ENDS when they say so.** `stop_translator_mode` hands the
  session back to the normal assistant persona (`translatorModeEndCue`, tools
  restored, interpreter ceiling cancelled). This is the one carve-out to
  "interpret everything, even questions aimed at you": without it the first live
  test ended with the colleague saying "they just hung up, thanks for helping me"
  and getting it translated into Spanish for a customer who had already left.
  Only the colleague can end it, never the other party, and only from the
  staff-request path: after a warm transfer there is a customer bridged in who
  never asked to be handed back to a receptionist mid-conversation. Both tools
  are declared up front, because Gemini Live cannot add one mid-session.
- Same ceiling and the same tool refusals as the transfer path. A REPEAT
  `start_translator_mode` answers "already interpreting" rather than erroring:
  the model called it three times in 600ms on the first live test, and the
  generic tool-refusal error made it re-announce its readiness twice.
- **The Settings toggle is real, not decoration.** Owners can turn it off under
  Settings → Coworker tools ("Interpret on request"). HTTP-proxied voice tools
  are gated app-side by `agentToolDisabledResponse`, but a bridge-local tool has
  no such chokepoint, so the bridge reads the owner's `agent_tool_settings` row
  itself ([vps/voice-bridge/src/tool-settings.ts](vps/voice-bridge/src/tool-settings.ts))
  and withholds the declaration when it is off. Missing row and read error both
  resolve to the registry default, mirroring `isAgentToolEnabled`, so a DB blip
  never flips behavior mid-call. Any future bridge-local tool that claims to be
  configurable needs the same read.

> The one thing no test can prove is whether the human actually HEARS the
> interpreter, because `target_legs=both` on a transferred pair is Telnyx
> behavior, not ours. `tsx debug/verify-translator-mode.ts [businessId]`
> (read-only) checks the arming and prints what the last interpreted call left in
> telemetry; its header carries the two-handset listening runbook. If `both`
> turns out not to be honored on a bridged pair, the design moves to a Telnyx
> conference and the fail-safe above is what protects tenants in the meantime.

## Telnyx outbound call capacity (ops runbook)

Telnyx caps concurrent OUTBOUND calls at three layers, and the MINIMUM wins:

1. **Connection** (each Call Control Application's `outbound.channel_limit`).
2. **Outbound voice profile** (`concurrent_call_limit`).
3. **Account pool** (support-ticket-only: NOT readable or writable via API;
   the granted number lives in `admin_platform_settings` key
   `telnyx_capacity` and is one row update when Telnyx confirms a raise;
   env `TELNYX_ACCOUNT_CHANNEL_LIMIT` is only the fallback).

The 2026-08-16 incident: the profile said 10 while the connection sat at 2,
and the 08:30 Phoenix burst got HTTP 403 "channel limit exceeded" on the
third simultaneous dial (no leg, no CDR, no webhook). Four defenses now
stand, in order of when they act:

- **Per-tenant carrier caps**: provisioning creates a dedicated Call Control
  app + outbound voice profile per tenant (marker `[nc:<businessId>]`),
  channel limits equal to the plan's `maxConcurrentCalls`, a $25/day per
  tenant spend fuse, and the full destination whitelist. Existing tenants
  converge via `scripts/oneshot/migrate-tenants-to-dedicated-telnyx-apps.ts`
  (idempotent adopt-by-marker; re-run it after a tier change to re-sync the
  carrier caps).
- **Pre-dial gates**: `voice_check_availability` refuses flow-placed dials
  once fleet outbound reservations reach the pool minus the fleet headroom
  (both from the `telnyx_capacity` settings row), and per tenant once
  in-flight calls reach the tenant cap minus
  `business_telnyx_settings.voice_outbound_dial_headroom` (owner-editable on
  the dashboard phone card, default 3), reserving that tenant's own lines
  for warm transfers and reach_teammate rings.
- **Classified rejections**: a carrier channel-limit 403 (or the gate's
  refusal) defers the `place_ai_call` step on a short jittered backoff
  instead of burning the ladder rung, and resolves
  `carrier_capacity` only after retries exhaust. Wall-clock resumes carry up
  to 5 minutes of jitter so morning cohorts no longer stampede one second.
- **Alerting**: dial-time rejections email the platform admin (deduped
  hourly, `voice_capacity_alerts`), and the weekly `voice-capacity-monitor`
  cron (Mondays 15:00 UTC) reviews 14 days of real refusals and enforces
  the headroom invariant: the account pool must stay at least 2x the sum of
  per-tenant carrier caps (5 tenants promised 10 each = pool of 100). When
  either trips it mails a ready-to-send Telnyx raise request sized to
  restore the invariant.

Inspect it all with `tsx debug/telnyx-capacity.ts` (read-only: every app,
profile, DID binding, effective caps, and live in-flight counts). Raising
the connection or profile limits is a portal edit or an API PATCH; raising
the ACCOUNT pool means emailing support@telnyx.com from the account owner
address, then updating the `telnyx_capacity` row in
`admin_platform_settings` (the seed migration's header shows the one-line
`jsonb_set` update).

## Telnyx voice inbound (ops note)

**§6 HTTP semantics (shipped vs matrix shorthand):** The failure matrix highlights **403** for **bad webhook signature** (no processing, no answer). For many **logical** failures after verify (unknown DID, quota, bridge unhealthy, etc.), the handler deliberately returns **HTTP 200** with Telnyx **`hangup` / `speak`** (or equivalent) so Telnyx treats delivery as successful and **does not** retry the webhook as a transport failure—see Telnyx [webhook retries](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks). That is an intentional tradeoff: clearer PSTN UX and less duplicate traffic vs strict “non-2xx for every failure class.”

The `telnyx-voice-inbound` function may return **HTTP 200** with a Telnyx `hangup`/`reject` action for logical failures (missing fields, subscription/period gating) for the same reason. Hard failures after answer may still surface as **5xx**; rely on logs and telemetry for diagnosis.

## Budget enforcement (SMS / voice / AI)

System-level, per-business budget gates apply to ALL relevant traffic regardless of whether an AiFlow is involved:

- **Voice (hard refuse):** every inbound/outbound call that uses Google/Gemini voice must pass `voice_reserve_for_call` / `reserveVoiceBudget` ([supabase/functions/_shared/voice_reserve.ts](supabase/functions/_shared/voice_reserve.ts)) BEFORE the leg is established. No budget → the call/leg is not established (see the Telnyx voice inbound ops note above). Outbound AiFlow calls (`outbound_call` voice step) originate via [telnyx-voice-originate](supabase/functions/telnyx-voice-originate/index.ts): it first runs a READ-ONLY pre-dial probe (`checkVoiceBudgetAvailable` → the `voice_check_availability` RPC) so an over-budget tenant's callee is never even rung, then dials, captures the `call_control_id`, then `reserveVoiceBudget` BEFORE answer/media — the post-dial reserve is the AUTHORITATIVE gate (the probe is best-effort: an `indeterminate` result falls through to dial because the reserve hangs the leg up before answer if refused, so no minutes are billed). Outbound flows can be placed manually ("Place call") or auto-dialed on a schedule: the `ai-flow-worker` `enqueueDueOutboundCalls` sweep places the call on each due occurrence with exactly-once via the `voice_outbound_dial_log` ledger (unique `flow_id, dedupe_key`), then calls the same origination function.
- **Voice, forwarded/transferred human time (post-hoc meter, never refuses):**
  the platform's Telnyx account pays carrier time for the FULL duration of a
  tenant's call even after the AI hands it to a human, so that time is metered
  too (policy set Jul 14 2026 — before this, a 9m30s call the AI transferred
  after 13s debited exactly 60s). AI settlement still bills only the AI
  portion (`voice_try_finalize_settlement` stops at bridge media end); the
  HUMAN leg is metered at its hangup by `voice_meter_forwarded_call`
  ([`_shared/forwarded_call_meter.ts`](supabase/functions/_shared/forwarded_call_meter.ts),
  called from [telnyx-voice-call-end](supabase/functions/telnyx-voice-call-end/index.ts)):
  per-minute rounded like settlement, idempotent per leg
  (`voice_forwarded_call_meter` ledger), committed to the SAME
  `voice_billing_period_usage.committed_included_seconds` pool the reserve
  gate and the usage card read. One hook covers every forward path — the
  `wt:` transfer leg (AI `transfer_to_owner`, per-caller transfer rules,
  safe-mode forwards) and the handoff-chain A-leg when a human answered.
  Missed (unanswered) forwards bill nothing — the carrier doesn't charge
  unanswered legs. Like operational SMS, this meter counts but NEVER refuses:
  the call already happened; once the pool is spent the reserve gate and the
  safe-mode pre-check refuse the NEXT call.
- **Voice, carrier-side backstop:** the shared outbound voice profile also
  carries a Telnyx-side **$25/day fleet-wide spend limit** (raised from $10
  Aug 2026 for international forwarding). It is an account-protection fuse,
  not a tenant meter: when it trips, EVERY tenant's outbound leg fails until
  midnight UTC. If it ever trips organically, raise it deliberately rather
  than treating the failures as a code bug.
- **SMS (hard stop at the monthly cap):** every customer-facing outbound SMS atomically reserves a slot via `try_reserve_sms_outbound_slot` (row-locked monthly cap + pre-increment) before hitting Telnyx; on `monthly_sms_limit` the send is refused (the reply is suppressed and the owner gets a one-time cap alert). The same RPC applies the destination gate and per-destination text-unit multipliers (see "International reachability"), so a blocked or unknown destination refuses here too. This is parity with voice — a hard stop on the actual SMS limit, independent of how the reply text was generated. Enforced at every customer-facing send site:
  - Node: `sendTelnyxSms(..., { meterBusinessId })` — `app/api/dashboard/messages/send`, `app/api/voice/tools/sms`, `app/api/rowboat/tool-call`.
  - Edge: `sms-inbound-worker` (AI reply) and `ai-flow-worker` (`send_sms` / group SMS to the lead, and team-offer SMS) reserve via the `try_reserve_sms_outbound_slot` RPC.
- **AI chat spend (graceful degrade, NOT a hard stop):** when a business is over its AI token budget, the SMS/chat reply degrades to the local model ([supabase/functions/_shared/chat_spend_cap.ts](supabase/functions/_shared/chat_spend_cap.ts)) rather than refusing. The SMS SEND that carries that reply is still hard-gated by the SMS cap above.

**NOTHING is exempt from metering** (policy set Jul 14 2026 — the previous
"operational exemptions" list is gone). Every outbound SMS counts against the
tenant's monthly pool via the same `daily_usage.sms_sent` ledger the quota UI
reads. Traffic classes differ only in what happens AT the cap:

**Gemini spend observability** (Jul 2026): every metered Gemini call also
lands in the day-keyed `gemini_spend_events` ledger (written inside the
`owner_chat_record_spend` / `owner_chat_ai_settle` RPCs — surface, model,
tokens, cost, pricing source), powering `/admin/gemini` (daily per-tenant
breakdown, today/7d/month/90d) and a metered-vs-billed reconciliation
against the Cloud Billing BigQuery export. CI e2e + `debug/` scripts bill a
SEPARATE `internal-ci-debug` API key (AI Studio → Spend splits per key;
Google's new-user model restriction blocks a separate project while the
fleet runs Gemini 2.5 models) so engineering spend stays separable from
tenant spend. Setup + runbook: [docs/GEMINI-SPEND.md](docs/GEMINI-SPEND.md).

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

## Coworker tools — the parity contract (REQUIRED for every new tool)

A coworker "tool" must be wired into EVERY layer for the surface it belongs
to, or some tenants' workers silently lack it (the send_whatsapp /
scheduling-tools / inline-generate_image gaps of Jun–Jul 2026). The
`tests/agent-tool-seed-parity.test.ts` CI test enforces this: it EXECUTES the
Rowboat workflow seed's jq program straight out of
[vps/scripts/deploy-client.sh](vps/scripts/deploy-client.sh) (so a seed typo
or stray apostrophe fails the PR, not the next tenant provision) and pins
registry ↔ seed ↔ dispatcher ↔ voice-bridge lockstep. **When it fails on
your PR, it is telling you a layer below is missing — do not weaken the
test.** Checklist for a new tool:

1. **Registry** ([src/lib/agent-tools/registry.ts](src/lib/agent-tools/registry.ts)):
   add the tool under its surface(s) — this is the Settings → Coworker tools
   toggle and the statement of "should have".
2. **Rowboat seed** ([vps/scripts/deploy-client.sh](vps/scripts/deploy-client.sh)
   `WORKFLOW_JSON`): add the workflow-level declaration AND the name to the
   right agents' `tools` lists (bare name = texting coworker, `dashboard_`
   twin = dashboard coworker, Local twins mirror exactly). Descriptions must
   be **apostrophe-free** (the bash heredoc single-quotes the jq program) and
   use `isWebhook: $toolsAreReal`.
3. **Dispatcher** ([src/lib/agent-tools/rowboat-gates.ts](src/lib/agent-tools/rowboat-gates.ts)
   `TOOL_GATES` + a handler case in
   [src/app/api/rowboat/tool-call/route.ts](src/app/api/rowboat/tool-call/route.ts)):
   unknown names fail closed, so a seeded tool without a gate is dead.
4. **Inline dashboard path** (when the dashboard has the tool):
   [src/lib/dashboard-chat/action-tools.ts](src/lib/dashboard-chat/action-tools.ts) —
   put shared logic in `src/lib/**` cores (e.g.
   [src/lib/ai-flows/manual-run-tool.ts](src/lib/ai-flows/manual-run-tool.ts))
   so the inline and Rowboat paths cannot drift.
5. **Voice tools** ride
   [vps/voice-bridge/src/tool-declarations.ts](vps/voice-bridge/src/tool-declarations.ts)
   + `/api/voice/tools/*` adapters and ship with a voice-bridge redeploy
   (not the workflow seed).
6. **Retrofit live boxes after merge** — the seed only reaches NEW
   provisions: `tsx debug/reseed-agent-tool-parity.ts --all` (report-only
   audit), then `--all --apply` (additive, idempotent, never removes). It
   also flags boxes needing a full redeploy and stale voice bridges.

Deliberate exemptions (also encoded in the parity test): dashboard
`send_email` is fulfilled by the chat-worker email adapter, `memory_capture`
is Rowboat's `owner_append_business_memory`, the owner-only inline tools
(`update_notification_preferences`, `flag_contact_spam`,
`set_contact_reply_mode`, `manage_employee`) are declared ONLY on
owner-verified surfaces because the Rowboat paths carry no caller identity,
and the **webchat surface is a frozen 5-tool allowlist** (anonymous internet,
so never add side-effect tools there).

**The MCP-bridge gate groups are inline-only the same way.** The seven
`read_business_data` / `manage_contacts` / `manage_flows` / `manage_agents` /
`update_business_profile` / `update_business_knowledge` /
`manage_coworker_tools` toggles gate the connector tool catalog bridged into
the inline engine
([src/lib/dashboard-chat/mcp-bridge.ts](src/lib/dashboard-chat/mcp-bridge.ts)):
every bridged call runs as the authed caller's verified identity through
`requireMcpBusinessRole`, which the Rowboat fallback cannot host, so none of
them get seed twins. The bridge enforces one-tool-per-capability per surface
(duplicates of inline tools are excluded with recorded reasons) and pins
every call to the surface's active business; a unit test holds the
bridged + excluded sets as an exact disjoint cover of `allMcpTools`, so a
new MCP tool forces an explicit bridge decision.

**Owner email is a prompt BLOCK, not a declared tool**, on both inline owner
surfaces: the model emits an `EMAIL_SEND` sentinel block (taught by
`EMAIL_TOOL_ENABLED_PREAMBLE`) and the platform sends it afterwards through
the shared `fulfillOwnerEmailBlocks`
([src/lib/dashboard-chat/email-blocks.ts](src/lib/dashboard-chat/email-blocks.ts)),
which re-checks the Settings toggle per send and files the result on the
Emails page. Dashboard chat and the **owner-over-SMS operator turn** both
run it, so "schedule Liz through her assistant Beth" texted to the business
line can reach a delegate who works by email (the Jul 2026 Beth delegation:
before this, that surface could only offer to TEXT her). Because the
protocol lives in a prompt block rather than a gated declaration, the
authoritative permission check is the one inside the fulfiller: never send
from a new surface without it. Contracts pinned live in
`tests/e2e/beth-delegation.e2e.test.ts`. AiFlow STEP types (`route_to_team`, `place_ai_call`, …) are engine
features in the shared `ai-flow-worker`, not per-tenant tools — they need
none of this.

## Email organization (AiFlow `email_organize`)

Owners can file inbound mail from AiFlows: label, move to a folder, archive,
and mark read/unread. One step covers three backends:

- **Connected Gmail** (existing `gmail.modify`): labels, archive (remove
  `INBOX`), mark read/unread.
- **Connected Outlook**: Graph move / `isRead` / categories. Requires the
  Outlook Nango integration to include `Mail.ReadWrite`; owners who connected
  before that grant must reconnect under Dashboard → Integrations.
- **AI coworker mailbox** (`*@newcoworker.com`): in-app fields on `email_log`
  (`is_read`, `archived_at`, `folder`, `labels`), filtered and acted on from
  Dashboard → Emails. Soft-delete stays separate from archive.

Typical shape: `email` or `tenant_email` trigger → `classify` → `branch` →
`email_organize` on each arm. Connected-mailbox watching remains the ~1/min
poll; AI-mailbox inbound remains Cloudflare Email Routing → `/api/email/inbound`.
No Gmail watch / Graph push subscriptions.

### `importanceTemplate`: a score you may sort by and must not route on

`email_organize` can also record a **1-10 relative importance** for the message
(`importanceTemplate`, normally `"{{vars.email_importance}}"` off an earlier
`extract_text` field). It lands on `email_log.importance` and drives exactly one
thing: the **Importance** sort on Dashboard → Emails, with the score shown as a
muted `6/10` chip so a reordered list is interpretable.

**Nothing may branch on it.** Not a `when`, not a branch condition, not an
alerting or digest decision. The value comes from a language model, and models
cluster and drift on unanchored numeric scales: the same email can score 5 one
run and 7 the next. That is good enough to rank a list roughly and not good
enough to decide whether to wake an owner at 3am. Routing belongs to `classify`,
whose categories are prose a human can read, argue with, and edit when they
misfire; a threshold on a score is a category boundary you can neither read nor
edit. The rule of thumb: **scores rank, categories route.**

Practical consequences of it being display-only:

- The score is written on **every** backend, connected mailboxes included,
  because Gmail and Outlook have no such field and the value lives on our own
  `email_log` row.
- Parsing is lenient about shape and strict about range
  (`coerceEmailImportance`): the leading integer is taken and clamped to 1-10,
  so `"6"`, `" 6 "` and `"6/10"` all score 6, while `"high"` or `""` score
  nothing. Null means *never scored*, which sorts to the bottom rather than
  being read as least important.
- A missing `email_log` row downgrades to an `importance_row_not_found` detail
  instead of failing the step. Failing a real labelling action because a
  cosmetic field had nowhere to land would be the wrong trade; succeeding
  silently would be worse.
- Anchor the extract field's description (name what a 3 and an 8 look like).
  It will not make the score reproducible, but it keeps it roughly monotonic,
  which is all an ordering needs.

## Email coworker (replies in threads the assistant started)

Inbound email used to reach AI only as an AiFlow TRIGGER, so a delegate's
reply ("Liz has availability Monday at 12 PM EST, send the Zoom invite")
died in the owner's inbox. The email coworker is the conversational half,
the email sibling of the owner-over-SMS operator turn: same inline engine
(`runInlineChatTurn`), different audience.

- **Safety model, the whole design**: it answers ONLY inside a thread this
  ledger owns, and ownership is never inferred. `email_coworker_threads` gets
  a row only when the assistant itself put a message into the conversation:
  an owner surface sending through the EMAIL_SEND protocol, a cold-outreach
  pitch, or a flow's `send_email` reply that the owner APPROVED at an
  approval gate. That last case is the only one where somebody else opened
  the conversation, and it is still not a widening: a human read the draft
  and said send. Receipts, newsletters, and the owner's real correspondence
  are never candidates and there is no allowlist to curate. Deleting a row
  ends its involvement.
- **Narrow tools**: a new `email` surface in
  [the registry](src/lib/agent-tools/registry.ts) (its own Settings toggles)
  carrying calendar lifecycle plus knowledge lookup. `send_sms`,
  `flag_contact_spam`, `set_contact_reply_mode`, and the AiFlow tools are
  **hard-false** in [turn.ts](src/lib/email-coworker/turn.ts), not merely
  un-toggled: the correspondent is a third party, and a prompt-injected
  email must not be able to text anyone or reconfigure anything. It is
  exempt from the Rowboat seed parity contract by construction (inline
  engine, no Rowboat agent).
- **The third-party rule** in `EMAIL_SURFACE_BLOCK` is load-bearing: an
  assistant arranging for their principal means the PRINCIPAL is the
  attendee, so the invitation and video link reach the person actually
  attending. Booking the assistant is the failure this surface exists to
  prevent. A booking's video link is also pasted into the reply, since the
  coordinator needs something forwardable.
- **Rails** ([poll.ts](src/lib/email-coworker/poll.ts)): never answers mail
  from the mailbox's own address; **atomically claims** each message before
  its turn (a plain insert against the `email_coworker_seen` primary key, so
  two overlapping passes cannot both answer, and a crash mid-turn does not
  re-answer: an owner would rather lose a reply than send two); caps autonomous replies
  per thread per UTC day, then hands the thread to a human and alerts the
  owner once. Per-business failures are isolated.
- **Escalation is an action, not a sentence**: when the model brings in a
  colleague it must end the reply with the `NEEDS_HUMAN` sentinel, which is
  stripped before sending and is what marks the thread handed off and alerts
  the owner. Same reasoning as the EMAIL_SEND protocol: a deterministic
  marker beats classifying prose after the fact, and without it "a colleague
  will follow up" was an empty promise while the coworker kept answering.
  An owner EMAIL_SEND on the thread revives it (budget included).
- **Threading**: `sendFromMailboxConnection` takes optional thread args.
  Gmail sets `In-Reply-To`/`References` AND the `threadId` (headers alone
  let Gmail split the conversation); Graph has no raw-MIME send, so a
  threaded answer rides the message's own `/reply` action.
- **Gmail-first, honestly**: Graph's `sendMail` returns no body, so a
  Microsoft mailbox cannot report the conversation id that seeds ownership.
  Those tenants send fine and get no autonomous follow-ups yet.
- **One answer per email**: both polls read the same inbox, so the AiFlow
  email-trigger poll skips messages the coworker has already claimed
  (`email_coworker_seen`), or a tenant with a broad email-trigger flow would
  get a flow run AND an autonomous reply to one message. Best-effort
  ordering (the claim is written before the turn, and both polls run each
  tick); a lookup failure degrades to the pre-coworker behavior.
- Entry point: `/api/internal/email-coworker-poll`, kicked ~1/min by the
  ai-flow-worker tick beside the AiFlow trigger polls. Contracts pinned in
  `tests/e2e/beth-email-loop.e2e.test.ts`.

## Internationalization (i18n) — REQUIRED for every new feature

The product ships in **English and Spanish** (next-intl). Any new user-facing
surface MUST be wired for both locales — an untranslated string is a defect
the same way an untested branch is. The `tests/i18n-messages` key-parity test
fails CI if `messages/en.json` and `messages/es.json` ever diverge.

**Hard rules (zero change for existing users):**

- **English is the hard default.** Locale resolves ONLY from an explicit
  choice: saved `user_preferences.ui_locale` → `NEXT_LOCALE` cookie → `en`
  ([src/lib/i18n/resolve-locale.ts](src/lib/i18n/resolve-locale.ts)). **Never
  read `Accept-Language`** — no browser-based detection, anywhere.
- When extracting existing strings, the `en` catalog value must equal the
  string it replaces **character for character**.
- **Tenant content is never translated** (soul/memory/identity, AiFlow
  definitions, message bodies, contact names). Platform chrome only.

**Where strings live, by surface:**

- **App UI (pages/components):** keys in `messages/en.json` + `messages/es.json`,
  rendered via `getTranslations()` (server) / `useTranslations()` (client).
  Namespaces follow the tree: `marketing.*`, `auth.*`, `dashboard.*`
  (`dashboard.pages` for page titles/subtitles + shared empty states),
  `admin.*`, `common.*`. Interpolate with ICU `{var}` — pass pre-formatted
  strings for numbers that must not gain digit grouping.
- **Owner transactional emails** ([src/lib/email/templates/](src/lib/email/templates/)):
  keys under `emails.*`, resolved with `emailMessagesForLocale` + `fmtEmail`
  ([src/lib/i18n/email-copy.ts](src/lib/i18n/email-copy.ts)). Callers pass
  `locale: await resolveOwnerUiLocaleForEmail(recipientEmail)`; a new template
  MUST take an optional `locale?: AppLocale` defaulting to English. The
  `ops-*` templates (platform ops inbox) deliberately stay English.
- **Edge functions (voice IVR, SMS compliance):** `messages/edge-en.json` /
  `edge-es.json` via `edgeMessage` / `voiceMessageForLocale`; TTS language via
  `telnyxTtsLanguage`.
- **Plan/pricing copy helpers in `src/lib`** (`usage-copy.ts`, `tier-display.ts`,
  `white-glove.ts`, `password.ts`): locale-parameterized functions with an
  `"en"` default so existing callers are byte-identical. New helper copy
  follows the same pattern — and the 100% coverage gate means every `es`
  branch needs a test (see `tests/plan-copy-es.test.ts`,
  `tests/email-templates-es.test.ts`).
- **Customer-facing AI language** follows the customer, not the owner:
  detection + persistence via `contacts.preferred_language` /
  `messenger_conversations.preferred_language`
  (owner override from the contact Language dropdown is authoritative), and
  the prompt line via `customerLanguageLine`. WhatsApp out-of-window templates
  register `en_US` **and** `es_US` variants (state keyed `name` /
  `name:es_US` — see `whatsappTemplateStateKey`).
- **Legal pages (`/terms`, `/privacy`)** stay English-only by policy (the
  binding text), with a localized notice; do not machine-translate contractual
  language.

**SEO/routing:** Spanish marketing mirrors live at `/es/...` (rewritten in
[src/proxy.ts](src/proxy.ts), which also pins the `NEXT_LOCALE` cookie);
English URLs and metadata stay canonical. Metadata is translated via
`generateMetadata` + catalog keys.

## Start every session from the context pack

Almost every session on this repo used to open the same way: read this
1,700-line README, review the application code, review the last two weeks of
conversations, skim the last two weeks of pull requests. That is the same
orientation re-derived from scratch every time, paid for in tokens, arriving
at the same answer. It is generated once instead, mechanically:

```bash
npx tsx scripts/context-pack.ts    # writes docs/CONTEXT-PACK.md into every checkout, a few seconds
```

The pack carries a repo map, a line-numbered index of every section in this
README (so "read the README" becomes "open the two sections this task needs"),
the last 14 days of pull requests, the last 14 days of agent sessions with the
shared opening boilerplate stripped and the PRs each one touched, and a fleet
snapshot with every tenant's full business id, tier, DID, and flow counts.
Read it first, then open only the raw sources the task actually needs.

The output is **gitignored and generated**: never hand-edit it, and
regenerate when the header timestamp is more than a day old. It is derived
from the local agent transcript archive and live tenant rows, neither of
which belongs in git. Because it is gitignored, a fresh worktree starts
without it, and Claude Code opens every session in a fresh worktree under
`.claude/worktrees/`: the generator therefore mirrors the pack into every
checkout (main plus all linked worktrees), and the SessionStart hook
(`scripts/sync-context-pack.sh`, wired in `.claude/settings.json`) copies the
main checkout's pack into any worktree created since the last run and prints
its age into the session context. `--days N` widens the window, `--no-fleet`
skips the Supabase queries, `--out -` prints to stdout.

The session digest reads every transcript archive this repo owns: the main
checkout's Claude Code archive (`~/.claude/projects/<slug>/`), one per
worktree session (worktree slugs extend the main slug, and archives of
removed worktrees still count), and the older Cursor one
(`~/.cursor/projects/<slug>/agent-transcripts/`), so sessions from before the
switch stay visible. `CONTEXT_PACK_TRANSCRIPTS_DIR` overrides the search with
an explicit directory.

The pack orients, it does not replace reading. Go to the source when you are
changing code, when the task names a tenant (`docs/tenants/<slug>.md` first,
then the live rows), when the task depends on a contract documented here (tool
parity, KG source coverage, i18n, migration stamps), or when you need what a
past session actually decided.

**If you find yourself re-deriving something the pack should have told you,
improve [scripts/context-pack.ts](scripts/context-pack.ts)** rather than going
back to reading everything by hand. That is the same rule this repo already
applies to `debug/`, `scripts/oneshot/`, and the CI guards: once a behavior is
understood and repeatable, capture it in deterministic code. Agents should
spend tokens on discovery, not on rebuying an answer we already have.
`tests/context-pack.test.ts` pins the generator's text handling.

### Tenant dossiers (REQUIRED reading before you touch a tenant)

"Review everything about Amy / KYP / Truly" was asked more than ten times in
two weeks, and each time meant re-deriving the same picture from the chat
archive and the PR list. That picture is written down now, one file per
tenant, in [docs/tenants/](docs/tenants/README.md):
[Amy](docs/tenants/amy-laidlaw-real-estate.md),
[KYP Ads](docs/tenants/kyp-ads.md),
[Truly](docs/tenants/truly-insurance.md),
[HQ](docs/tenants/new-coworker-hq.md), and the
[HomeLight referral flow](docs/tenants/homelight-flow.md) (a lead source
inside Amy's account, intricate enough to own a file). Each carries the ids,
DID, box, roster, flow inventory, the sharp edges already discovered on that
account, and the one-shots applied to it.

**A PR that changes a tenant's flows, seeds, or one-shots must update that
tenant's dossier in the same PR.** Same contract as the KG source registry and
the coworker-tool parity list, and enforced the same way:
[tests/tenant-dossiers.test.ts](tests/tenant-dossiers.test.ts) fails when a
tenant-named script in `scripts/oneshot/` has no mention in its dossier, when a
dossier references a script that no longer exists, or when a phone number that
is not a known business DID appears in one. A dossier that lies is worse than
no dossier, because it gets trusted.

Live values (flow enable state, roster, applied one-shots) should still be read
fresh: `tsx debug/audit-account.ts --business <uuid>`. The dossier carries what
a query cannot: why the account is shaped this way, and what has already cut us.

### Solve it twice, then capture it

**When an investigation or procedure is performed a second time, the work is
not done until it exists as something deterministic**: a `debug/` tool, a
`scripts/oneshot/` script, a CI guard, a section of a dossier, or a rule. An
agent rediscovering a known answer through fresh reasoning is the most
expensive way to obtain it, and the least reliable.

This is not a new policy so much as a name for what the repo already does.
`scripts/new-migration.sh` exists because stamps were being hand-invented.
The migration stamp guard, the KG source-coverage registry, the coworker-tool
parity contract, and the no-em-dash test each pin a problem that was solved
once and must not be re-solved. `debug/` holds ~100 procedures that used to be
ad-hoc SSH sessions.

Recent captures, and what each replaced:

| Was re-derived every time | Now |
| --- | --- |
| Read the README, the transcripts, the PR list to get oriented | `npx tsx scripts/context-pack.ts` |
| "Review everything about Amy / KYP / Truly" | [docs/tenants/](docs/tenants/README.md) |
| "What is this tenant's posture, is anything broken?" | `tsx debug/audit-account.ts --business <uuid>` |
| "They say they never got the text" | `tsx debug/trace-sms.ts --to +1…` |
| "Which tenant flows would this phone-field change break?" | `tsx debug/audit-phone-field-names.ts` |

Multi-step procedures that are judgment, not code, are captured as agent
skills under [.claude/skills/](.claude/skills) (`e2e-bug-hunt`,
`dependabot-triage`, `oneshot-patch`). Those are tracked and survive a fresh
clone. The standing working agreements live alongside them in
[CLAUDE.md](CLAUDE.md), with the migration-specific pair in
[supabase/migrations/CLAUDE.md](supabase/migrations/CLAUDE.md), which loads
only when you are touching a migration.

### The same rule, applied to model spend

Tenant-facing AI should also stop paying to re-derive answers it already has.
The platform keeps the two ledgers needed to see where that happens, and
`debug/repeat-cognition.ts` reads them:

```bash
tsx debug/repeat-cognition.ts --days 30        # read-only, no model calls
```

It reports repeated `business_knowledge_lookup` questions from
`kg_retrieval_events` (normalized and grouped, with whether the answer was
identical every time) and Gemini spend per surface from `gemini_spend_daily`,
highest first. A surface with many calls and low output variance is a
candidate for **deterministic replacement, not a cheaper model**. The template
is the bare-acknowledgment suppression in PR #826, which stopped paying to
generate replies to "ok".

**Measured Jul 2026, and the reason there is no answer cache:** 30 days of
ledger showed 2 recorded knowledge lookups, zero repeated questions, and
`$0.05` of `knowledge_lookup` spend across 16 calls. A cache table with
invalidation would have been real complexity bought against nothing. Revisit
when the tool reports a stable repeat group in the tens per month, or when
`knowledge_lookup` spend becomes material; the lookup already assembles its
full context before calling the model
([src/lib/knowledge-tools/handlers.ts](src/lib/knowledge-tools/handlers.ts)),
so hashing that context is an exact invalidation key when the day comes.
Measuring first is the point of the rule, not an exception to it.

**Promotion path for white-glove work.** When a tenant-specific one-shot
proves out and the next tenant will want it, promote it rather than rewriting
it: engine behavior belongs in `src/lib/ai-flows/`, and an installable starter
belongs in [src/lib/ai-flows/templates.ts](src/lib/ai-flows/templates.ts) (the
curated, code-defined catalog, distinct from `ai_flow_library`, which is
aggregated from real tenant flows and pruned hourly). Precedents already
shipped this way: `route_to_team` broadcast offers, the booking precheck, the
bad-phone report, and per-employee lead availability all began as one
tenant's problem. The second tenant asking for something is the signal to
promote it; the third is overdue.

## All work and code modifications must follow this flow

For any changes use a worktree and never stop to ask for permission to continue always continue with your work by using this flow: Branch -> PR -> babysit CI + Bugbot to green -> merge (per PR merge policy). Then after the successful merge do the post-merge steps below, return back to main -> **clean up the worktree** (mandatory, see below).

**Label every PR for the weekly blog digest** while babysitting it:
`blog: feature` if customers should read about it in the weekly "what
shipped" post, `blog: skip` for bug fixes / internal / ops work (see
[Platform blog](#platform-blog-newcoworkercomblog) — unlabeled PRs fall back
to an AI classifier, but the label is authoritative).

### Writing a migration: always stamp it with the helper

```bash
bash scripts/new-migration.sh add_booking_reminder_window
```

Never hand-write the version. A stamp must sort after every applied
migration AND be unique against branches you cannot see, and plain
`date -u +%Y%m%d%H%M%S` currently satisfies only the second: this repo's
applied stamps run about 26 days ahead of the wall clock (the head is in
late August 2026, the clock reads late July), so a true timestamp sorts
BEHIND the head, which makes `supabase db push` refuse the order and makes a
fresh `supabase start` run the file before the migration creating the objects
it touches. That gap is exactly why stamps get hand-invented, and
hand-invented stamps broke main three times on 2026-07-26 (#932/#934,
#938/#939) and twice on 2026-07-14 (#600/#601).

The helper emits `max(real UTC, head + a small random offset)`, reading the
head from your tree AND origin/main so a branch cut before someone else's
migration merged still stamps above it. **It converges with no cleanup
event**: the head gains minutes a day while real time gains a full day, and
once the clock passes the head (around 2026-08-21) the helper starts emitting
true timestamps on its own. Do not schedule a mass re-stamp to get there
sooner; that would be ~196 `supabase migration repair` operations against the
production ledger to buy a state that arrives by itself.

A collision is caught at review time by the `Supabase Drift Check` job
([.github/scripts/migration-stamp-guard.sh](.github/scripts/migration-stamp-guard.sh),
which compares the PR against the live tip of main, the case a local
`uniq -d` cannot see: it fails duplicates AND any PR migration sorting at or
below main's migration head) and post-merge by `supabase start` in the worker
integration job. Fix one by rebasing and re-running the helper, never by
editing a file already applied to production.

The post-approval merge window (your stamp was valid when checks ran, then
another PR's migration merged first and moved the applied head, so yours
sorts below it at deploy time: PR #1066 vs #1064 on 2026-07-31) self-heals:
[.github/scripts/migration-order-heal.sh](.github/scripts/migration-order-heal.sh)
runs in the push-to-main deploy before `supabase db push`, re-stamps any
migration absent from the remote ledger that sorts at or below the applied
head, and commits the rename to main. Applied files and the ledger are never
touched; duplicates and real drift still fail the deploy loudly.

When you re-stamp, remember the helper creates an EMPTY scaffold: move the
SQL into the new file and check `wc -c` on it before deleting the old copy.
PR #1077 shipped a zero-byte migration by deleting the only copy that held
the DDL (repaired in PR #1091); `tests/migration-not-empty.test.ts` now fails
a PR carrying an empty migration file. The long form, including the one
allowlisted historical file, lives in
[supabase/migrations/CLAUDE.md](supabase/migrations/CLAUDE.md).

### The cron chain has three timeouts, and a hard ceiling under all of them

A scheduled sweep is not one timeout, it is three, and each layer can hang up
on the one below it:

| Layer | Where the number lives | Reached by |
| --- | --- | --- |
| pg_cron `timeout_milliseconds` | the `cron.schedule` body in a migration | `net.http_post` |
| Edge `REQUEST_TIMEOUT_MS` | `supabase/functions/<fn>/index.ts` | `AbortController` on the forward `fetch` |
| route `maxDuration` | `src/app/api/internal/<route>/route.ts` | Vercel |

**Underneath all three sits a platform ceiling you cannot raise: Supabase
returns 504 to the caller of an Edge function that has not responded within
150 seconds.** That is the request idle timeout and it applies on every plan
including Pro. The 400s figure in
[Supabase's limits](https://supabase.com/docs/guides/functions/limits) is the
worker's total wall clock across background tasks, not how long it may take to
answer the request that started it. Every cron bridge in this repo `await`s its
route and returns the body, so **no cron chain can run longer than 150s**, no
matter what the three numbers say.

Consequences worth knowing before you touch any of them:

- **Raising `REQUEST_TIMEOUT_MS` above 150_000 does nothing.** Most bridges sit
  at `290_000`, which is unreachable. PR #1014 raised a route to
  `maxDuration = 1800` and both layers above it to `1_800_000`; that 30-minute
  budget was never real either.
- **A route may legitimately declare more than 150s.** When the bridge 504s,
  Vercel keeps running the route to completion in the background, so the work
  still finishes. What is lost is the *result*: pg_cron records a 504 instead
  of the route's own outcome. Six routes are in this position today, recorded
  with their reasons in `KNOWN_ABOVE_EDGE_CEILING` in
  `tests/cron-timeout-parity.test.ts`: two batch workers whose webhooks also
  call them directly (on that path maxDuration genuinely governs), two
  vendor-latency sweeps sized for slow days, and the two 1800s backlog-wave
  budgets from PR #1014. Thirteen more sweeps used to sit here at 300s; the
  first full week of `cron_sweep_runs` showed their worst run was 17s, so
  they were clipped to 150 with the measured number cited at each route's
  `maxDuration`. The bar for clipping is a measured worst case with a wide
  margin over a full cycle of real load, never a quiet-day sample against a
  budget that encodes a designed-for backlog.
- **The rule pg_cron must actually satisfy** is therefore
  `timeout_milliseconds >= min(maxDuration * 1000, REQUEST_TIMEOUT_MS, 150_000)`.
  Below that, a healthy run is written into `cron.job_run_details` as a
  timeout, and a genuine timeout becomes impossible to spot.

`tests/cron-timeout-parity.test.ts` enforces this in CI. It **discovers** the
chains by parsing the migrations, the Edge functions and the routes, so a new
cron job is covered the day it lands. There is no list to remember to update:
the earlier hand-written version checked 4 of the 22 chains that existed and
had missed 14 mismatches.

A job whose Edge function calls a route **once per claimed row** (currently
`edge-ai-flow-worker`, `edge-customer-memory-summarize-sweep`,
`edge-sms-inbound-worker`) is exempt from the parity rule, because
`maxDuration` there is the budget of one call and not of the run. Those need a
wall-clock budget on the dispatch loop instead, sized so the worst case fits
inside both the cron timeout and the 150s ceiling. `CALL_SUMMARY_TIME_BUDGET_MS`
in `supabase/functions/_shared/call_summary_sweep.ts` is the worked example.
The test asserts the exempt set exactly, so a new dispatcher cannot quietly
skip the check.

**Verifying production, not just the migration.** The test and a green
push-to-main run prove the migration file is right and that it executed. They
do NOT prove the live `cron.job` rows carry the new numbers: an `unschedule`
guard that matched nothing, a job renamed out from under a migration, or a
dashboard hand-edit all leave CI green and production stale. After merging any
cron change, look at the live rows:

```bash
tsx debug/read-cron-jobs.ts
```

Read-only (the session is forced `default_transaction_read_only=on`); diffs
every live job's schedule and `timeout_milliseconds` against the migrations'
effective values, replaying `cron.schedule` AND `cron.unschedule` in apply
order, and exits 1 on any drift. First full sweep (2026-08-05, after PRs
#1159/#1162/#1164): all 38 live jobs matched, zero drift.

One deliberate live-vs-migrations divergence to know about:
`edge-residency-replay` is defined by `20260804000000_residency_write_journal.sql`
but is NOT in the live `cron.job`: `20260812000200_unschedule_residency_replay.sql`
unscheduled it while zero tenants use residency. The script replays the
unschedule and reports this as clean; a tool that only reads schedules will
wrongly call it drift.

### Every sweep records its own run, because nothing else can

pg_cron cannot tell you whether a sweep worked. `pg_net`'s `http_post` is
**asynchronous**: the cron run only enqueues the request and finishes in
milliseconds, so `cron.job_run_details` records "succeeded" whether the sweep
ran cleanly, returned a body full of errors, or timed out. That table is a
liar for every job in the fleet.

The real outcome lands in `net._http_response`, which is **retained for about
six hours**, has no job column, and can only be attributed back to a sweep by
reverse-engineering its JSON body shape (`src/lib/cron/sweep-http-stats.ts`,
read by `tsx debug/cron-http-stats.ts`). Until 2026-08-08 that was the only
record, which meant three failure modes were invisible:

1. **The sweep never ran.** No row at all, indistinguishable from a quiet
   night.
2. **It answered HTTP 200 with a non-empty `errors[]` array.** Every sweep
   body carries one and nothing looked at it, so `cron-http-stats` reported
   `0 timed out, 0 errored` while the work was failing per tenant.
3. **It timed out more than six hours ago.**

So every pass-through route now wraps its handler:

```ts
export const POST = withSweepRun("analytics-snapshot-sweep", runSweep);
```

`withSweepRun` (`src/lib/cron/sweep-run.ts`) writes one
`public.cron_sweep_runs` row per run: `sweep`, `started_at`, `finished_at`,
`duration_ms`, `ok`, `error_count`, a capped `errors` list, and the sweep's
own counts as `summary`. Rows are kept 30 days by the
`cron-sweep-runs-prune` job, long enough to watch a duration curve bend
toward the 150s ceiling before it gets there.

Four properties this depends on, none of them incidental:

- **A row is written on both paths**, success and thrown. An `ok = false` row
  means the sweep blew up; `ok = true` with `error_count > 0` is failure mode
  2 above, now a column instead of a guess.
- **A missing row is evidence, not a gap.** A sweep killed by a timeout never
  reaches the recorder, which is precisely what makes absence meaningful.
  That only holds because `recordSweepRun` never throws and never rejects: a
  bookkeeping failure must not be able to fabricate an outage, so it logs
  loudly and swallows.
- **401 and 403 are never recorded.** Those are a bad cron bearer, so
  recording them would let any unauthenticated probe manufacture sweep runs
  and paper over a genuinely missing one.
- **Each row records who invoked it**, in `source`. The cron bearer is *not*
  exclusive to pg_cron: the Meta webhook kicks
  `/api/internal/messenger-worker` fire-and-forget on every inbound message
  using the same `INTERNAL_CRON_SECRET`. Without a source, a busy Messenger
  day would keep that sweep's ledger looking alive while its per-minute cron
  job was dead, and the watchdog would never report the one sweep whose whole
  purpose is being a retry net. Every Edge bridge stamps `X-Cron-Job` with
  its own function name; anything else records as `direct`. Direct runs are
  still recorded (their failures matter) but do not count toward liveness.
  This is attribution, not authorisation: the bearer is the security
  boundary, and only our own bridges send the header.
- **Dispatchers are excluded** (`edge-ai-flow-worker`,
  `edge-customer-memory-summarize-sweep`, `edge-sms-inbound-worker`). They
  call their route once per claimed row, so wrapping them would write a row
  per unit of work rather than per sweep.

`tests/cron-sweep-run-coverage.test.ts` enforces the wiring in CI, and
**discovers** the pass-through routes from the migrations and Edge functions
the same way the timeout-parity test does, so a cron job added tomorrow is
covered the day it lands. It also asserts each route records under its own
directory name: a sweep recording under the wrong name would invent an outage
for one sweep while hiding a real one for another.

### The watchdog: what reads the ledger, and what it tells you to do

`edge-cron-sweep-watchdog` runs daily at **03:30 UTC**. That slot is chosen:
it sits after the four overnight sweeps (subscription-grace 00:15,
data-retention 01:35, document-expiration 02:05, analytics-snapshot 02:50)
and still inside the ~6h `net._http_response` retention window of the
earliest of them, which expires around 06:15.

It reads **both** records, because neither is sufficient:

| Source | Answers | Blind to |
| --- | --- | --- |
| `public.cron_sweep_runs` | did it finish, and what went wrong inside it | anything that killed the sweep before it could record |
| `net._http_response` (via the `cron_http_failures` RPC) | timeouts and transport errors at the HTTP layer | which job it belonged to (no job column) |

A sweep killed by a timeout never reaches the recorder, so its failure exists
only in the second. A sweep that answered 200 with a full `errors[]` array is
visible only in the first. The `net` schema is not exposed to PostgREST, so
`cron_http_failures(since_minutes)` is a `security definer` function with a
pinned `search_path`, returning failures only and capped at 200 rows.

Five kinds of finding, each with its own remediation line in the email,
because the useful next command differs completely by kind:

- **missing** (a sweep stopped): start with `tsx debug/read-cron-jobs.ts`,
  since an INACTIVE or unscheduled job shows there as drift.
- **failed** (it threw): the Vercel logs for that route; the row's `errors`
  carries the thrown message.
- **errors** (the silent 200): an application bug, usually per tenant. Every
  sweep here is idempotent, so the next run converges once it is fixed.
- **slow** (past 120s): warns *before* the 150s ceiling, where the bridge
  504s and the result is lost. Either shrink the batch or convert the sweep
  to a dispatcher.
- **degraded**: the watchdog could not read one of its two sources, so the
  run was half-blind. Reported as its own kind rather than folded into the
  run's `errors[]`, because the recorder reads `errors[]` as per-tenant work
  failures: an infrastructure problem parked there would come back on the
  next run misclassified as a silent 200, with per-tenant remediation for
  what is really a missing migration or grant.
- **http**: match by time against the schedules, since these rows carry no
  job.

Only **cron-sourced** rows count toward liveness (see the `source` column
above), so webhook-driven runs of `messenger-worker` cannot stand in for a
dead cron job.

**A healthy fleet sends no email.** An alert that arrives nightly stops being
read, and this one has to still mean something on the night a sweep actually
stops.

Two guards worth knowing:

- **Nothing is called missing until the ledger is older than that sweep's own
  max gap.** Otherwise every sweep looks stopped on the day this ships, and
  again after any prune that empties the table.
- **The watchdog never reports itself as missing.** It is the thing doing the
  reporting; absence is a claim only something outside it could make. Its own
  row is still written and still checked for failure and duration.

`SWEEP_EXPECTATIONS` in `src/lib/cron/sweep-watchdog.ts` holds each sweep's
max gap, with slack (roughly 3x period for the every-minute jobs, just over a
period for the daily ones) so one hiccup is not an alert.
`tests/cron-sweep-watchdog.test.ts` asserts its key set matches the
discovered fleet **exactly** in both directions: a sweep missing from it is
never watched, and a stale entry pages forever about a job that no longer
exists.

**Shipping a NEW daily or weekly sweep: merge it BEFORE its UTC slot, not
after.** The watchdog starts expecting a sweep the moment its migration
lands, but the sweep cannot record a run until its first scheduled tick. A
daily sweep merged after its slot has already passed that day therefore
produces exactly one "STOPPED: no run recorded" ACTION REQUIRED email at the
next 03:30 UTC check, self-resolving at its first real tick. This happened
twice in the watchdog's first ten days (vps-contract-upgrade-sweep, merged
16:00 UTC against a 10:30 slot; priority-support-nudge-sweep, merged 20:49
UTC against a 15:35 slot); both ran clean on their first tick. This is a
known cost, not a bug: a "no rows ever means awaiting first run" grace was
considered and rejected, because it would permanently mute a sweep whose
recording never worked, and that silence is worse than one honest email.
When the email arrives anyway, the check is one query: the sweep's row in
`cron_sweep_runs` after its first tick, or `tsx debug/read-cron-jobs.ts` to
confirm the job is live and waiting.

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
by design. A failed push-to-main run is no longer silent
(`main-failure-watch.yml`, added after the 2026-07-23 transient
Supabase-CLI failure sat unnoticed): the failed jobs are re-run once
automatically, and a second consecutive failure emails
team@newcoworker.com — production has not updated until that run is green.

**Still manual after merge (when the change calls for it):**
- VPS fleet redeploys when `vps/` changed. Per-box SSH keys never leave the
  laptop. Which script depends on WHICH subtree changed, they are not
  interchangeable: `tsx debug/update-all-vps.ts` rolls out `vps/chat-worker`
  only, `tsx debug/redeploy-aiflow-render.ts --business-id <uuid>` rebuilds a
  box's `vps/aiflow-render` sidecar (per box, and it deliberately preserves
  that box's `.env`), and voice-bridge has its own redeploy. A render change
  shipped via `update-all-vps.ts` silently does nothing.
- Seeds / one-shot scripts (`scripts/oneshot/`, ledger-recorded).
- `tsx debug/read-cron-jobs.ts` when the change touched any `cron.schedule` /
  `cron.unschedule`. The green main run proves the migration executed, not
  that the live `cron.job` rows changed; this reads them. Read-only, exit 1
  on drift. See
  [the cron chain has three timeouts](#the-cron-chain-has-three-timeouts-and-a-hard-ceiling-under-all-of-them).
- `tsx debug/aeo-crawler-probe.ts` when the change touched hostnames, the
  Cloudflare zone, DNS, or `src/lib/marketing/*`. CI can only assert what we
  intend to serve; this asserts what is actually served, and the drift it
  catches shows up as silence rather than a failure. See
  [Why the above drifted](#why-the-above-drifted-and-the-rules-that-keep-it-from-drifting-again).
- Worktree cleanup (below).

### Worktree cleanup (mandatory after merge)

Never leave a worktree behind once its PR is merged. Orphaned worktrees have
previously left `next-server` dev processes running for days, pinning ~3.5 CPU
cores and draining the laptop battery. After returning to main:

1. **Kill anything still running out of the worktree** — dev servers
   especially. Check with `ps aux | grep newCoworker-wt-` (or
   `lsof +D /Users/brianlane/newCoworker-wt-<name>`) and kill any PIDs found
   (`kill`, then `kill -9` if they don't die).
2. **Re-anchor every shell OUT of the worktree BEFORE removing it** —
   `cd /Users/brianlane/newCoworker` in the session shell (agents: run the
   next command with an explicit `working_directory` on the main checkout).
   A persistent shell left cd'd inside a deleted worktree fails every
   subsequent command — silently no-status, or `spawn /bin/bash ENOENT` —
   which presents as "Execution backend unavailable" and has repeatedly
   (Jul 17, Jul 22 2026) looked like a dead terminal backend that needed an
   editor restart. It's not the backend; it's the stale cwd.
3. **Remove the worktree** from the main repo:
   `git worktree remove /Users/brianlane/newCoworker-wt-<name>` then
   `git worktree prune`. Worktrees live at `/Users/brianlane/newCoworker-wt-*`.
4. **Delete the merged local branch**: `git branch -d <branch>`.
5. **Verify**: `git worktree list` shows only the main checkout, and
   `ps aux | grep newCoworker-wt-` finds nothing.