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
- Gemini Live calls typed tools exposed by the app under `/api/voice/tools/*` — `business_knowledge_lookup`, `calendar_find_slots`, `calendar_book_appointment`, `send_follow_up_email`, `send_follow_up_sms`, `capture_caller_details`. Calendar + email proxy through Nango (Google Workspace / Microsoft 365); SMS uses the metered Telnyx path; capture writes to `coworker_logs`. Authentication is a single `ROWBOAT_GATEWAY_TOKEN` shared by app, Rowboat, and bridge.
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
