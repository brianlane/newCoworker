# KVM2 / KVM8 Docker integration (real Rowboat + Bifrost + Ollama)

`npm run test:integration` is **not** run in CI by default (see repo workflows); it uses [`vitest.integration.config.ts`](../../vitest.integration.config.ts) with `fileParallelism: false` so stacks do not fight over host ports (prod-like Ollama defaults to **11435** on the host).

It brings up **real** containers (not nginx stubs):

| Stack file | Tier profile | Host ports (localhost) | Services |
|------------|--------------|-------------------------|----------|
| [`real/docker-compose.kvm2.yml`](real/docker-compose.kvm2.yml) | Starter (KVM 2 limits) | Rowboat **13000**, Bifrost **18080**, Ollama **11134** | Rowboat **web** image built from [`rowboatlabs/rowboat` `apps/rowboat`](https://github.com/rowboatlabs/rowboat) at the git ref in [`real/rowboat-git-ref`](real/rowboat-git-ref) (also embedded in each compose `build.context` URL — keep them in sync when bumping), `maximhq/bifrost`, `ollama/ollama`, Mongo, Redis |
| [`real/docker-compose.kvm8.yml`](real/docker-compose.kvm8.yml) | Standard (KVM 8 limits) | Rowboat **23000**, Bifrost **28080**, Ollama **21134** | Same as kvm2 plus **`jobs-worker`** (upstream [`scripts.Dockerfile`](https://github.com/rowboatlabs/rowboat/blob/main/apps/rowboat/scripts.Dockerfile) + `npm run jobs-worker`) and **`qdrant/qdrant`** to mirror [`bootstrap.sh`](../scripts/bootstrap.sh) standard tier |
| [`real/docker-compose.kvm2-prodlike.yml`](real/docker-compose.kvm2-prodlike.yml) | Prod-like topology | Rowboat **13100**, Bifrost **18100**; Ollama published on **`127.0.0.1:${INTEGRATION_PRODLIKE_OLLAMA_HOST_PORT:-11435}`** (separate `docker run`, not in Compose) | No in-compose Ollama; Rowboat **`PROVIDER_BASE_URL`** is set in compose to **`http://host.docker.internal:<port>`** so the default **11435** avoids conflicts with a host Ollama on **11434**. Override with env **`INTEGRATION_PRODLIKE_OLLAMA_HOST_PORT`**. Covered by [`tests/integration/kvm-prodlike.test.ts`](../../tests/integration/kvm-prodlike.test.ts). |

Rowboat env keys for integration are split into tier fixtures (same shape as production `env_file` usage):

- [`real/fixtures/rowboat.env.kvm2.integration`](real/fixtures/rowboat.env.kvm2.integration)
- [`real/fixtures/rowboat.env.kvm8.integration`](real/fixtures/rowboat.env.kvm8.integration)
- [`real/fixtures/rowboat.env.kvm2-prodlike.integration`](real/fixtures/rowboat.env.kvm2-prodlike.integration)

Compose services that need it include `extra_hosts: ["host.docker.internal:host-gateway"]` (Bifrost, Rowboat, jobs-worker) so the same hostname works in Compose Ollama mode and prod-like mode.

## Test flow

The suite runs:

1. [`scripts-validation.test.ts`](../../tests/integration/scripts-validation.test.ts) — `bash -n` on [`bootstrap.sh`](../scripts/bootstrap.sh), [`deploy-client.sh`](../scripts/deploy-client.sh), [`heartbeat.sh`](../scripts/heartbeat.sh).
2. [`kvm-docker-smoke.test.ts`](../../tests/integration/kvm-docker-smoke.test.ts) — **kvm2** then **kvm8** sequentially (`down -v` between). For each stack:
   - Waits for Compose healthchecks.
   - Asserts liveness with **`curl -sf`** the same way as [`heartbeat.sh`](../scripts/heartbeat.sh): Rowboat `http://127.0.0.1:<port>/health` or `/`, Bifrost `/health`, Ollama `/api/tags` (using the **mapped** test ports, not raw 3000/8080/11434).
   - Registers the **Ollama** provider on Bifrost via [`POST /api/providers`](https://docs.getbifrost.ai/api-reference/providers/add-a-new-provider) (`base_url: http://ollama:11434` for in-network Ollama).
   - Runs `ollama pull` for the tier model — **`phi4-mini:3.8b`** (KVM2 / starter) and **`qwen3.5:9b`** (KVM8 / standard), matching [`deploy-client.sh`](../scripts/deploy-client.sh) and [`bootstrap.sh`](../scripts/bootstrap.sh).
   - Asserts **`POST /v1/chat/completions`** through Bifrost returns choices.
3. [`kvm-prodlike.test.ts`](../../tests/integration/kvm-prodlike.test.ts) — starts a dedicated Ollama container on **`127.0.0.1:11435`** (default), brings up **kvm2-prodlike** (no Compose Ollama), registers Bifrost with **`base_url: http://host.docker.internal:<same port>`**, pulls the model, and runs chat.

Failures from bad images, missing registry auth, unhealthy Rowboat, or Bifrost misconfiguration **fail the test** (no stubbed `/health`).

## Requirements

- Docker Engine with Compose v2 (`docker compose`)
- **`curl`** on the host (used for heartbeat parity checks)
- Network access to clone/build Rowboat from GitHub, and to pull `maximhq/bifrost:latest`, `ollama/ollama:latest`, `mongo:7`, `redis:7-alpine`, `qdrant/qdrant:latest`
- Enough RAM/disk for the Rowboat Docker build(s) (first run can take several minutes; kvm8 builds **two** images from `apps/rowboat`: web `Dockerfile` + jobs `scripts.Dockerfile`)
- Disk and time for Ollama model pull (default model is small; override with `INTEGRATION_OLLAMA_MODEL_*`)
- For **prod-like** test: the chosen host port (default **11435**) must be free for the helper Ollama container

## Environment

| Variable | Purpose |
|----------|---------|
| `INTEGRATION_OLLAMA_MODEL_KVM2` | Override starter stack model (default `phi4-mini:3.8b`) |
| `INTEGRATION_OLLAMA_MODEL_KVM8` | Override standard stack model (default `qwen3.5:9b`) |
| `INTEGRATION_PRODLIKE_OLLAMA_HOST_PORT` | Host port for prod-like Ollama helper (default **11435**; avoids binding **11434** when host Ollama is running) |

## Scripts (from repo root)

```bash
npm run integration:up-kvm2
npm run integration:down-kvm2
npm run integration:up-kvm8
npm run integration:down-kvm8
```

Prod-like stack (after starting your own Ollama on 11434, or use the test’s helper container pattern):

```bash
docker compose -f vps/integration/real/docker-compose.kvm2-prodlike.yml up -d --wait
docker compose -f vps/integration/real/docker-compose.kvm2-prodlike.yml down -v
```

## Automated integration test

```bash
npm run test:integration
```

Uses [`vitest.integration.config.ts`](../../vitest.integration.config.ts) only; default `npm test` excludes `tests/integration/**`.

## Production alignment

- **Bifrost:** [`maximhq/bifrost`](https://github.com/maximhq/bifrost) — see [`vps/bifrost/README.md`](../bifrost/README.md) and [`bootstrap.sh`](../scripts/bootstrap.sh). Tier routing **intent**: [`vps/bifrost/config-kvm2.yaml`](../bifrost/config-kvm2.yaml), [`vps/bifrost/config-kvm8.yaml`](../bifrost/config-kvm8.yaml). Optional **Linux** deployments sometimes run Bifrost with `network_mode: host`; integration keeps bridge networking for portability on Docker Desktop (documented here only).
- **Rowboat:** same upstream app family as [`vps/docker/docker-compose.yml`](../docker/docker-compose.yml); integration uses minimal vault under [`real/fixtures/vault/`](real/fixtures/vault/).

## Legacy nginx mock (optional)

[`kvm-mock/`](kvm-mock/image/Dockerfile) — single-container Ollama + nginx `/health` stubs only; **not** used by `npm run test:integration` anymore. Kept for lightweight manual experiments.

## More docs

- [`vps/fragments/README.md`](../fragments/README.md) — starter Ollama env, `num_ctx` Modelfile example.
