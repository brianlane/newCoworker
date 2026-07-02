# `debug/` — operational & diagnostic scripts

One-shot TypeScript scripts for inspecting and operating the **live** per-tenant
VPS fleet (Rowboat + chat-worker + Ollama). They are run locally with
[`tsx`](https://github.com/privatenumber/tsx), read credentials from the
repo-root `.env`, and talk to the fleet over the Hostinger API + SSH.

> ⚠️ **These touch production.** They read the service-role Supabase key and
> plaintext VPS SSH keys from `.env`, and several of them recreate containers
> on live tenant boxes. Read what a script does before running it.

These scripts are intentionally **not** part of the app bundle and are **not**
covered by the test suite (Vitest coverage is scoped to `src/lib/**`). The
shared, reusable bits they depend on live in tested modules:
`src/lib/db/vps-ssh-keys.ts`, `src/lib/hostinger/*`.

## Prerequisites

`.env` (repo root) must contain at least:

| Var | Used for |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | look up VPS SSH keys, enqueue/inspect chat jobs |
| `HOSTINGER_API_TOKEN` | resolve each VPS's public IP (optional `HOSTINGER_API_BASE_URL`) |

Run from the repo root, e.g. `tsx debug/<script>.ts`.

## Scripts

| Script | What it does |
| --- | --- |
| `update-all-vps.ts` | **Fleet rollout.** Updates the chat-worker on **every** active VPS to the latest `origin/main`. `--concurrency=N` to fan out, `--dry-run` to list targets. Exits non-zero if any box fails. |
| `deploy-worker.ts` | Same worker update for a **single** tenant: `tsx debug/deploy-worker.ts <businessId>`. |
| `smoke-rule.ts` | End-to-end check of owner-rule memory capture: enqueues a rule, waits for the worker, then polls `memory_md` until the rule lands. Capture is silent + async (background queue after the job is `done`, no reply confirmation), so this polls past `done`. |
| `smoke-owner-chat.ts` | End-to-end owner-chat queue smoke: `tsx debug/smoke-owner-chat.ts [businessId] ["question"]`. Enqueues a real `dashboard_chat_jobs` row, waits for the worker → Rowboat (→ Gemini) → reply, and prints owner-perceived latency + the reply. |
| `probe-gemini-owner.ts` | Direct Rowboat probe for the `OwnerCoworker` agent: `tsx debug/probe-gemini-owner.ts [businessId] [model] [reps] [--revert]`. Temporarily sets the agent's model in Mongo and times the chat turn through the llm-router. `--revert` restores the local model. |
| `reseed-workflow-agent.ts` | **Repoint a workflow agent's model** on already-provisioned tenants without a full re-provision. `--agent=NAME --model=MODEL` patches the agent's `model` in the Mongo `liveWorkflow`+`draftWorkflow`; targets one tenant (`--business=ID`) or the whole fleet (default). Idempotent, keyless-safe (`gemini-*` degrades to local on a keyless box), `--dry-run`/`--concurrency=N`. See below. |
| `logs.ts` | Tails the chat-worker's recent memory-capture / job logs: `tsx debug/logs.ts [businessId] [grepPattern]`. |
| `system-logs.ts` | **Unified log tail.** Reads the `system_logs` table (the same stream the admin "System Logs" card shows): every AI-serving component's rowboat/ollama/gemini/telnyx/aiflow events. `tsx debug/system-logs.ts [businessId] [--level=error] [--min-level=warn] [--source=aiflow] [--grep=telnyx] [--since=2h] [--limit=200] [--follow] [--json]`. Read-only, Supabase only (no SSH). |
| `check-ollama.ts` | Verifies Ollama is reachable from inside the worker container and the extraction model returns valid structured JSON. |
| `bump-timeout.ts` | Debug aid: overrides `MEMORY_CAPTURE_TIMEOUT_MS` on a tenant's worker `.env` and recreates the container. |
| `probe-extraction.ts` | Read-only: runs the current repo extraction prompt through a tenant's live Ollama for a set of scenarios and prints save/bullets + PASS/FAIL vs expectation. |
| `check-vault-sync.ts` | **Drift check.** Compares Supabase `memory_md` against the VPS Rowboat agent prompt (Mongo `instructions`); reports whether the latest saved bullet reached the live agent. Read-only. |
| `resync-vault.ts` | **Recovery.** Forces a vault → VPS re-seed for one tenant (`<businessId>`) or `--all`. Use when `check-vault-sync.ts` reports drift. |
| `redeploy-aiflow-render.ts` | **Targeted aiflow-render rollout.** Refreshes `/opt/aiflow-render` (rsync + `docker compose up --build`) on every render-capable tenant VPS (or one with `--business <uuid>`) without re-running the full `deploy-client.sh` provisioner, so the box's `.env` secrets are preserved. `--ref`, `--json`. Starter boxes have no render `.env` (policy-gated off KVM2) and abort; `--init-env` (with `AIFLOW_RENDER_TOKEN` in the caller env) seeds one for capability experiments like the KVM2 render-contention test. |
| `redeploy-voice-bridge.ts` | **Targeted voice-bridge rollout.** Refreshes `/opt/voice-bridge` (rsync `vps/voice-bridge` excluding `.env` + `docker compose up --build` of only that container) on a tenant VPS (`--business-id <uuid>`, default Amy) without re-running `deploy-client.sh`, so the box's `STREAM_URL_SIGNING_SECRET`/`SUPABASE_*` stay intact. Verifies the contacts-aware bridge code landed and health-checks `:8090`. `--dry-run`. |
| `backfill-sms-customer-e164.ts` | **Data backfill.** Stamps `sms_inbound_jobs.customer_e164` from the Telnyx envelope sender for rows where it's NULL (AiFlow-suppressed / legacy Safe Mode inbounds). Those texts showed in the raw thread view but not on the contact page (which filters by the column). Idempotent — only touches NULL rows. Dry-run by default; `--apply` to write. |
| `update-amy-aiflow-screenshot-email.ts` | One-shot AiFlow definition patch for a tenant's "ReferralExchange lead" flow: browse screenshot, gated owner emails (BS/QT/BS QT subject codes), and gated MMS `route_to_team` steps. Dry-run by default; `--apply` to write. Prints the previous definition for rollback. |
| `update-amy-aiflow-text-gate.ts` | One-shot AiFlow patch: adds a `sms_lead_type` browse field ("none" when the lead page shows no TEXT contact option) and re-points the approval_gate/send_sms `when` guards at it, so un-textable leads skip the SMS-to-lead branch while emails and routing still run. Dry-run by default; `--apply` to write. |
| `seed-aiflow-team.ts` | Seed or inspect a business's `ai_flow_team_members` roster (deterministic `route_to_team` selection + rotation). `tsx debug/seed-aiflow-team.ts <businessId> "Name=+1480..." --apply`; with no member args it just lists the roster in rotation order. |
| `probe-route-rotation.ts` | Read-only probe of the legacy Rowboat `route_to_team` selection path: replays the worker's exact preamble/payload against the tenant's chat endpoint to test escalation (growing `alreadyTried`) and first-pick fairness. Useful for verifying memory grounding after an llm-router or vault-sync fix. |
| `smoke-aiflow-screenshot.ts` | **Contained smoke test** of the screenshot pipeline: render-service capture over VPS localhost, `aiflow-screenshots` bucket upload → signed-URL round-trip → delete, and ai-flow-worker liveness (401 without cron auth). Sends no SMS/MMS/email. |
| `smoke-owner-email.ts` | **End-to-end smoke** of the AiFlow owner-mailbox email path: POSTs production `/api/aiflows/send-owner-email` exactly like the ai-flow-worker (bearer gateway token, **no Origin header**), so it also catches CSRF-exemption regressions on that route. **Important** — this is the only test shaped like the real worker call; a browser-shaped curl can pass while every worker send 403s. ⚠️ Sends a real email from the owner's connected mailbox. |
| `smoke-dashboard-sms.ts` | **End-to-end smoke** of the dashboard chat `send_sms` tool: enqueues a real `dashboard_chat_jobs` row asking the coworker to text a number, waits for worker → Rowboat (→ Gemini) → Telnyx, prints the reply. **Important** — exercises the full production SMS tool-call pipeline in one shot. ⚠️ Sends a real text (spend-cap gated). |
| `roll-rowboat.ts` | **Rowboat-fork rollout** for one tenant: fetch + detached-checkout a SHA/branch in `/opt/rowboat/src`, rebuild + recreate the container, HTTP health check. **Important** — `deploy-client.sh` only builds Rowboat at first provision and the worker-rollout scripts never touch it, so this is the only way a fork fix reaches existing tenants short of a re-provision. ⚠️ Restarts the live Rowboat container. |
| `rowboat-logs.ts` | Tail a tenant's Rowboat container logs filtered by pattern (`tool\|webhook\|send_sms` by default): `tsx debug/rowboat-logs.ts [businessId] [pattern] [--since=15m] [--tail=40] [--raw]`. The Rowboat-side complement to `logs.ts`. **Important** — `--raw` dumps the last ~200KB of the window unfiltered, the go-to when you don't yet know which string to grep for (an unexplained failure whose log line matches no known keyword). Read-only. |
| `vps-exec.ts` | Run an arbitrary shell command on a tenant VPS over SSH: `tsx debug/vps-exec.ts <businessId> "<command>" [--timeout=120]`. The swiss-army knife behind ad-hoc fleet debugging (container status, env audits, fork-source inspection). ⚠️ Runs as root on a live box. |
| `provision-kvm2-smoke.ts` | **Experiment.** Buys + bootstraps a KVM2 (starter) VPS through the exact Hostinger API path production provisioning uses (public key → post-install script → `POST /api/vps/v1/virtual-machines` → poll running → Monarx → `vps_ssh_keys`), pointed at a scratch CLONE of a real business's vault (`--source`, default Amy) so starter hardware can be tested against real tenant data without touching the production box. Records teardown state in `debug/.kvm2-smoke.json`. `--adopt-vm <id>` skips the purchase and adopts an already-bought VM instead (runs Hostinger's setup endpoint with the same template/key/post-install payload — for boxes stuck in `initial` from an earlier attempt). Dry-run by default; ⚠️ `--apply` without `--adopt-vm` **charges the Hostinger account**. |
| `cancel-vps-billing.ts` | **Teardown.** Stops a VPS and cancels its Hostinger **billing subscription** (`DELETE /api/billing/v1/subscriptions/{id}`, `cancel_option=immediately`) — the same call the lifecycle/change-plan engines use to stop paying; stopping the VM alone does NOT stop charges. Targets `--state` (the KVM2 experiment box, incl. clone-row + key/script cleanup), `--vm <id>` (resolves the subscription via the billing list), or `--subscription <id>`. Dry-run by default; ⚠️ `--apply` **destroys the VM**. |
| `requeue-sms-deadletters.ts` | **Recovery.** Lists dead-lettered `sms_inbound_jobs` (age, attempts, sender, text preview, last_error) and resets them to `pending` with a fresh retry budget so the worker cron re-drains them — used after fixing an outage's root cause (e.g. the June 19 stale-gateway-token incident). Skips permanently-invalid rows unless targeted with `--error`. Filters: `--business <id>`, `--since <iso>`, `--error <substr>`. Dry-run by default; ⚠️ `--apply` makes the coworker send late replies to real customers. |
| `bench-local.ts` | **On-box local-model benchmark.** SSHes into a tenant VPS and replays reconstructed `/dashboard/chat` prompts against the box's own Ollama (native `/api/chat`, so prefill vs decode timing is split out). Defaults to the standard-tier config (`qwen3:4b-instruct`, `num_ctx=16384`); pass `--model llama3.2:3b --num-ctx 4096` to bench a starter/KVM2 box with its real tier config (model-suffixed output file so the qwen baseline isn't clobbered). Writes `.bench-results-local*.json`. Read-only. |
| `pull-cost-data.ts` | **Read-only cost/usage pull feeding the tier-economics canvas.** For one business (default Amy): the full Hostinger VPS catalog (every KVM SKU × term length), Supabase usage rollups (`daily_usage`, voice settlements, SMS both directions, Gemini spend-fuse rows, active subscription), and Telnyx invoice actuals via `/v2/detail_records` (last 90 days, per record type) so margin math uses invoice rates instead of list rates. Writes `.cost-data-<businessId>.json`. Flags: `--business <uuid>`, `--telnyx-days <n>`. Strictly read-only. |
| `bench-kvm2-local.ts` | **KVM2-profile benchmark, no VPS needed.** Replays the same reconstructed `/dashboard/chat` prompts as `bench-local.ts` (Amy's owner instructions + memory from `.bench-context.json`) against the `docker-compose.kvm2.yml` Ollama (2 CPU / 8 GB caps, `llama3.2:3b`, `num_ctx=4096` to match a real starter box). Prereq `npm run integration:up-kvm2`; `KVM2_BENCH_QUICK=1` runs just the cold+warm base cell (full matrix takes hours on laptop Docker). Writes `.bench-results-kvm2-local.json`. Read-only / local-only. |

`_shared.ts` holds the common helpers (`loadEnv`, `makeHostingerClient`,
`resolveVpsIp`) and the canonical `UPDATE_WORKER_REMOTE` shell snippet that
defines "bring a worker up to `origin/main`", shared by `deploy-worker.ts` and
`update-all-vps.ts`.

## Updating the whole fleet

```bash
# Preview which VPS instances would be updated
tsx debug/update-all-vps.ts --dry-run

# Roll the latest main out to all of them (sequentially)
tsx debug/update-all-vps.ts

# …or a few at a time once there are many tenants
tsx debug/update-all-vps.ts --concurrency=4
```

The remote sequence is idempotent (fetch+reset `origin/main`, rsync the worker
source, reconcile the managed capture-env vars, rebuild/recreate the container)
and safe to re-run.

### Capture-env self-heal

The rsync excludes `.env`, so code-only roll-outs never touched the worker's
environment — when capture moved to a direct Google call, existing boxes were
missing `GOOGLE_API_KEY` (and still carried a dead `MEMORY_CAPTURE_ROUTER_URL`),
so capture silently no-op'd until each box was hand-patched. `UPDATE_WORKER_REMOTE`
now re-derives the **managed** capture vars before recreating the container:

- `GOOGLE_API_KEY` is synced from the authoritative `/opt/rowboat/.env`.
- `MEMORY_CAPTURE_MODEL` is resolved with the same keyless fallback
  `deploy-client.sh` uses (a `gemini-*` tag degrades to the local Ollama tag on a
  keyless host).
- `MEMORY_CAPTURE_ENABLED` / `MEMORY_CAPTURE_GEMINI_BASE_URL` /
  `MEMORY_CAPTURE_TIMEOUT_MS` / `OLLAMA_BASE_URL` are ensured present (explicit
  overrides preserved).
- the dead `MEMORY_CAPTURE_ROUTER_URL` is removed.

Only those keys are touched; every other `.env` line is left as-is. A routine
`update-all-vps` is therefore enough to bring the whole fleet's capture env into
the desired state — no manual SSH.

## Repointing a workflow agent's model

`deploy-client.sh` only seeds the Rowboat workflow on first provision, so when we
change which model an agent runs on, existing tenants keep the old model until
their Mongo workflow is rewritten. `reseed-workflow-agent.ts` does that one-field
patch in place — no container churn, no `.env` rewrite, no memory reseed:

```bash
# Preview: move the SMS Coworker onto a Gemini tag across the whole fleet
tsx debug/reseed-workflow-agent.ts --agent=Coworker \
  --model=gemini-2.5-flash-lite --dry-run

# Apply to a single tenant
tsx debug/reseed-workflow-agent.ts --agent=OwnerCoworker \
  --model=gemini-2.5-flash --business=621a5b0d-...

# Roll an agent back to local Qwen across all tenants, 4 at a time
tsx debug/reseed-workflow-agent.ts --agent=Coworker \
  --model=qwen3:4b-instruct --concurrency=4
```

- **Idempotent** — a project already on the target reports `unchanged`; a project
  missing the named agent reports `missing` and is skipped (the script repoints
  an existing agent, it never creates one).
- **Keyless-safe** — a `gemini-*` target needs `GOOGLE_API_KEY` in
  `/opt/rowboat/.env` (the llm-router 503s gemini-* without one), so on a keyless
  box the target degrades to the box's `OLLAMA_MODEL` and the run warns.
- **Effect timing** — Rowboat reads the patched model for **new** conversations;
  threads already bound to the agent keep the model they were first bound to
  (Rowboat resumes the bound agent/model and ignores `startAgent` on resume).
  Clear the relevant thread table if existing conversations must re-bind.

For the bespoke "also stand up a local fallback twin" case (the PR #111 SMS
spend-cap rollout), see the historical one-off `reseed-sms-workflow.ts`.
