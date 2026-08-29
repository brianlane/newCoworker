---
name: project_sms_segment_cliff_invisible_chars
description: "One invisible U+202F from Intl's time format doubled the SMS bill on every text that names a time; FIXED Aug 29 in #1741 (867 segments, 8.2% of all outbound), emoji policy is deliberate, owner alerts left alone on purpose"
metadata: 
  node_type: memory
  type: project
  originSessionId: 238c3b5b-3c06-4484-86b9-226a2adbc467
  modified: 2026-08-29T10:05:00.000Z
---

Found 2026-08-28 while tracing Telnyx $30.78 (Jul) -> $50.95 (Aug 1-28).
**FIXED 2026-08-29 in #1741.**

**The cliff.** A carrier bills SMS in segments: 153 characters each in GSM-7,
**67** once any character falls outside it and the whole message re-encodes as
UCS-2. One invisible character therefore roughly doubles a long message's
price with no visible change. `smsSegmentInfo` in `src/lib/sms/segment-info.ts`
is the shared calculator (any non-ASCII forces UCS-2); do not hand-roll a
second one.

**The bug: U+202F.** `Intl.DateTimeFormat("en-US", {hour12: true})` puts a
NARROW NO-BREAK SPACE between the time and "PM", so `8:29 PM` carries it and
every message quoting a clock time is UCS-2. Node's ICU locally emits a plain
U+20, so this reproduces ONLY against real sent bodies in `sms_outbound_log`,
never in a local console.

**Measured, whole fleet, Jun 1 to Aug 29 2026** (replayed through the real
`gsmSafeSmsText`, not a hand-rolled regex): **867 segments, 8.2% of every
outbound SMS segment**. 250 of 2,882 sends were non-GSM for U+202F alone.
By source: agent_offer 778, owner_notify 56, owner_alert 30, owner_manual 3.

**The two halves of the leak (both shipped in #1741).**

1. `GSM_UNSAFE_SPACES` in `_shared/ai_flows/compliance.ts` now covers the whole
   visible-width space family (`   -   　`),
   not just NBSP. Every AiFlow send has always run through `gsmSafeSmsText`, so
   this is where the 867 segments actually live.

2. **The texting coworker never called that function at all**, so half 1 alone
   would not have reached it. Both its outputs now do:
   - live replies: `reply = gsmSafeSmsText(reply)` in `sms-inbound-worker`,
     placed BEFORE `replyUnits` so the metered units describe the wire;
   - queued reminders: `dispatchBody()` in `_shared/scheduled_sms.ts`, gated on
     `created_by === 'sms_coworker'`.
   Worth only 5 segments on three months of real replies. That is the honest
   number: it is a guard on an unguarded path, not a saving.

**Zero-width characters are deliberately NOT in the table.** U+200D joins the
people in a family emoji, U+200C separates letters in Persian and Indic
scripts. Deleting them corrupts content `gsmSafeSmsText` otherwise preserves.

**Owner text is deliberately left verbatim.** A `scheduled_sms` row with
`created_by = 'owner'` (dashboard "Send later") is NOT normalized: the composer
already warns about encoding as they type (`SmsSegmentHint` mode="verbatim"),
and rewriting someone's own words is a product decision, not an encoding fix.
Same reason `owner_alert` was left alone: its 30 segments come from em dashes
and smart quotes inside CUSTOMER text the alert quotes back ("Tim texted
back: ..."), and normalizing changes what the owner is shown someone said.

**The emoji is NOT the same kind of problem.** `gsmSafeSmsText` deliberately
KEEPS emoji whenever the message is deliverable as UCS-2 (<=670 chars). That is
a documented deliverability policy, not an oversight, and it is why the coworker
replies show almost no savings: their non-GSM characters are ✨📋🏡😊, which the
function is supposed to keep.

**Two copies, one table.** `gsmSafeSpaces` in `src/lib/sms/segment-info.ts`
mirrors the Edge table (the Deno module cannot be imported by the dashboard
bundle). If they drift, the composer's segment hint quotes owners a different
number than the carrier bills. `tests/sms-segment-info.test.ts` sweeps the whole
BMP and fails on drift in either direction; verified it discriminates by
shrinking one copy and watching it list the 13 missing codepoints.

**How to measure any of this**: replay real bodies through the real function,
never templates and never a hand-rolled regex. My first pass used a regex typed
into a heredoc, the escape got mangled, and it reported 0 savings on data that
actually had 867. `sms_outbound_log.body` holds what was sent;
`sms_inbound_jobs.assistant_reply_text` holds coworker replies.

Related: [[project_telnyx_billing_model_traps]],
[[project_weighted_sms_metering]], [[feedback_check_for_a_shared_mechanism_first]],
[[project_schedule_text_tool]], [[feedback_assert_the_producer_not_the_fixture]].
