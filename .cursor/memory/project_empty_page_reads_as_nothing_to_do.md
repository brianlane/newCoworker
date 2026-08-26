---
name: empty-page-reads-as-nothing-to-do
description: "A locked-out portal renders an EMPTY list, not an error, so \"0 rows, 0 errors\" means \"we never got in\" as often as \"all done\"; alerts measuring only leftovers go silent exactly then"
metadata: 
  node_type: memory
  type: project
  originSessionId: dfce2f02-4cc9-44be-9f4c-a0a6b75907a3
  modified: 2026-08-19T19:46:26.948Z
---

Clever's portal magic link is **single-use**. Re-visiting a spent one
(`/interstitial/?magic_uuid=...`) returns a page whose only heading is
"Magic link has expired" and whose only link is "Go Back to Login Page".
Proved live 2026-08-19. That page is NOT login-shaped (a link, not a form),
so the sidecar's credential login never triggers on it. The recovery is
navigating the STABLE portal URL instead: logged-out it redirects to the real
login form and the sidecar signs in with the stored credentials
(`amy-clever-sweep-rerun.ts --portal-url ...` starts the run at the browse
step with `vars.portal_url` seeded). Password login itself WORKS as of the
2026-08-19 `waitForLoginToResolve` fix; see
[[playwright-load-state-waits-are-once-per-document]] for why it looked
broken for months.

**The trap:** that expired page has no list rows and produces **no error**, so
a `forEachLink` sweep reports `items: 0, errors: []` and the run closes
`done`. On the numbers alone that is *identical* to "the book was already
clean".

**How to apply:**
- Never treat "0 matched, 0 errors" as success on its own. Resolve it with
  context the numbers do not carry: an empty list that CONTRADICTS a prior
  pass's "still owed" count is a lost session, reported as `lost_list`, not a
  finish (`decideForEach` in `_shared/ai_flows/browse.ts`).
- **An alert that measures only what is LEFT OVER is silent exactly when the
  automation is most broken**, because a run that never got in leaves zero.
  Always alert separately on "did it accomplish anything at all"
  (`less_than(updated, 1)`). Replacing a crude always-fires alert with a
  precise measured one is a REGRESSION unless that arm ships with it: PR #1522
  did this and #1524 fixed it.
- Use the **fail-loud polarity** on such gates: `notEquals "no"` fires on both
  "yes" and the `not_a_number` sentinel a missing var produces, so version
  skew (a flow patched before the engine deploy landed) pages the owner
  instead of going quiet. That skew is real, not theoretical: applying a flow
  one-shot minutes after a merge beat the Vercel Deploy job that ships edge
  functions. **Confirm the deploy job finished before applying a one-shot that
  depends on new engine vars.**
- Diagnose with `tsx debug/portal-dom-probe.ts --business-id <id> --label
  Clever --url <url>`: it renders through the tenant's own sidecar and prints
  headings, links and console errors, which is what turned "0 rows" into
  "expired link" in minutes.
- Consequence for scheduling: a Clever sweep only works in the window right
  after the vendor's text. Replaying an older reminder cannot work.
  Related: [[project_foreach_cap_is_cloudflare_bound]],
  [[project_ok_true_is_not_a_commit]],
  [[project_homelight_claim_click_silent_noop]].
