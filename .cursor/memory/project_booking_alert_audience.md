---
name: project_booking_alert_audience
description: "unassigned_booking_alerts is misnamed: it fires on EVERY booking, not just unowned ones; employee recipients added Aug 17 2026"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8dcda517-09ad-41db-9cef-57a78776ed70
  modified: 2026-08-18T01:57:20.593Z
---

`maybeAlertUnassignedBooking`
(`src/lib/calendar-tools/unassigned-booking-alert.ts`) does NOT only alert on
unowned bookings. It resolves an ownership state and dispatches on all three:

- `solo` (no active roster) -> `sent_solo`
- `covered` (an assignee or contact owner exists) -> `sent_covered`
- `unowned` (a roster exists, nobody holds it) -> `sent_unowned`

Only `unowned` uses notification kind `unassigned_booking`; the other two use
`assigned_booking`. **The flag name `unassigned_booking_alerts` is the
misleading part.** Before promising a tenant "notify me on all bookings",
check whether it is already satisfied: usually it is.

**Who it reaches.** Owner only, by design. The dispatch call carries no
top-level `contactE164` on purpose. PR #1441 added the audience preference:
`notification_preferences.booking_alert_audience` (`owner` default /
`employees` / `both`) and `booking_alert_member_ids` (null or empty = every
active member). The employee leg is an SMS; recipient choice is a pure module
(`booking-alert-recipients.ts`) so it is testable without Supabase or Telnyx.

**Producers are narrower than they look.** Only these call sites pass an
`alertSurface`: voice, sms, webchat (`calendar-tools/handlers.ts`) and the
booking page (which fires its own). `src/app/api/rowboat/tool-call/route.ts`
passes `{}` when `bookSurface === "dashboard"`, so **dashboard/MCP bookings
never alert**. Combine that with a tenant whose `calendar_book_appointment` is
off on the customer-facing channels and the booking page is the ONLY producer.
That is Amy's situation: see [[project_amy_followup_cadence_rules]].

Related: [[project_agent_tool_toggles_are_per_channel]] (a missing
agent_tool_settings row means ENABLED, so read the rows, do not assume).
