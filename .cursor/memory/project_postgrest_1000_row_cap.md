---
name: project-postgrest-1000-row-cap
description: "PostgREST silently caps un-limited selects at 1000 rows; any supabase-js query without .limit() on a busy table is truncated, newest-first reads lose old rows"
metadata: 
  node_type: memory
  type: project
  originSessionId: a849cf80-73f3-4b82-b1be-5e4512ba3010
  modified: 2026-08-10T06:27:07.082Z
---

Supabase's Data API (PostgREST) returns at most 1,000 rows for a select with
no explicit limit, silently. No error, no warning: `.gte(window)` +
`.order(desc)` on a busy table just loses everything past the 1,000 newest
rows.

Bit the cron sweep watchdog on its second night (fixed in PR #1260, Aug 10
2026): its 8-day lookback on cron_sweep_runs (~8,800 rows/day) truncated to
~3 hours, and seven healthy daily sweeps were emailed as STOPPED. Same
silent-truncation family as the [[project-telnyx-billing-model-traps]] 50-row
clamp and the schedules-only cron discovery trap in
[[project-cron-timeout-three-layers]].

**Why:** row counts grow with fleet size and chatter, so a query that worked
at launch starts silently lying later; and "the query returned data" reads as
"the query returned the data".

**How to apply:** any supabase-js `.from().select()` that expects more than a
handful of rows must either carry an explicit `.limit()` sized to the real
worst case, or move the aggregation server-side into an RPC whose result is
bounded by construction (latest-per-key, counts, or a hard limit).
`cron_sweep_run_evidence` and `cron_http_failures` in the migrations are the
worked examples. tests/worker-integration/cron-sweep-run-evidence.itest.ts
reproduces the cap against the real stack; copy its shape when a new
unbounded read is suspected.
