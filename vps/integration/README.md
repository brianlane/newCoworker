# KVM2 / KVM8 Docker integration

Local integration is correctness-oriented only: real Rowboat + Ollama stacks, Mongo seeding, and multi-turn Rowboat `/api/v1/{projectId}/chat` checks.

## Stacks

| Stack file | Tier | Host ports |
|------------|------|------------|
| [`real/docker-compose.kvm2.yml`](real/docker-compose.kvm2.yml) | Starter | Rowboat `13000`, Ollama `11134` |
| [`real/docker-compose.kvm8.yml`](real/docker-compose.kvm8.yml) | Standard | Rowboat `23000`, Ollama `21134` |

Rowboat uses Ollama directly via `PROVIDER_BASE_URL=http://ollama:11434/v1`.

## What Runs

`npm run test:integration` runs:

1. `tests/integration/scripts-validation.test.ts`
2. `tests/integration/kvm-rowboat-correctness.test.ts`

The correctness test:

- brings each enabled stack up with `docker compose up -d --wait`
- checks Rowboat and Ollama health
- pulls the configured Ollama tag
- seeds Mongo with a minimal Rowboat project and API key
- restarts Rowboat and waits for HTTP readiness
- runs the SMS scenarios in `tests/integration/integration-scenarios.ts`
- writes assistant outputs to `test-results/integration-correctness-responses.json`

## Model Selection

The current chosen defaults are:

- kvm2: `llama3.2:3b`
- kvm8: `qwen3:4b-instruct`

For starter comparison runs:

```bash
npm run test:integration:correctness:kvm2-llama32-compare
```

## Environment

Common overrides:

- `INTEGRATION_OLLAMA_MODEL_KVM2`
- `INTEGRATION_OLLAMA_MODEL_KVM8`
- `INTEGRATION_KEEP_VOLUMES`
- `INTEGRATION_SKIP_KVM2`
- `INTEGRATION_SKIP_KVM8`
- `INTEGRATION_CORRECTNESS_MODEL_SEQUENCE`
- `INTEGRATION_OLLAMA_CHAT_TIMEOUT_SEC`

Copy [`env.integration.example`](env.integration.example) to `.env.integration.local` at repo root for local defaults.

## Manual Stack Control

```bash
npm run integration:up-kvm2
npm run integration:down-kvm2
npm run integration:down-kvm2:keep
npm run integration:up-kvm8
npm run integration:down-kvm8
npm run integration:down-kvm8:keep
```
