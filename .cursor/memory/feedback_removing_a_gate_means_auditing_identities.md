---
name: feedback-removing-a-gate-means-auditing-identities
description: "When I remove an authorization gate, fixing WHICH RECORD the write targets is only half the job; every identity field inside the route needs classifying as subject vs actor"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 8ff153b1-1bcc-4d33-bb9c-52637d885f1b
  modified: 2026-08-17T17:39:12.130Z
---

PR #1420 removed ~50 view-as refusals. I correctly made the BUSINESS resolution
impersonation-aware, declared it done, and Bugbot then found three rounds of
real High/Medium bugs. Every one was an identity field still pointing at the
caller inside a route I had already "fixed":

- `ownerAuthUserId` fed the lifecycle planner's `delete_auth_user` op, so
  cancelling a customer's plan would have queued deletion of the OPERATOR's own
  login. The worst one, and Bugbot did not even name it: I found it while
  chasing the two it did name.
- Stripe `customerEmail` and the `upsertCustomerProfile` email would have put
  the operator on a customer's billing record.
- The Account settings page displayed the operator's email beside a form that
  renamed the tenant, and promised confirm-by-link on a path that applies
  immediately.
- `PasskeysCard` ran against the operator's own session with no label.

**Why:** a gate's removal changes the blast radius of code I did not write and
did not read. I audited the thing the gate had been protecting (the business id)
and treated the rest of each route as unchanged, when in fact every `user.email`
and `user.userId` in it had just silently changed meaning.

**How to apply:** after removing any authz gate, grep the touched routes for
every caller-identity reference (`user.email`, `user.userId`, session clients)
and classify each one before moving on:

- **Subject identity** (whose record is this: payer, account holder, the row
  being edited) retargets to the impersonated party.
- **Actor identity** (who clicked, who consented, who authorized) stays the
  caller. Retargeting these FABRICATES a record. Stripe metadata `userId`
  becomes `consent_user_id`; the clickwrap ledger needed a new
  `admin_view_as` source rather than reusing `gate`.
- **Session-scoped** (browser re-auth, passkey enrollment, cookie revocation)
  cannot retarget at all. Label it; do not feed it the other party's identity.

Also: if I label one card in a class, sweep for its siblings in the same pass.
I labeled the password card and left passkeys and sign-out-everywhere
unlabeled, so Bugbot spent a whole round on what should have been one sweep.
This is the seam-clustering pattern from
[[check-for-a-shared-mechanism-first]], applied to authorization rather than
data plumbing.

Related: [[project-view-as-full-access-and-identity-fields]],
[[feedback-a-failing-old-test-is-evidence]]
