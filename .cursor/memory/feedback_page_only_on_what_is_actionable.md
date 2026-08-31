---
name: page-only-on-what-is-actionable
description: "An alarm nobody can act on kills the channel it rides on; record the benign thing honestly at a level that is not error"
metadata:
  node_type: memory
  type: feedback
  modified: 2026-08-31T07:00:00.000Z
---

Three alarms fired in one week and all three were noise, in the same way: the
event was real, the description was wrong, and no reader could do anything.

- **Voice.** A caller hanging up mid-ring makes Telnyx refuse our answer with
  code 90018. That was logged `level: "error"`, putting an abandoned ring on
  the admin System Errors card beside expired API keys, and answered HTTP 500,
  asking Telnyx to redeliver a webhook for a call that cannot exist.
- **Watchdog.** `vps-term-renewal-sweep` paged SLOW for a 552s run that had
  SUCCEEDED, and told the operator to "shrink the per-run batch" for a sweep
  that migrates at most one tenant per run.
- **WhatsApp.** KYP's `whatsapp_message_failed` fired daily for a customer-side
  billing block the customer had declined to fix.

The rule that resolved all three: **page on what a human can act on; record
everything else honestly at a level that is not `error`.** The repo already
had this written down and it was worth re-reading rather than re-deriving,
in `stepLogLevel` (`supabase/functions/_shared/system_log.ts`): a retryable
step failure logs `warn`, and only a failure that actually ends the run earns
`error`, because logging the transient ones "pushed the failures that DID end
a run off the list".

**This does NOT contradict [[feedback-delivered-is-not-received]] ("a loud
broken channel beats a silent one"), and the difference is the load-bearing
part.** That rule is about never letting a REAL outage go quiet. This one is
about never spending the alarm on a non-outage. They fail in opposite
directions and the same question separates them: is there an action, and does
anyone here own it? A dead SMS channel has one (call the customer). An
abandoned ring has none. KYP's billing has one, and it is not ours, which is
why the answer there was to switch the channel off and say so in the dossier
rather than to keep paging about it.

Two corollaries, both paid for:

- **Silencing is not the same as hiding.** Every one of the three still
  records: the voice race gets an `info` row and its own telemetry event, the
  sweep keeps a raised SLOW line at 80% of its real budget, and KYP's alerts
  write an honest `skipped` row. Muting a channel that could still work is
  the worse error, which is why the one-shot that turns WhatsApp off carries
  four refusals and no override flag.
- **When the alarm is wrong, check whether the RECORD is wrong too.** Chasing
  the WhatsApp noise is what surfaced twenty notification rows marked `sent`
  for messages Meta had dropped. The false alarm was the cheap half; the
  quiet lie underneath it was the expensive one.

Related: [[project-whatsapp-delivery-truth]],
[[project-cron-timeout-three-layers]], [[feedback-delivered-is-not-received]].
