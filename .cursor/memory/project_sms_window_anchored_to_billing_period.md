---
name: project_sms_window_anchored_to_billing_period
description: "SHIPPED Aug 21 2026 (PR #1580, merge c01c650c7) - SMS quota window moved from UTC calendar month to the Stripe-anchored month; sms_billing_window_start is the single definition; changeover floor to delete after 2026-09-30"
metadata:
  node_type: memory
  type: project
---

Texts used to be metered per UTC CALENDAR month
(`date_trunc('month', now())`) while voice minutes and the AI chat budget
already reset on the month-window anchored to
`subscriptions.stripe_current_period_start`. A tenant therefore had two
different reset days and the billing page showed neither. SHIPPED Aug 21 2026 (PR #1580, merge c01c650c7; verified live: every active
tenant's window_start read 2026-08-21 on deploy day). It moved
texts onto the same anchor so there is ONE reset date, and put it on every
usage tile.

**`sms_billing_window_start(business_id) returns date` is the single
definition.** Everything reads it: `check_sms_monthly_limit`,
`meter_sms_operational_send`, `try_reserve_sms_outbound_slot`, and
`sms_billing_window_usage` (which the billing page, the dashboard,
`checkLimitReached` and the auto-reload sweep call). The displayed number is
produced by the same expression that refuses a send, so display and
enforcement cannot drift. Do not reimplement the window in TS.

**Day granularity is forced by the ledger.** `daily_usage` is keyed by
`usage_date` (a DATE), so a boundary can only fall on a date; the window
start is the DATE of the anchored instant. Texts roll at 00:00 and voice at
the anchor's time-of-day on the same day. Both render as one date.

**Traps:**
- Two fallbacks return the calendar month, both deliberate: no subscription
  anchor at all, and an anchor in the FUTURE (scheduled plan change or early
  webhook). The future case is a cap hole if you "fix" it to return the
  anchor date: the window has not started, every `usage_date >= start` sum is
  empty, and the tenant texts uncapped until the date arrives.
- There is a self-retiring changeover branch: while a tenant's anchored start
  predates 2026-08-21 they keep the calendar window. Flipping mid-cycle
  otherwise either drags pre-change sends into the new window (blocking texts
  on deploy) or drops them (usage reads zero, second allowance). **Safe to
  delete after 2026-09-30.**
- The metering RPCs now return `window_start`; `smsCapPeriodKey(windowStart)`
  keys the once-per-period cap alert off it. Deriving that key from `now`
  re-alerts on the 1st inside one window and goes silent through the real
  reset.
- Auto-reload's SPEND ceiling followed on Aug 23 2026 (PR #1588, merge
  bffe85e37). Leaving it on the calendar month was wrong: a tenant whose
  anniversary is not the 1st had one allowance window spanning TWO spend
  windows, so a "$100/month" ceiling authorized $200 of card charges in one
  allowance period. `usage_pack_auto_reload_claim` now keys on the anchored
  window. `autoReloadMonthKey` is deleted. The migration re-keys live rows so
  spend carries forward rather than handing everyone a fresh ceiling on
  deploy day (over-counting for one window stops charging SOONER, the safe
  direction for money).
- `billing_usage_window_start(uuid)` is the CANONICAL window name;
  `sms_billing_window_start` is the original implementation it delegates to,
  kept so the three SMS enforcement bodies did not need re-emitting.
- LATENT BUG found by Bugbot in #1588 and fixed there: the claim path returns
  'disabled' on `paused_at` BEFORE comparing the window key, so a ceiling
  pause never cleared and one hit disabled auto-reload permanently. Now
  released on rollover; `authentication_required` deliberately does NOT
  auto-clear.
- `getCalendarMonthUsageTotals` was deleted (last caller gone). The fleet
  rollups (`getFleetCalendarMonthUsage*`) are platform-cost estimates and
  correctly remain calendar-month.

Related: [[project_weighted_sms_metering]], [[project_cron_timeout_three_layers]].
