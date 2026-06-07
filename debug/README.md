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
| `check-ollama.ts` | Verifies Ollama is reachable from inside the worker container and the extraction model returns valid structured JSON. |
| `bump-timeout.ts` | Debug aid: overrides `MEMORY_CAPTURE_TIMEOUT_MS` on a tenant's worker `.env` and recreates the container. |
| `probe-extraction.ts` | Read-only: runs the current repo extraction prompt through a tenant's live Ollama for a set of scenarios and prints save/bullets + PASS/FAIL vs expectation. |
| `check-vault-sync.ts` | **Drift check.** Compares Supabase `memory_md` against the VPS Rowboat agent prompt (Mongo `instructions`); reports whether the latest saved bullet reached the live agent. Read-only. |
| `resync-vault.ts` | **Recovery.** Forces a vault → VPS re-seed for one tenant (`<businessId>`) or `--all`. Use when `check-vault-sync.ts` reports drift. |

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
