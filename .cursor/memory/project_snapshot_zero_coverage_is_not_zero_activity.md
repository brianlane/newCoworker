---
name: project_snapshot_zero_coverage_is_not_zero_activity
description: "analytics_daily_snapshots writes a row per business per day regardless of activity, so no rows means UNMEASURED, not idle; the table starts Jul 11 2026"
metadata: 
  node_type: memory
  type: project
  originSessionId: 238c3b5b-3c06-4484-86b9-226a2adbc467
  modified: 2026-08-29T05:51:54.538Z
---

`runSnapshotSweep` (`src/lib/analytics/snapshots.ts`) upserts a row for EVERY
business for EVERY day in its backfill window, activity or not. So for any
window:

- `coveredDays > 0` and zeros => a genuinely quiet period.
- `coveredDays === 0` => **nobody was measuring**: the sweep did not exist yet
  (the table shipped 2026-07-11) or the tenant did not.

Treating the second case as zeros produces confident lies. Caught 2026-08-28
while building the monthly growth recap email: Amy's June rendered as
`Texts sent: 390 (0 last month, new)` for a month that really had 38 leads.
Leads come from `contacts` and survive; texts/calls/minutes come from the
snapshots and do not, so the row mixes a real number with a fabricated one,
which is worse than either. Any trend or projection drawn through such a month
is drawn through a period nobody was measuring.

`composeGrowthReport` (`src/lib/analytics/growth-report.ts`) now DROPS
zero-coverage months rather than zeroing them. Two consequences a caller has
to handle:

- The report's newest month is then not always "last calendar month". Anything
  that stamps a month (the growth email claims
  `businesses.monthly_growth_email_sent_for` before sending) must compare
  `report.latest.month` to the month it is claiming and skip on a mismatch, or
  it stamps August while mailing July and the stamp kills August forever.
- Partial coverage is different again and stays IN, with the fraction
  disclosed ("reported from 23 of its 31 days"), because a tenant who went
  live mid-month has a real short month, not a missing one.

Related: [[project_residency_read_rules]], [[feedback_verify_the_column_is_written]].
