# Outlook integration: Entra app setup and operations

Outlook mail and calendar connect through **our own Microsoft OAuth**, not
through Nango. This doc carries the Entra app registration, the env contract,
the rollout order, and the operational notes. Product behavior lives in code;
this is the runbook.

Google, OneDrive, and the long tail still connect through the Nango Connect UI
on the same workspace card. Nango is not going away here, it is being demoted
off the two heavy providers.

## Architecture map

| Piece | Path |
| --- | --- |
| OAuth (state, authorize, exchange, refresh, identity) | `src/lib/microsoft/oauth.ts` |
| Access-token manager (refresh, single-flight, fence) | `src/lib/microsoft/client.ts` |
| Direct HTTP transport (the `nango.proxy()` equivalent) | `src/lib/workspace-oauth/direct-transport.ts` |
| Transport dispatcher (picks nango vs direct per row) | `src/lib/workspace-oauth/proxy.ts` |
| Connection store (shared with Nango rows) | `src/lib/db/workspace-oauth-connections.ts`, table `workspace_oauth_connections` |
| Connect / callback routes | `src/app/api/integrations/microsoft/{connect,callback}/route.ts` |
| Dashboard button | `src/components/dashboard/MicrosoftConnectButton.tsx` |

There is no `microsoft_connections` table. The transport lives in a **column**
on `workspace_oauth_connections`, because that row's `id` is persisted inside
AiFlow definitions and guarded on delete by
`flowsReferencingWorkspaceConnection`. Splitting the id space across two tables
would break that guard.

## Entra app registration

Portal: <https://entra.microsoft.com> → Applications → App registrations → New
registration.

1. **Name**: New Coworker.
2. **Supported account types**: the option that admits both work and personal
   accounts. The portal renamed these when Azure AD became Entra ID, so match on
   meaning rather than exact wording:

   | Older label | Current label |
   | --- | --- |
   | Accounts in any organizational directory and personal Microsoft accounts | **Any Entra ID Tenant + Personal Microsoft accounts** |

   Both set `signInAudience = AzureADandPersonalMicrosoftAccount`. Confirm after
   registering under Manage -> Manifest; the Overview page shows it as
   "All Microsoft account users", which is the same thing again.

   This is not optional. The code targets the **`common`** authority, which is
   the only one admitting both classes of owner. `organizations` excludes
   personal Outlook accounts; `consumers` excludes every work/school tenant.
   A mismatch between the authority and the registration's audience fails at
   consent with `AADSTS50194`.
3. **Redirect URI**: platform **Web**. Microsoft requires a byte-exact match,
   and the value we send is derived, not typed:

   ```
   ${NEXT_PUBLIC_APP_URL}/api/integrations/microsoft/callback
   ```

   So read `NEXT_PUBLIC_APP_URL` first and register exactly what it produces.
   **This repo sets it to `https://www.newcoworker.com`, so the registered URI
   needs the `www.`**:

   ```
   https://www.newcoworker.com/api/integrations/microsoft/callback
   ```

   Registering the apex form instead (`https://newcoworker.com/...`) looks right
   and fails every connect with `AADSTS50011: The redirect URI specified in the
   request does not match`. Registering both costs nothing and is the safe move.
   Add the dev box's too if you connect locally:
   `http://localhost:3000/api/integrations/microsoft/callback`.

   Check it against the shipped code rather than by eye:

   ```bash
   node -e 'console.log(process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/,"")+"/api/integrations/microsoft/callback")'
   ```
4. **Certificates & secrets** -> New client secret. Copy the **Value**
   immediately; it is shown once.

   The **Secret ID** next to it is not a credential and is not used anywhere in
   this codebase: it identifies the secret row in the portal, nothing more. It
   is the same shape as the Application (client) ID (both UUIDs), which is
   exactly why it gets pasted into `MICROSOFT_CLIENT_ID` by mistake; that fails
   every token exchange with `invalid_client`. The client id comes from the
   **Overview** page. Note the expiry and set a
   reminder: an expired secret fails every refresh with `invalid_client`,
   which by design does NOT deactivate tenant connections (see below), so the
   symptom is every Outlook call failing at once while the cards still read
   connected.
5. **Publisher verification**: a multitenant registration shows
   "End users cannot grant consent to newly registered multitenant apps without
   verified publishers. Add MPN ID to verify publisher."

   Take it seriously before rollout. Unverified, users in OTHER tenants can be
   blocked from consenting entirely, which is every customer who is not us.
   Personal Microsoft accounts are unaffected, so a solo test against a personal
   Outlook will pass and tell you nothing about org tenants. Verify the
   publisher with the Microsoft partner (MPN) id, then re-test with a work
   account before inviting anyone.

6. **API permissions**: none need to be pre-added. Scopes are requested per
   authorize call (`src/lib/microsoft/oauth.ts`, `MICROSOFT_SCOPES`) and
   consented by the owner. Pre-adding them in the portal is harmless but does
   not change behavior.

### Scopes, and the one that is easy to miss

```
openid profile email offline_access
User.Read Mail.ReadWrite Mail.Send
Calendars.ReadWrite Calendars.Read.Shared
```

