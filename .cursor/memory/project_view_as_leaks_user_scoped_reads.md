---
name: project-view-as-full-access-and-identity-fields
description: "Admin view-as is FULL access since Aug 17 2026 (PR #1420); business writes follow the pin, but user-scoped and session-scoped surfaces do not, and each route's identity fields need classifying"
metadata:
  node_type: memory
  type: project
  originSessionId: 8ff153b1-1bcc-4d33-bb9c-52637d885f1b
  modified: 2026-08-17T17:38:54.459Z
---

Admin view-as pins a business id via an httpOnly cookie. It used to refuse
every mutation (an `isViewAsActive` 403 on ~50 routes). **That is gone as of
PR #1420 (Aug 17 2026): view-as is full access, and `isViewAsActive` no longer
exists.** The refusals were never a policy, they were a workaround for routes
that resolved "the" business from the SIGNED-IN user's email.

ONE refusal remains, and it is policy not plumbing: `/api/legal/accept` rejects
an impersonating admin (PR #1422). A terms_acceptances row evidences that a
SPECIFIC PERSON agreed, so an operator-recorded one is fabricated however it is
labeled. A labeled `admin_view_as` source shipped and was withdrawn the same
day; do not reintroduce it. The dashboard layout also never raises the
clickwrap gate under view-as, so the refusal cannot strand an operator.

Three tiers, and only the first one retargets by itself:

1. **Business-scoped** writes resolve through `resolveActiveBusinessContext`
   (returns the pin as role `owner`) or take an explicit `businessId` guarded
   by `requireBusinessRole` (admins pass). These are safe automatically. When
   adding a tenant-facing mutation, resolve the business one of those two ways.
2. **User-scoped** (login email, UI locale, the auth-user teardown in account
   delete, the clickwrap ledger) must call `resolveViewAsTargetUser`, which
   returns the impersonated owner's auth user, or `userId: null` when the
   tenant's `owner_email` has no login. Callers MUST refuse on that null;
   falling back to the caller edits the operator's own account.
3. **Session-scoped** cannot retarget at all, because no API acts on someone
   else's browser: the password card (`changeAccountPassword` re-auths via
   `signInWithPassword`), the passkeys card (`supabase.auth.passkey.*`), and
   sign-out-everywhere. These carry an `OwnLoginNotice` instead. Do NOT "fix"
   one by feeding it the tenant's identity: that breaks the re-auth outright.
   The tenant-side equivalents live in a separate `TenantCredentialsCard`
   (PR #1422): `POST /api/account/password-reset` emails the tenant Supabase's
   recovery link (a RESET, never a set, so the operator never holds a live
   customer credential), and `GET`/`DELETE /api/account/passkeys` lists and
   revokes via `auth.admin.passkey.*` through
   `createSupabaseAdminPasskeyClient` (separate factory: the experimental flag
   should not be on for every server path). **Enrolling a passkey for a tenant
   cannot be built** at all: WebAuthn mints the credential on the tenant's own
   device, which is why the admin API has list and delete only.

The old read-side trap still holds: a `/dashboard/**` read keyed on `user_id`
instead of `business_id` answers for the operator (that is how the
Claude/ChatGPT connector tiles read "Connected" on tenants that never
connected, PR #1378). The connector Disconnect also still skips its OAuth
revoke unless the caller is the connected login, because Supabase's
`auth.oauth` only touches the caller's grants. Platform limit, not policy.

**How to apply:** README has the full contract under "Admin view as: full
access, and what keeps it on the right row". Read it before touching a
tenant-facing route, and see
[[feedback-removing-a-gate-means-auditing-identities]] for the review habit
that the three Bugbot rounds on #1420 taught.

Related: [[project-main-checkout-is-stale-never-copy-files]],
[[feedback-verify-the-column-is-written]]
