---
name: wait-for-reply-does-not-mute-coworker
description: A parked wait_for_reply captures the reply for no_reply gating but does not mute the SMS coworker unless the flow set suppressDefaultReply
metadata:
  type: project
---

A `wait_for_reply` resume used to stamp `sms_inbound_jobs.suppress_reply`
unconditionally, the same as `options.suppressDefaultReply`. That is wrong
for a silence-nudge cadence: the wait is a timeout so remaining nudges skip,
not a claim on the conversational turn.

KIN 2026-09-02: a lead replied that they had booked but were unsure of the
time. Auto-reply was on. The inbound job closed `suppressed_by_ai_flow`.
The flow skipped the owner "personal touch" alert (that fires only on
`no_reply`) and completed the `replied` goal. Nobody answered. Kingsley's
plan, in the tenant dossier and in coworker knowledge, is: nudge only while
they stay quiet; if they reply, the coworker takes over.

**The contract:** `resumeAwaitingReplyRun` in
`supabase/functions/_shared/ai_flows/wait_reply_resume.ts` still captures
the text and skips trigger evaluation (do not start a fresh run). It sets
`suppressCoworker` only when a resumed flow's `definition.options.suppressDefaultReply`
is true. Cadence waits leave that flag off. Classify-then-ack flows (Truly
renewal, realtor lead-source) set it so the flow's own next customer text
is not doubled by the coworker.

A flow-options read failure fails CLOSED (mute), because a realtor-style
flow that sends its own ack must not double-text on a blip. If that lookup
throws after the wait was already re-queued, the helper still returns the
resumed ids (skip trigger evaluation) and mutes: returning empty would
start a second run and fail-open the mute.

Staff wait-resume (an employee testing a flow from their own phone) still
persists a suppressed audit row: that inbound is not a customer turn.

**How to apply:** do not re-teach the compiler or the inbound comments that
a parked wait owns the coworker turn. The compile prompt and the wait step
docs now say the coworker still replies unless `suppressDefaultReply`. See
[[feedback_live_flow_source_of_truth]] for reading the live flag, not the
builder.
