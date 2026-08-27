---
name: foreach-cap-is-cloudflare-bound
description: "A forEachLink PASS runs in ONE response behind a ~100s Cloudflare 524, so ~6 items per pass; since Aug 19 2026 the worker chains passes until the list drains"
metadata: 
  node_type: memory
  type: project
  originSessionId: dfce2f02-4cc9-44be-9f4c-a0a6b75907a3
  modified: 2026-08-19T19:19:44.507Z
---

A `forEachLink` browse loops matched rows inside a **single HTTP response**,
and that response crosses a tenant Cloudflare Tunnel whose ingress carries no
`originRequest` block (`src/lib/cloudflare/tunnel.ts` writes hostname and
service only), so it inherits Cloudflare's **default ~100s 524**.

Measured on Amy Laidlaw's completed Clever sweeps (items -> seconds):
`1 -> 20.0 | 2 -> 32.0 | 3 -> 45.4 | 4 -> 59.0 | 5 -> 60.0 | 0 -> 4.8`,
i.e. **~5s fixed plus ~13s per item**. So `MAX_FOREACH_ITEMS` is **6** (~83s),
down from an undeliverable 25 (~330s) on 2026-08-17.

**The cap is a per-pass CHUNK SIZE, not the coverage** (PR #1522, Aug 19
2026). The render service reports the capped tail as `forEach.remaining`, and
the worker CHAINS: on remaining > 0 with progress it defers the run ~15s and
re-enters the SAME browse step. Updated cards leave the portal's "Needs
Action" list, so each pass re-lists only what is still owed and a 41-card
backlog drains in ~7 passes.

**How to apply:**
- Terminal conditions are named, never inferred: `list_drained`,
  `no_progress` (a full pass with zero successes; a stuck list head would
  otherwise loop forever), `pass_cap` (`AIFLOW_MAX_FOREACH_PASSES`, default
  20), `pass_error` (a pass 2+ permanent failure ends the loop **gracefully**
  rather than dead-lettering a run whose earlier passes already posted, since
  the alert steps sit behind the browse step).
- The step publishes measured `<stepId>_updated` / `<stepId>_left` vars
  (`forEachOutcomeVars`, imported by both the worker and the authoring
  validator). **Alert on those, never on capacity arithmetic**: the old
  "backlog minus 6" message told Amy 35 when the truth was 39.
- `left` always means **items - succeeded** (capped tail PLUS that pass's
  per-card failures, because failed cards stay listed too). Storing only the
  capped tail reintroduces the undercount, which is what Bugbot caught in
  #1522.
- Still do NOT raise the cap to cover a bigger backlog: that moves the failure
  from "honestly chunked" to "timed out halfway and then did it twice", since
  the worker retries a 524 and re-submits rows the dead pass already did.
- Version skew: a box whose sidecar predates `remaining` never chains (one
  pass, honest numbers). Redeploy `vps/aiflow-render` per tenant.
- Only Amy uses `forEachLink` (2 flows fleet-wide), so the default is
  effectively hers. Related: [[project_cron_timeout_three_layers]],
  [[project_fleet_redeploy_check]].
