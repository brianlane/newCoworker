# New Coworker

AI Coworker platform: local-first autonomous agents for small businesses, built on Rowboat + Ollama + inworld.ai.

This repository includes:

- Next.js dashboard app
- Supabase migrations and edge-function scaffolding
- VPS bootstrap and deployment scripts
- Rowboat, Twilio, and inworld.ai integration code
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
- Voice: inworld.ai
- Starter default model: `llama3.2:3b`
- Standard default model: `qwen3:4b-instruct`

Rowboat talks directly to Ollama’s OpenAI-compatible `/v1` API. There is no Bifrost layer in the active stack.

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
