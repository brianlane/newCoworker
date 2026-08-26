---
name: busy-flag-convention-aug19
description: "Availability convention since PR #1541 - the Busy/Free flag decides, OOO always blocks, time-off mirror writes Busy"
metadata: 
  node_type: memory
  type: project
  originSessionId: 77b7c1bb-f9b7-4762-90c8-4bd932a115a2
  modified: 2026-08-20T04:31:44.539Z
---

Availability convention (founder decision, Aug 19 2026, PR #1541): **an event's Busy/Free flag decides whether it blocks booking availability, and a real out-of-office event always blocks.** Chosen OVER "every all-day event blocks": Google silently defaults all-day events to Free, so a plain all-day "OOO" banner does NOT block until marked Busy or recreated as a real Out-of-office event. Decorative Free reminders must never close a day.

Mechanics in `getWorkspaceBusyBlocks` (src/lib/calendar-tools/handlers.ts):
- Google freeBusy only reports opaque spans; `readGoogleOutOfOfficeBusy` supplements it with `events.list eventTypes=outOfOffice` (SERVER-side filter, or timed meetings starve the page budget: Bugbot round 1). Failure degrades to `complete: false`, never null.
- Microsoft: `showAs`/getSchedule `status` free+workingElsewhere are dropped; oof blocks.
- `zonedMidnightUtc` converts date-form events at business-local midnights.

The platform's own time-off mirror (`mirrorTimeOffEvent`, shared-calendar.ts) writes **Busy** (`transparency: "opaque"` / Graph `showAs: "oof"`) since #1541; it was transparent "display-only" before, which is why roster time off never blocked the booking page (the original bug report's banner was the product's own mirror). Mirrors predating the fix were re-marked by `scripts/oneshot/opaque-time-off-mirrors.ts` (applied Aug 19, 3 events, 2 tenants).

**Why:** availability disputes about all-day/OOO events should be answered from this convention, not re-litigated per surface.
**How to apply:** any new availability consumer or provider path must honor the flag + always-block-OOO pair; never special-case all-day events as busy. Note one member's time off now blocks the WHOLE page via shared-calendar freeBusy (consistent with bookings there); per-member refinement stays in [[route-to-team-rotation-vs-broadcast]]-style roster machinery.
