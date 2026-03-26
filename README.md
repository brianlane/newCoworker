# New Coworker (Reconstruction)

This repository has been reconstructed into a full-system monorepo:

- Next.js dashboard app (owner + admin views)
- Supabase SQL migrations and edge-function scaffolding
- VPS gold-image scripts and OpenClaw/Bifrost config templates
- Twilio + ElevenLabs + OpenClaw integration clients
- Compliance, monitoring, logging, and tier pricing logic

## Tier Pricing

- Starter: **$199/month**, $0 setup
- Standard: $299/month, $499 setup
- Enterprise: custom pricing

## ElevenLabs + OpenClaw Voice Link

Integration guidance source:
[Call Your OpenClaw over the phone using ElevenLabs Agents](https://vibecodecamp.blog/blog/call-your-openclaw-over-the-phone-using-elevenlabs-agents)

Implemented approach in this repo:

1. Enable OpenClaw `chatCompletions` endpoint in `vps/openclaw/openclaw.json`.
2. Expose gateway through secure tunnel.
3. Create ElevenLabs secret and agent pointing to `/v1/chat/completions`.
4. Attach Twilio phone number to the ElevenLabs agent.

## Security and Secrets

- This repo uses **mock** values in `.env` and `.env.example`.
- Replace values with real credentials only in secure deployment environments.

## Testing

Run:

```bash
npm test
```

Coverage is configured for 100% on core library modules in `src/lib`.
