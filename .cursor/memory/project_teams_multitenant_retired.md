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

## Final state, 29 Aug 2026

Everything below is done and verified:

- Teams channel connected, health **Healthy** (Brian did this one in his own
  Chrome).
- App registration `signInAudience` is **`AzureADMultipleOrgs`** with **allow
  ALL tenants**, confirmed in the Microsoft Graph manifest. The "Multiple
  Entra ID tenants" choice defaults to *Allow only certain tenants*, which
  would require adding each customer's tenant id in Azure before they could
  connect. That was rejected: it breaks self-serve onboarding and duplicates
  the gate the webhook already applies against `coworker_connections`.
- `publisherDomain` is still `newcoworker.onmicrosoft.com`. AppSource wants a
  verified domain we own, so that DNS TXT verification is a prerequisite of
  any submission.

The auto-generated client secret Azure makes alongside the bot is **not
recoverable** (masked after creation), so a fresh one has to be minted under
Certificates & secrets. Bot secrets expire silently: when one does, sends
just start failing and it reads like a misconfiguration.

## The channels blade was CRASHING, not merely unreachable

Worth being precise, because "the pane cannot drive Azure" is the wrong
lesson. The Channels page renders in a cross-origin sandboxed iframe
(`sandbox-*.reactblade.portal.azure.net`), so `read_page` cannot see the rows
and `javascript_tool` cannot reach in. But the reason clicks did nothing was
an actual exception inside Microsoft's extension:

```
[Microsoft_Azure_BotService] ReactInternalErrorHandler
Cannot read properties of undefined (reading 'openm365')
Unhandled Promise Rejection
```

The blade later refused to load at all. Brian enabled the channel in his own
Chrome without trouble, so this was a portal-side fault plus an iframe the
tooling cannot introspect, not a general "Azure is undrivable" rule. The
Configuration blade WAS driven successfully (messaging endpoint set and
saved), as was the whole Entra admin center.

Still true and useful: mouse `scroll` wedges the pane on this portal every
time, and a taller emulated viewport re-renders the full list after a Refresh
but its scaled coordinates do not reach a cross-origin iframe. Reach for
`az bot msteams create` rather than fighting the blade.

Unrelated but seen in the console: the portal's own XHR probe of our
messaging endpoint is blocked by CORS, because we return
`Access-Control-Allow-Origin: https://www.newcoworker.com`. Harmless, Bot
Framework delivery is server to server, but it means the portal cannot do its
client-side endpoint health check and will never tell you the endpoint works.

Related: [[feedback-browser-pane-console-work]],
[[project-coworker-channel-architecture]], [[project-owner-surface-registry]].
