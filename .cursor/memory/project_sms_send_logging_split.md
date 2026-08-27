---
name: sms-send-logging-split
description: Worker-generated SMS replies are NOT in sms_outbound_log; they live in sms_inbound_jobs.assistant_reply_text
metadata: 
  node_type: memory
  type: project
  originSessionId: b59ec4b9-01b8-4bc1-8f5c-2729fd0f5600
  modified: 2026-08-07T18:46:38.762Z
---

The two outbound-SMS records are split by producer, and querying only one
makes half the traffic invisible:

- `sms_outbound_log`: flow sends, composer sends, owner alerts
  (`source='owner_alert'`), MCP sends. NOT the coworker's generated replies.
- `sms_inbound_jobs.assistant_reply_text` (+ `telnyx_outbound_message_id`):
  the generated reply to each inbound job. `loadLatestAssistantMessage` in
  sms-inbound-worker reads BOTH for exactly this reason.

**Why:** During the 2026-08-07 HomeLight bot-vs-bot loop on Amy's account,
`sms_outbound_log` showed only the 17 owner alerts; the 16 robot replies
that DROVE the loop were only visible in the jobs table, which briefly made
it look like we were not texting the bot at all.

**How to apply:** Auditing "what did we send this number" needs both
queries. The reply-flood circuit breaker (PR #1239) counts
`assistant_reply_text` rows for this reason. Related: [[feedback-research-before-asking]].
