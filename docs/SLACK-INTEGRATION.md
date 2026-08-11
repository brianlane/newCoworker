# Slack integration: app setup and operations

The Slack integration is first-party: our own Slack app ("New Coworker"),
installed per tenant workspace through OAuth v2 from
/dashboard/integrations/slack. This doc carries the app manifest, the
App Manifest API commands that create and evolve the app programmatically,
the env contract, and the rollout order. Product behavior lives in code;
this is the operational runbook.

Standard+ tier. The gate is `src/lib/slack/tier-gate.ts` and is enforced at
the connect route and at every delivery path.

## Architecture map

| Piece | Path |
| --- | --- |
| OAuth (state, exchange, revoke) | `src/lib/slack/oauth.ts` |
| Web API client (postMessage, channels) | `src/lib/slack/client.ts` |
| Webhook verify + envelope parse | `src/lib/slack/webhook.ts` |
| Connection store (encrypted bot token) | `src/lib/db/slack-connections.ts`, table `slack_connections` |
| Connect / callback / manage routes | `src/app/api/integrations/slack/{connect,callback}/route.ts`, `src/app/api/integrations/slack/route.ts` |
| Events receiver | `src/app/api/webhooks/slack/route.ts` |
| Dashboard card | `src/components/dashboard/SlackIntegrationCard.tsx` |

## Env contract

Set in Vercel production AND local `.env` (nothing Slack-related is read by
Supabase edge functions; the Deno side reaches Slack only through internal
app routes):

- `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`: OAuth credentials from the app.
- `SLACK_SIGNING_SECRET`: HMAC key verifying every Events API delivery.
- `SLACK_APP_ACCESS_TOKEN` / `SLACK_APP_REFRESH_TOKEN`: App Manifest API
  config-token pair, LOCAL `.env` ONLY (scripts, never runtime, never
  Vercel). Access tokens live 12 hours; rotate with `tooling.tokens.rotate`
  and write BOTH new values back immediately (rotation invalidates the old
  refresh token).

## App manifest

The app is created and updated through the App Manifest API, not the web
dialog. Current manifest (keep this block in step with what is deployed):

```json
{
  "display_information": {
    "name": "New Coworker",
    "description": "Your AI coworker: business alerts and chat, right in Slack.",
    "background_color": "#16233b"
  },
  "features": {
    "bot_user": {
      "display_name": "New Coworker",
      "always_online": true
    }
  },
  "oauth_config": {
    "redirect_urls": [
      "https://www.newcoworker.com/api/integrations/slack/callback"
    ],
    "scopes": {
      "bot": [
        "assistant:write",
        "chat:write",
        "chat:write.public",
        "channels:read",
        "groups:read",
        "im:history",
        "app_mentions:read",
        "users:read",
        "users:read.email"
      ]
    }
  },
  "settings": {
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

Two blocks are added AFTER the events endpoint is deployed (stage 2 below),
because Slack verifies the request URL against a live endpoint:

```json
{
  "settings": {
    "event_subscriptions": {
      "request_url": "https://www.newcoworker.com/api/webhooks/slack",
      "bot_events": [
        "app_home_opened",
        "app_mention",
        "app_uninstalled",
        "message.im",
        "tokens_revoked"
      ]
    },
    "interactivity": {
      "is_enabled": true,
      "request_url": "https://www.newcoworker.com/api/webhooks/slack/interactivity"
    }
  }
}
```

The Agents feature (`agent_view` messaging experience) is enabled with the
event subscriptions stage. Live-validator facts (re-probed 2026-08-11): the
minimal block is `"features": { "agent_view": {} }`, and the only extra
properties it accepts are `suggested_prompts` and `agent_description` (the
"assistant overview" the Marketplace's AI-app check requires; `overview`,
`description`, and `assistant_description` are all rejected). The same
check also requires `features.app_home.messages_tab_enabled: true`.

## App Manifest API commands

All calls authenticate with the config ACCESS token. Rotate first when in
doubt (the access token expires after 12h):

```bash
curl -s -X POST https://slack.com/api/tooling.tokens.rotate \
  -d "refresh_token=$SLACK_APP_REFRESH_TOKEN"
```

The response carries a NEW `token` and NEW `refresh_token`; write both back
to `.env` before doing anything else.

Validate, create, read, update:

```bash
curl -s -X POST https://slack.com/api/apps.manifest.validate \
  -H "Authorization: Bearer $SLACK_APP_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"manifest\": $(cat manifest.json | jq -c .)}"

curl -s -X POST https://slack.com/api/apps.manifest.create \
  -H "Authorization: Bearer $SLACK_APP_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"manifest\": $(cat manifest.json | jq -c .)}"