- `offline_access` is what yields a refresh token at all. Without it the
  connection dies in an hour with no way to renew.
- `Mail.ReadWrite` covers inbox reads and every organize action (isRead,
  categories, move, mailFolders).
- `Mail.Send` covers `/me/sendMail` and `/me/messages/{id}/reply`.
- `Calendars.ReadWrite` covers events, calendarView, and creating the shared
  "NewCoworker" calendar.
- **`Calendars.Read.Shared`** is the one to not drop: `POST
  /v1.0/me/calendar/getSchedule` (free/busy, the backbone of
  `calendar_find_slots`) is **not** covered by `Calendars.ReadWrite`, because
  the `.Shared` variants are separate permissions.

None of these require admin consent by default.

### No PKCE, deliberately

Microsoft mandates PKCE only for **public** clients (SPA, native). This is a
confidential client with a real secret, and the OAuth state here is
deliberately stateless (an HMAC-signed blob, no server-side session), so a
`code_verifier` would have to ride to the browser and back inside the state,
which removes the only thing PKCE buys. If this ever becomes a public client,
PKCE stops being optional.

## Env contract

Set in Vercel production AND local `.env`. Nothing Microsoft-related is read
by Supabase edge functions; the Deno side reaches Graph only through internal
app routes.

- `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`: from the registration
  above.
- `NEXT_PUBLIC_APP_URL`: already set; the redirect URI derives from it.
- `INTEGRATIONS_ENCRYPTION_KEY`: already set; encrypts the stored token pair
  (AES-256-GCM, `enc:v1:` envelope) and keys the OAuth state HMAC.

**Unset is a safe state.** The connect route reports "Outlook is not
configured on this server" and Outlook keeps going through Nango. That is why
the server-side PR could merge before the credentials existed.

## Rollout order

1. Create the registration, set both env values in Vercel, redeploy.
2. Connect one Outlook account yourself from
   `/dashboard/integrations/workspace` and confirm the card labels it with the
   right address (that label comes from the `/v1.0/me` probe, not from your
   dashboard login).
3. Exercise send, inbox poll, and a calendar booking before inviting anyone
   else.
4. Only then disable the `outlook` and `outlook-calendar` integrations in the
   **Nango dashboard**, which is what stops new Outlook connections being made
   through the Connect UI's card grid. That grid is served by Nango and is not
   configurable from this repo.
5. Existing Nango Outlook tenants migrate themselves: see reconnect below.

## Reconnect is cross-transport, and migrates tenants for free

The callback probes `/v1.0/me` **before** any DB write, so it knows which
mailbox was connected and can match an existing row by
`metadata.provider_account_email`, **regardless of transport**.

An owner whose Outlook is still on Nango who clicks Connect Outlook gets their
existing row flipped to `direct` **in place**: same row `id`, so every AiFlow
mailbox binding, email trigger, and shared-calendar id survives. Each reconnect
quietly moves one more tenant off Nango, with no flow breakage and no seat
consumed.

That is the intended migration path. There is no bulk token export: Nango
cannot hand over refresh tokens, so every tenant re-consents eventually.

## Operational notes

**Token refresh is lazy, never scheduled.** `getMicrosoftAccessToken` refreshes
when under 60s of validity remains. Microsoft rotates refresh tokens, so the
new pair is persisted before the access token is handed out. Two race guards:
an in-process single-flight keyed by **connection row** (a business can hold
several mailboxes, unlike Zoom's one-per-business), and an `updated_at`
optimistic fence for cross-instance races the map cannot see.

**Only `invalid_grant` deactivates a connection.** `invalid_client` (our secret
is wrong or expired) stays `request_failed` on purpose, so a mistake on our
side never soft-disables tenants whose grants are fine. When a refresh does
come back `invalid_grant`, the row is re-read first: if another instance
rotated it, we adopt the winner's token instead of deactivating a healthy
connection.

**There is no scoped revoke endpoint.** Microsoft publishes no equivalent of
Zoom's `POST /oauth/revoke`. Disconnecting deletes the ciphertext; the access
token dies within the hour and the refresh token at the tenant's inactivity
window (90 days by default). An owner who wants the grant gone from their side
immediately does it at <https://account.live.com/consent/Manage> (personal) or
<https://myapps.microsoft.com> (work/school). Do not add
`User.RevokeSessions.All` to make teardown look tidier: it requires admin
consent and would break self-serve connect for every org tenant.

**Admin consent.** A tenant configured with "user consent for applications =
Do not allow" bounces with `AADSTS65001` / `AADSTS90094`. The callback detects
that and says an administrator must approve, rather than reporting a generic
failure. The admin-consent leg returns to the same callback with
`admin_consent=True` and **no code**, which the callback treats as success and
sends the owner back through the normal authorize leg.

**Known gap: `getSchedule` is work/school only.** On a personal Outlook account
`POST /me/calendar/getSchedule` fails, and the free/busy handler does not catch
a throw. This predates the migration (it behaved the same through Nango) but
becomes more visible now that personal accounts can connect. Fix is a fallback
to `calendarView`; tracked separately.

**Polling is unchanged.** Connected-mailbox watching is still the roughly
1/minute cron poll. No Graph push subscriptions were added.
