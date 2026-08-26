---
name: playwright-load-state-waits-are-once-per-document
description: "waitForLoadState(\"networkidle\") after a click is a NO-OP on an already-loaded page; the re-goto it \"guarded\" cancelled Clever's in-flight login for months"
metadata: 
  node_type: memory
  type: project
  originSessionId: dfce2f02-4cc9-44be-9f4c-a0a6b75907a3
  modified: 2026-08-19T20:53:14.242Z
---

Playwright load states are reached **once per document**. On a page that
finished loading before your click, `waitForLoadState("networkidle")` returns
**immediately**, no matter what the click just set in motion; new XHRs never
un-reach a load state. It only waits on a page that is still loading.

**The incident:** the aiflow-render sidecar followed `performLogin` with
`waitForLoadState("networkidle")` then `page.goto(target)`. On Clever the
login takes seconds (submit swaps to a spinner, auth round-trips, then a
cross-subdomain redirect from `login.listwithclever.com` sets the
`agents.listwithclever.com` session). The no-op wait let the goto fire
instantly, cancelling the in-flight auth every time: deterministic
`login_failed` with correct credentials, a landed click, and no error text,
because the re-navigation also wiped the evidence. It was misdiagnosed as
"Clever's password login is broken" for months.

**How to apply:**
- To wait for the AFTERMATH of an action, wait for an observable consequence
  (URL change, element appearing/leaving), never for a load state:
  `waitForLoginToResolve` in `vps/aiflow-render/login.mjs` polls until the
  page navigates away from the form or the form leaves, bounded 12s
  (`AIFLOW_LOGIN_RESOLVE_TIMEOUT_MS`).
- `page.goto()` right after an action can CANCEL in-flight requests and
  client-side redirects of the current page. Any "submit then navigate
  elsewhere" sequence needs the submit's consequence confirmed first.
- Diagnosing this class: reproduce inside the tenant's own sidecar container
  (docker cp a script next to /app/node_modules, docker exec node), importing
  the production module directly; credentials never leave the box. A fixed
  8s wait succeeding where the service fails is the tell that the wait logic,
  not the login, is broken.
- Same-domain logins (HomeLight) can survive the broken sequence by luck of
  timing, so "works for portal A" never clears the sequence for portal B.
  Related: [[empty-page-reads-as-nothing-to-do]].
