---
name: email-routing-catchall-is-the-product
description: "Cloudflare's catch-all on newcoworker.com IS the tenant AI mailbox; never repoint it. Strays now forward via the worker (shipped #1196)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3f3013a9-daa6-4161-b54f-dd1fb7be19bd
  modified: 2026-08-05T22:39:06.274Z
---

`newcoworker.com` mail runs on Cloudflare Email Routing with exactly one
catch-all, and that catch-all points at the `nc-email-inbound` Worker. **That is
the per-tenant AI mailbox feature**, not a spare slot: every
`<tenant>@newcoworker.com` message flows through it and fires `tenant_email`
AiFlows.

**Never repoint the catch-all to a forwarding address.** It breaks inbound email
for every tenant at once. If someone asks for "a catch-all to my inbox", they
are asking for something that already exists and is load bearing.

Explicit rules take precedence and match the **exact** address. Cloudflare does
not strip plus-tags, so `team+anything@` does NOT match the `team@` rule.

**Strays are handled as of #1196 (2026-08-05).** The worker reads the webhook's
response body and forwards to `FALLBACK_FORWARD_ADDRESS` when the app answers
`matched: false`. Before that they vanished, because the app must return 200 for
unknown recipients (a non-2xx makes the sender retry a delivery that already
succeeded at the edge), so `res.ok` alone could not distinguish the two.
`recipientWasUnmatched` fails closed: a false negative just drops a stray, but a
false positive would forward a tenant's customer mail to the operator's inbox.

**`message.forward()` after `PostalMime.parse(message.raw)` is SAFE.** Verified
in production 2026-08-05: a deliberate second read failed ("ReadableStream is
disturbed") while forward succeeded and the mail arrived. Do **not** try to
verify this in `wrangler dev`, where `forward()` is a no-op stub that accepts
even an invalid destination.

**`cloudflare/email-worker` is NOT deployed by push-to-main.** After merging a
change there, run `cd cloudflare/email-worker && npx wrangler deploy`, the same
shape as the VPS fleet redeploy.

The worker's local `ForwardableEmailMessage` interface **shadows** the global
from `@cloudflare/workers-types`. A member missing there means "not used yet",
never "unsupported"; omitting `forward` made tsc reject a call that works.

Dashboard: account `3cac3f59ad97c60fb452dd150259713a`, zone `newcoworker.com`.
Token needs **Zone → Email Routing Rules → Edit** for rule changes (the
account-level "Email Routing Addresses" permission is a different thing).
