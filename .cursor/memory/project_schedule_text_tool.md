---
name: project_schedule_text_tool
description: "The texting coworker can queue ONE later text per contact via schedule_text; created_by keeps it off the owner's rows, and the pinned note is how a reschedule finds it"
metadata:
  type: project
---

Shipped Aug 29 2026 (PR #1728), after R V (KYP Ads) was told "I'll make sure
you get a reminder text at 6:30 PM Eastern" and nothing was queued anywhere.

`schedule_text` (sms surface only) writes the SAME `scheduled_sms` queue the
owner's Text history composer uses, dispatched by the scheduled-sms-sweep Edge
cron every minute. Core: `src/lib/sms/schedule-text.ts`.

## The five rules, four of them written by Bugbot

- **Recipient is the conversation.** No path to a third party at all.
- **`created_by` scopes everything.** The queue is SHARED with the owner's
  composer, which stacks freely. Before this column the agent's "one pending
  row for this number" matched an owner-composed send, so a customer asking
  for a reminder would cancel the owner's birthday text and overwrite its body
  and time. The agent only ever reads, moves, or cancels `created_by =
  'sms_coworker'`. Dispatch-log provenance is a join on
  `sms_outbound_log.scheduled_sms_id`, deliberately NOT a new log source.
- **ONE pending row per contact, and it MOVES.** A second schedule inserts the
  replacement FIRST and only then retires the old row: cancel-first meant a
  failed insert left the texter with nothing where they had a standing
  reminder. If the old row will not retire, the new one is retired and the
  tool returns `move_failed` saying the original still stands.
- **Refuses ONCE on `automatic_reminder_exists`**, and only when nothing is
  queued yet. Any enabled AiFlow whose `definition.trigger.on ===
  "event_start"` with `leadMinutes > 0` counts (KYP runs one at 60). Gating on
  `!confirmed` ALONE re-asked a settled question on every reschedule. There is
  NO way to suppress a flow reminder for one contact (it fires off the
  calendar event), so the tool says so and the model must not offer it.
- **The offset on `sendAtIso` is mandatory.** `Date.parse("2026-08-31T18:30:00")`
  is the SERVER's clock, UTC in production, so a 6:30 PM Eastern reminder
  queues four hours early instead of being refused.

## The pin is the tracking mechanism, and it is two-way

What was queued is pinned to the contact, and `contacts.pinned_md` rides the
SMS preamble on every later turn (`buildCustomerPreambleForEdge`), so a
reschedule two days on reads the standing promise rather than remembering it.
There is also already a "Booking status" preamble line carrying reschedules.

The half that is easy to miss: **the owner's cancel button has to retract that
pin**. Flipping the row alone leaves the coworker reading a live promise for a
send the owner deliberately dropped, and it will queue a replacement. The
DELETE route appends a retraction when the row it dropped was the coworker's.

## Other things worth not rediscovering

- Standard/Enterprise only, same `smsToolsAllowedForBusiness` gate as the
  dashboard route. The shared bounds live in `@/lib/plans/sms-tools`
  (`SCHEDULED_SMS_MIN_LEAD_MS`, `SCHEDULED_SMS_MAX_DAYS_AHEAD`).
- The central `scheduled_sms` read trips
  `tests/residency-read-coverage.test.ts`. It is recorded as by-design: the
  purge deletes only TERMINAL rows, this reads only `pending`, and it is the
  read half of a read-modify-write whose write is central. See
  [[project_residency_read_rules]].
- `ok:true` is a QUEUE, not a send. Dispatch-time failures (downgrade,
  opt-out, SMS cap) mark the row canceled/failed later, and Brian's call is
  that this surfaces in the owner's queue rather than being pre-empted.
- The panel labels agent-queued rows "queued by your texting coworker", and
  `created_by` rides the routed box read too, or a residency tenant loses the
  label.

Adding it was the usual four-way parity plus a fleet reseed
([[project_agent_tool_parity_four_way]]); the converge was clean, one tool per
box, no drift riding along. Related: [[project_sms_send_logging_split]],
[[feedback_delivered_is_not_received]].
