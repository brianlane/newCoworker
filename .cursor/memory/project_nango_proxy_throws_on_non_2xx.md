---
name: project_nango_proxy_throws_on_non_2xx
description: "nangoProxyForBusiness throws on any non-2xx; branch on status via nangoProxyStatusForBusiness, and never normalize globally"
metadata: 
  node_type: memory
  type: project
  originSessionId: a33400a3-40c6-4248-a4e5-c352d47a66d4
  modified: 2026-08-18T21:26:53.444Z
---

`nangoProxyForBusiness` (`src/lib/nango/workspace.ts`) **throws** on any
non-2xx. Nango builds its axios instance with no `validateStatus` override, so
axios's 2xx-only default applies. A Gmail 403 or Graph 429 arrives as a
rejection carrying `response.status`, never as a returned `{ status }`.

To branch on a status code, use the SEAM's `workspaceProxyStatusForBusiness`
(`src/lib/workspace/proxy.ts`), which returns `{ status, data }` for a provider
error and rethrows a transport failure that carries no status. The seam is the
entry point since the first-party OAuth migration landed: it dispatches on the
connection row's `transport` column, and its direct arm throws a
`DirectTransportError` deliberately shaped like an axios error so both arms
normalize identically. `nangoProxyStatusForBusiness` (added in PR #1282) is the
Nango arm underneath; only the seam should import `@/lib/nango/workspace`.

**Why not normalize inside the base function:** all 13 production consumers
null-check the link and then read `res.data`, relying on the throw for
everything else. Returning error responses globally would make
`sendFromMailboxConnection` report `{ ok: true }` for a send Gmail refused, and
make `email-poll` read a 500 as "no new mail". Silent success is worse than a
vague error.

**How to apply:** reach for the status variant only where the code actually
branches on the number. Where it does not, keep the raw proxy so a failure
stays loud, and say why in a comment.

A new transport behind the seam must keep the throw/normalize split. The old
HTTP pass-through route `POST /api/integrations/nango/proxy` was deleted in PR
#1365 after an audit proved it never had a caller (full-history `git log -S`,
SSH sweep of all four boxes including inside containers, one-hour live log
tail): do not resurrect it.

Related: [[feedback_assert_the_producer_not_the_fixture]] (the tests that hid
this resolved a status the producer cannot emit),
[[feedback_verify_the_column_is_written]].
