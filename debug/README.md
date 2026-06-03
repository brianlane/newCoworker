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
| `smoke-rule.ts` | End-to-end check of owner-rule memory capture: enqueues a rule, waits for the worker, asserts `memory_md` grew + the reply carries the honest "Saved to your business memory" confirmation. |
| `logs.ts` | Tails the chat-worker's recent memory-capture / job logs: `tsx debug/logs.ts [businessId] [grepPattern]`. |
| `check-ollama.ts` | Verifies Ollama is reachable from inside the worker container and the extraction model returns valid structured JSON. |
| `bump-timeout.ts` | Debug aid: overrides `MEMORY_CAPTURE_TIMEOUT_MS` on a tenant's worker `.env` and recreates the container. |

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
source, rebuild/recreate the container) and safe to re-run.
