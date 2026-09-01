---
name: voice-caller-hangup-race
description: "Telnyx 90018 on answer means the caller hung up mid-ring: a race, not a fault. Logged info + telemetry voice_answer_caller_gone + HTTP 200, never error/500"
metadata:
  node_type: memory
  type: project
  modified: 2026-08-31T07:00:00.000Z
---

Telnyx delivers `call.initiated` while the phone is still RINGING. A caller
who changes their mind ends the call before our answer lands, and the
`/actions/answer` POST comes back **HTTP 422, code 90018, "Call has already
ended"**.

Nothing is wrong when this happens and nobody was let down: there was never a
conversation to miss. Amy Laidlaw's line produced the first recorded one on
2026-08-30 08:23:50Z, and the timing says it plainly: the `voice_reservations`
row was written at 08:23:50.432Z and Telnyx refused the answer 335ms later.
The reservation released correctly (`state: released`) and no transcript row
was ever created.

**It was recorded as an outage anyway, two ways, both fixed in PR #1759:**

- `level: "error"` on a `voice_answer_failed` system log, which puts an
  abandoned ring on the admin System Errors card beside expired API keys and
  dead SIP credentials. Now `level: "info"`, event
  `voice_caller_hung_up_before_answer`.
- HTTP **500** back to Telnyx, which invites redelivery of a webhook for a
  call that cannot exist. Now **200**, since the reservation and the AI-budget
  hold are already released and there is no work left to retry.

Telemetry is counted separately as `voice_answer_caller_gone` rather than
`voice_answer_fail`, deliberately: `scripts/rollout-verify.ts` asserts
`voice_answer_fail == 0`, and folding a hangup in there would make that check
mean "nobody hung up early" instead of "answering works".

**The classifier keys on the CODE, not the status.**
`isCallAlreadyEndedResponse` in
`supabase/functions/_shared/telnyx_call_actions.ts`, imported directly by
vitest. 422 alone also covers real rejections (bad stream URL, malformed
body) that must keep failing loudly, and a 5xx is never treated as benign
whatever body it carries: an upstream failure mentioning the code is not
evidence the call ended. An unparseable or unexpected body fails toward the
loud path.

**How to apply:** a single `voice_answer_failed` row is not automatically an
incident. Read the code. Check the reservation's `created_at` against the log
stamp; a sub-second gap is the caller, not us. Recurrence is what would matter
(a spike means something is slowing the webhook into the ring window), so
count `voice_answer_caller_gone` over time rather than reacting to one.
