# New Coworker

AI Coworker platform: local-first autonomous agents for small businesses, built on Rowboat + Ollama + inworld.ai.

This repository is a full-system monorepo:

- Next.js dashboard app (owner + admin views)
- Supabase SQL migrations and edge-function scaffolding
- VPS gold-image scripts and Rowboat config templates
- Twilio + inworld.ai + Rowboat integration clients
- Compliance, monitoring, logging, and multi-period tier pricing logic

## Tier Pricing

Prices shown are for the 24-month commitment (lowest rate). All plans include a 30-day money-back guarantee.

| Tier | 24mo | 12mo | 1mo | VPS |
|------|------|------|-----|-----|
| Starter | $9.99/mo | $10.99/mo | $15.99/mo | KVM 2 (2 vCPU, 8GB) |
| Standard | $99/mo | $109/mo | $195/mo | KVM 8 (8 vCPU, 32GB) |
| Enterprise | Custom | Custom | Custom | Custom |

Renewal rates apply when the commitment period ends. See `src/lib/plans/tier.ts` for full pricing.

## Architecture

### Agent Runtime: Rowboat
Rowboat is an open-source multi-agent framework with:
- Conversational, Task, and Pipeline agent types
- Markdown knowledge vault (soul.md / identity.md / memory.md)
- Native Ollama local LLM integration
- Built-in Twilio handler for voice/SMS

### Voice: inworld.ai (all tiers)
All tiers use `inworld-tts-1.5-mini` — sub-130ms P90 latency at $5/1M chars.

### LLM Stack
- **Starter (KVM 2):** Phi-4 Mini 3.8B (Flash-Reasoning) — single model, ZRAM mandatory
- **Standard (KVM 8):** Qwen 3.5 4B/7B/35B-A3B + Llama 4 9B — full reasoning swarm

### Inference Optimizations
- **TurboQuant:** KV cache compression (~75% memory reduction). Config hooks in `vps/bifrost/config-kvm2.yaml`.
- **Dynamic VRAM + Weight Streaming:** Just-in-time NVMe weight loading. Config hooks in `vps/scripts/bootstrap.sh`.

## Rowboat + inworld.ai Voice Link

Integration approach:
1. Deploy Rowboat with custom Ollama provider pointing to `127.0.0.1:11434`.
2. Enable Rowboat's `twilio_handler` service, configured for inworld.ai WebSocket TTS.
3. Expose gateway through Cloudflare Tunnel.
4. Create inworld.ai voice agent and store `inworld_agent_id` in Supabase `business_configs`.
5. Attach Twilio phone number to the Rowboat Twilio handler.

## Security and Secrets

- This repo uses **mock** values in `.env` and `.env.example`.
- Replace values with real credentials only in secure deployment environments.

## Database Schema

6 tables in Supabase:
- `businesses` — core business record (tier, VPS ID, onboarding info)
- `business_configs` — soul_md, identity_md, memory_md, `inworld_agent_id`, `rowboat_project_id`
- `subscriptions` — Stripe billing with `billing_period`, `renewal_at`, `commitment_months`
- `daily_usage` — per-business daily usage counters for tier limit enforcement
- `coworker_logs` — agent activity logs (call/sms/data_flow/email)
- `sessions` — channel sessions with timestamps
- `notifications` — delivery tracking (sms/email/dashboard)

## Testing

Run:

```bash
npm test
```

Coverage is configured for 100% on core library modules in `src/lib`.
