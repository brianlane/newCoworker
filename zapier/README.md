# NewCoworker Zapier app

Zapier Platform CLI project for the NewCoworker integration. It talks to the
public REST API (`/api/public/v1/*`) using per-tenant API keys minted on
`/dashboard/integrations` (Zapier & API access card).

## Surface

| Kind    | Key              | What it does                                            |
| ------- | ---------------- | ------------------------------------------------------- |
| Trigger | `sms_inbound`    | REST hook — customer texted the coworker's number       |
| Trigger | `sms_outbound`   | REST hook — coworker/owner sent a text                  |
| Trigger | `call_completed` | REST hook — a handled call ended (summary + sentiment)  |
| Trigger | `email_inbound`  | REST hook — AI mailbox received an email                |
| Action  | `send_sms`       | Send an SMS from the tenant's number (metered, logged)  |
| Action  | `send_lead`      | Send a lead/event that starts webhook-triggered AiFlows (e.g. Meta Lead Ads → coworker) |

Triggers are REST hooks: on Zap enable, Zapier POSTs
`/api/public/v1/hooks { event, target_url }`; the `webhook-dispatcher`
Supabase Edge cron then POSTs one payload per event to the Zapier hook URL.
On Zap disable Zapier DELETEs `/api/public/v1/hooks/:id`. Sample rows for the
Zap editor come from `GET /api/public/v1/events?event=…`.

## Development

```bash
cd zapier
npm install
npm test                # node --test test/
npx zapier validate     # schema check (requires zapier login)
npx zapier push         # deploy a new version
```

`BASE_URL` defaults to `https://www.newcoworker.com`; point a version at a
preview deployment with `zapier env:set <version> BASE_URL=https://…`.

## Keeping payloads in sync

Trigger sample payloads in `triggers/index.js` MUST mirror
`supabase/functions/_shared/webhook_events.ts::buildWebhookPayload` — that
module is the single source of truth for what the dispatcher actually sends.