curl -s -X POST https://slack.com/api/apps.manifest.export \
  -H "Authorization: Bearer $SLACK_APP_ACCESS_TOKEN" \
  -d "app_id=$SLACK_APP_ID"

curl -s -X POST https://slack.com/api/apps.manifest.update \
  -H "Authorization: Bearer $SLACK_APP_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"app_id\": \"$SLACK_APP_ID\", \"manifest\": $(cat manifest.json | jq -c .)}"
```

`apps.manifest.create` returns `app_id` plus `credentials` (`client_id`,
`client_secret`, `signing_secret`, `verification_token`) and an
`oauth_authorize_url`. The credentials go straight into `.env` + Vercel.

## Rollout order

1. Create the app from the stage-1 manifest (OAuth config only). Store
   credentials in `.env` + Vercel production, redeploy.
2. Merge + deploy the PR that ships `/api/webhooks/slack`. Then
   `apps.manifest.update` to attach `event_subscriptions` (the
   `url_verification` challenge must succeed against the live endpoint) and
   enable the Agents feature. The interactivity URL joins when the approvals
   PR deploys.
3. Install into the HQ workspace (business
   `8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d`) from the dashboard card as tenant
   zero; pick the alert channel.
4. Cloudflare check: confirm bot protection / scraper rules do not challenge
   Slack's webhook POSTs on `/api/webhooks/slack` (precedent: the MCP
   connector WAF allowlist in README "Claude connector", and the Jul 30
   Googlebot 403 incident). Slack retries at ~0/1/5 min and can disable the
   subscription on sustained failures, so a WAF challenge here is an outage.

## Scope justifications (Marketplace review will ask)

- `assistant:write`: powers the AI-agent surface (status, titles, prompts).
- `chat:write`: post alerts and replies as the bot.
- `chat:write.public`: post alerts into a public channel the owner picked
  without requiring a bot invite first.
- `channels:read` + `groups:read`: list public channels (and private ones
  the bot was invited to) for the alert-channel picker; without them
  `conversations.list` answers `missing_scope` and the picker is empty.
- `im:history`: receive `message.im` so a DM to the coworker gets a reply.
- `app_mentions:read`: receive `app_mention` so @New Coworker works in
  channels.
- `users:read` + `users:read.email`: map a Slack user to a verified email;
  owner-power actions unlock only for the business owner's email.

## Marketplace config freeze

Once the app is approved for the Slack Marketplace, scope/endpoint/listing
changes require a re-review before they apply. Batch such changes, and never
land a code change that silently depends on an unapproved scope. Unlisted
installs (any workspace, via our connect URL) work before and during review.

## Marketplace submission state (2026-08-11)

The submission wizard (app config, Prepare & Submit) is filled and saved
through all five sections: listing (long description, categories Customer
Support / Productivity / Office Management, languages en-US + es-LA, pricing
"Included with service subscription", all four URLs, support email), scope
reasons for all nine scopes, security & compliance (hosting, retention,
erasure, sub-processors yes, LLM yes with tenancy/residency/retention
answers, HIPAA no), and testing information (review tenant credentials,
Run now instructions, notification channel #all-new-coworker).

App config added for the AI-app requirement: `features.app_home.messages_tab_enabled`
and `features.agent_view.agent_description` (the "assistant overview"; the
manifest field name is `agent_description`).

Automated checks still blocking the final Submit click:

1. Their cached "TOS URL non-200" result. Root cause was Cloudflare
   challenging their headerless checker; fixed by the listing-URL skip rule
   (see docs/OPS-MARKETING-SCRAPE-WAF.md). Clears when their checker re-runs.
2. Five active workspace installs required; the app has one (HQ). Four more
   workspaces need real installs through the dashboard connect flow. The
   page's install count refreshes within 24 hours of installs.

When both clear, the "Submit App for Review" button on the Automated
Feedback page completes the submission. Review wait times shown: 10 days
preliminary, about 10 weeks functional for new apps.

## Marketplace submission checklist

Run through before Brian submits (the app config UI, under his account):

1. Scopes in the manifest exactly match `SLACK_BOT_SCOPES` in
   `src/lib/slack/oauth.ts` and the table on `/integrations/slack`; drop
   anything code stopped using.
2. Listing URLs: Documentation = `https://www.newcoworker.com/integrations/slack`,
   Support = `https://www.newcoworker.com/contact`,
   Privacy = `https://www.newcoworker.com/privacy`.
3. Reviewer instructions link the test plan
   (`/integrations/slack/review-test-plan`, noindexed) and carry the review
   tenant's credentials in the submission notes, never on the page.
4. A review tenant exists on Standard with the demo approval flow enabled
   and a spare non-owner Slack member for the owner-only button test.
5. Remember the config freeze: after approval, scope/endpoint/listing edits
   require re-review before they apply (batch them). Unlisted installs keep
   working before, during, and after review.
