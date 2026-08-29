---
name: project-teams-multitenant-retired
description: Azure retired multi-tenant bot creation; our bot is Single Tenant, the APP REGISTRATION carries cross-tenant, and the token endpoint is tenant-scoped
metadata:
  type: project
---

Microsoft **deprecated multi-tenant bot creation after 31 July 2025**. The
Azure portal's "Type of App" dropdown now offers only *User-Assigned Managed
Identity* and *Single Tenant*. Existing multi-tenant bots keep working; new
ones cannot be made. Confirmed in the portal on 28 Aug 2026 while registering
ours, and in Microsoft's own docs.

**Managed Identity is not available to us.** It requires the bot to run on
Azure compute with the identity attached, and we run on Vercel. Single Tenant
is the only option, so there is no decision to re-litigate here.

## What was created

- Azure Bot `newcoworker-teams`, resource group `newcoworker-teams-rg`,
  East US, **F0 Free** (Teams is a Standard Channel, free on both tiers).
- Data residency **Global**, which is what `normalizeServiceUrl` in
  [client.ts](../../src/lib/teams/client.ts) pins (`smba.trafficmanager.net`).
  Choosing Regional would have handed us service URLs that allowlist refuses.
- Messaging endpoint `https://www.newcoworker.com/api/webhooks/teams`.
- App ID `0e5f838d-34d8-4514-9c9c-8ca276576d19`, tenant
  `c192f5fd-93fb-45cd-bafd-0fe0c33fc1fb` (New Coworker LLC). Neither is a
  secret; the secret is minted separately under Manage Password.

## The token endpoint moved, and the failure looks like a bad secret

Multi-tenant bots posted client credentials to the shared
`login.microsoftonline.com/botframework.com/oauth2/v2.0/token`. A
single-tenant app only exists inside its home directory, so that endpoint
answers **AADSTS700016 (application not found in that directory)**. That
reads exactly like a wrong `MICROSOFT_APP_SECRET`, which is the trap: you go
and rotate the secret, and nothing improves.

Ours now posts to
`login.microsoftonline.com/${MICROSOFT_APP_TENANT_ID}/oauth2/v2.0/token`,
scope unchanged at `https://api.botframework.com/.default`. The tenant here
is **always ours, never a customer's**. `MICROSOFT_APP_TENANT_ID` is a third
required variable that did not exist under the old flow, so an environment
carried over from before the switch has an id and a secret and no tenant.

## Cross-tenant lives on the APP REGISTRATION, not the bot resource

This is the part that misleads a reader: the portal says "Single Tenant", so
the security comments about any tenant being able to install the app look
stale. They are not. What governs who may talk to us is the **Entra app
registration's supported account types**, not the bot resource's type. The
bot resource's setting is closer to metadata.

So `channelData.tenant.id` is still an untrusted value from a stranger, and
an unbound tenant is still dropped. Do not relax that gate on the strength of
the portal showing Single Tenant.

Microsoft's officially supported cross-tenant path is publishing the Teams
app to **AppSource / the Teams Store**. Community answers conflict on whether
a sideloaded zip works with a multi-tenant app registration behind a
single-tenant bot: one Microsoft moderator says a zip will not receive
messages from other tenants, another says the app registration is what
decides and it does work. Both are Q&A posts, not documentation, so treat it
as unproven until measured. We have a Partner Center account, so AppSource is
open to us.

## The portal blade cannot be driven from the sandbox browser

The Channels page renders in a **cross-origin sandboxed iframe**
(`sandbox-*.reactblade.portal.azure.net`). Consequences, all measured:

- `read_page` cannot see the channel rows, and `javascript_tool` cannot reach
  into the frame.
- Blade **toolbar** clicks (Refresh, Apply) land; **row** clicks do not.
  Verified by clicking a visible row and a sort header with no effect.
- Mouse `scroll` anywhere on the page wedges the pane every time.
- A taller emulated viewport does render the whole list after a Refresh, but
  coordinates then scale and still do not reach the iframe.

The Configuration blade IS drivable (the messaging endpoint was set and saved
that way). Only the React channels blade resists. Enabling the Teams channel
has to be done by hand, or with `az bot msteams create`.

Related: [[feedback-browser-pane-console-work]],
[[project-coworker-channel-architecture]], [[project-owner-surface-registry]].
