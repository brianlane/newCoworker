---
name: project-hostinger-list-flake-is-not-action-required
description: "A Hostinger catalog or billing-list timeout is a flake, not a crashed sweep. First day is warn; a repeat in 48h may page, but never as ACTION REQUIRED / CRASHED."
metadata:
  node_type: memory
  type: project
  originSessionId: hostinger-flake-warn-until-repeat
  modified: 2026-09-12T06:00:00.000Z
---

Sep 11 2026, 10:30 UTC: `vps-contract-upgrade-sweep` spent 30,010ms on
`listCatalog("VPS")`, Hostinger timed out at the 30s client default, the
opening `Promise.all` threw, `handleRouteError` collapsed it to
`An unexpected error occurred`, the ledger wrote `ok=false`, and the 03:30
UTC watchdog mailed `[ops] ACTION REQUIRED: 1 cron sweep problem(s), including
a crashed sweep`. No box was touched. No purchase started. Amy Laidlaw was
`skipped_not_due` until 2028-07-14. Same rule as PR #1771 (billing-posture VM
lookup) and the System Errors card: first flake is a warn, page only if it
repeats inside 48h, and never as CRASHED.

The opening catalog + billing-list pair is now `loadHostingerListsForSweep`:
one retry, then `ok:true` with `hostingerUnavailable` instead of a throw. The
route runs `applyHostingerListFlakePaging` through `recordFailure` (48h
window, event `vps_sweep_hostinger_list_flake`). First day stays out of
`failures[]`. A repeat lands in `failures[]` so the watchdog sees
`hostinger_flake`, whose subject is `[ops] Cron sweep watchdog: N finding(s)`,
not ACTION REQUIRED.

Leftover `ok=false` rows whose error still matches a Hostinger timeout or
network drop: first day suppressed (`suppressedHostingerFlakes`), second
consecutive in 48h pages `hostinger_flake`. A TypeError or other real crash
still pages `failed` immediately.

`handleRouteError` keeps the real Hostinger flake message on the 500 so a
throw that still escapes is identifiable in `cron_sweep_runs.errors`. Other
500s stay generic.

Do nothing to Hostinger/hPanel for a mail that was this flake. The next
scheduled 10:30 UTC run is the empirical test: Amy `skipped_not_due` again
means one-off; another flake is day 2.
