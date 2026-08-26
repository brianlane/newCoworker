---
name: project-fixed-future-date-is-a-time-bomb
description: A hardcoded future timestamp in a test expires and takes main red forever; anchor slot/booking times to now instead
metadata: 
  node_type: memory
  type: project
  originSessionId: 08cb847f-efb9-4fa8-b371-60dedfb536ae
  modified: 2026-08-12T16:19:23.642Z
---

A test that hardcodes an absolute future instant has an expiry date, and
main goes red on that date with no code change to blame.

Aug 12 2026: `tests/worker-integration/booking-page-booking-alert.itest.ts`
booked `START_ISO = "2026-08-12T15:00:00.000Z"`. The page seeds
`min_notice_minutes: 120`, so `computePublicSlots` stopped offering the slot
at 13:00 UTC that day, `submitPublicBooking`'s re-verify returned
`slot_taken`, and all 7 tests failed at once. The failure landed on PR #1329,
which changed only `docs/CHATGPT-APP.md`. Fixed in PR #1330.

**Why:** the original comment argued the opposite ("Fixed, not relative: a
date that drifts with the clock is a flaky test waiting to happen"). Removing
the flake introduced a hard expiry, which is strictly worse: permanent, and
it blocks every deploy rather than one run.

**How to apply:** when a test needs a bookable time, compute it from
`Date.now()` and pin the properties the test actually needs (weekday, inside
business hours, past `min_notice_minutes`, inside `max_advance_days`), then
sweep the helper across a year of hourly start times to prove it. Suspect
this first when a whole itest file fails together on a docs-only PR: compare
the last passing run's clock time against the constant. A sibling file
hardcoding a date is only a bomb if that value is compared to the clock;
`unassigned-booking-alert.itest.ts` hardcodes one that is merely rendered,
so it is fine. See [[project-pr-checks-appear-in-waves]].
