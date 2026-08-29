---
name: project_sms_segment_cliff_invisible_chars
description: "One invisible U+202F from Intl's time format doubles the SMS bill on every offer that names a deadline; the emoji policy is deliberate, the space is a bug"
metadata: 
  node_type: memory
  type: project
  originSessionId: 238c3b5b-3c06-4484-86b9-226a2adbc467
  modified: 2026-08-29T05:51:41.615Z
---

Found 2026-08-28 while tracing Telnyx $30.78 (Jul) -> $50.95 (Aug 1-28).

**The cliff.** A carrier bills SMS in segments: 153 characters each in GSM-7,
**67** once any character falls outside it and the whole message re-encodes as
UCS-2. One invisible character therefore roughly doubles a long message's
price with no visible change. `smsSegmentInfo` in `src/lib/sms/segment-info.ts`
is the shared calculator (any non-ASCII forces UCS-2); do not hand-roll a
second one.

**The bug: U+202F.** `formatInTimeZone`
(`supabase/functions/_shared/ai_flows/quiet_hours.ts`) renders
`{{offer.deadline}}` through `Intl.DateTimeFormat("en-US", {hour12: true})`.
Modern ICU puts a NARROW NO-BREAK SPACE (U+202F) between the time and "PM", so
`8:29 PM` carries it. Every `route_to_team` offer that names a deadline is
therefore UCS-2. Measured on Amy's 450 August offer sends: **-475 segments,
$3.99/month for one tenant**, and it hits every tenant. Node's ICU locally
emits a plain U+20, so this reproduces only against real sent bodies in
`sms_outbound_log`, never in a local console.

`gsmSafeSmsText` (`_shared/ai_flows/compliance.ts`) normalizes NBSP (U+00A0)
but NOT U+202F. Its table is the right place to fix it.

**The emoji is NOT the same kind of problem.** `gsmSafeSmsText` deliberately
KEEPS emoji whenever the message is deliverable as UCS-2 (<=670 chars) and
strips them only when keeping them would make the message unsendable. That is
a deliverability policy, documented in the file ("Emoji must never be
downgraded when the message is deliverable with them intact"), not an
oversight. It is also why `FINAL_REMINDER_BANNER` in
`_shared/ai_flows/offer_reminders.ts` costs real money: the banner exists
because asterisks render literally on plain SMS, so changing it is a product
decision (-55 segments, $0.46/mo for Amy).

**How to measure any of this**: replay real bodies, never templates. A
rendered offer is much longer than its template and goes to up to four
teammates. `sms_outbound_log.body` holds exactly what was sent.

Related: [[project_telnyx_billing_model_traps]],
[[project_weighted_sms_metering]], [[feedback_check_for_a_shared_mechanism_first]].
