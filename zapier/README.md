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

The CLI ships as `zapier-platform-cli` (a devDependency here) and its binary
is `zapier-platform` — plain `npx zapier` does NOT work.

```bash
cd zapier
npm install
npm test                          # node --test test/
npx zapier-platform validate      # schema check (no login needed)
npx zapier-platform push          # deploy a new version (requires login + link)
```

### One-time account setup (publishing)

The integration lives under the NewCoworker Zapier developer account —
pushing uploads the app definition to Zapier's platform, so it needs that
account's credentials once per machine:

```bash
npx zapier-platform login         # browser auth; writes ~/.zapierrc
npx zapier-platform register      # FIRST TIME ONLY: creates the app + .zapierapprc
npx zapier-platform push
```

The integration is registered as **"New Coworker" (app 243681)** under the
`team@newcoworker.com` Zapier account; the committed `.zapierapprc` links
this directory to it, so a new machine only needs `login` + `push`. Until a
version is promoted and either shared by invite or published to the App
Directory, tenants cannot find "New Coworker" inside Zapier.

After a push, make the version usable:

```bash
npx zapier-platform promote 1.0.0 -y   # reads CHANGELOG.md for release notes
npx zapier-platform users:links        # per-version invite URLs for tenants
```

Note: `promote` runs Zapier's publishing checks; usage-based ones (e.g. S002
"action has no live Zaps") only clear once real Zaps use the app, so early on
share the **invite link** — invited users can build Zaps against the pushed
version without promotion. Manage everything visually at
https://developer.zapier.com (NOT the regular zapier.com/app dashboard).

`BASE_URL` defaults to `https://www.newcoworker.com`; point a version at a
preview deployment with `zapier env:set <version> BASE_URL=https://…`.

## Keeping payloads in sync

Trigger sample payloads in `triggers/index.js` MUST mirror
`supabase/functions/_shared/webhook_events.ts::buildWebhookPayload` — that
module is the single source of truth for what the dispatcher actually sends.
