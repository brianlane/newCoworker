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
