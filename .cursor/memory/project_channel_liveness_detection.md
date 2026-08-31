---
name: channel-liveness-detection
description: "the daily check that asks whether a HUMAN is still on an alert channel; per-channel signals, the three traps that made naive versions wrong, and the thresholds"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0012e574-c32a-4742-9018-a0b4061729d8
  modified: 2026-08-28T19:41:02.445Z
---

Shipped 2026-08-28 (PR #1711, merge `8d4976f38`). `channel-liveness-sweep`
runs daily 06:41 UTC and raises an admin `system_logs` row per tenant whose
alert audience has gone quiet. Read-only twin: `tsx
debug/channel-liveness-report.ts [--business <uuid>] [--unhealthy-only]
[--json]`.

**Why it exists:** dispatch records that a SEND worked; nothing recorded that
a PERSON was there. See [[delivered-is-not-received]]. First live run: 1
finding fleet-wide (KYP Ads degraded), 0 false positives.

**Shape.** `channel-liveness.ts` is pure judgement.
`channel-liveness-read.ts` gathers evidence and judges the fleet and imports
no writer at all, so read-only is a property of the file; both the sweep and
the debug report call its `reportChannelLiveness`, so the operator's report
can never disagree with the alarm. `channel-liveness-sweep.ts` adds only the
writing.

**Per channel, the human signal:** sms = `sms_inbound_jobs.staff_kind in
(owner,team)` OR an owner tap in `notification_link_clicks`; whatsapp =
`messenger_conversations.last_user_message_at`; slack =
`slack_conversations.last_user_message_at`; dashboard =
`notifications.read_at` with `read_by_actor <> admin`; email = receipts only.

**Three traps, each found by running it against the fleet, not by reading
the schema:**

1. **Email cannot be reply-judged.** Owners never answer alert mail; every
   inbound `email_log` row fleet-wide is vendor mail (Telnyx, Hostinger,
   Zapier). A uniform reply rule called email dead on 9 of 11 tenants. Email
   is judged on bounces, and answers `undecidable` while the window predates
   `recordNotificationEmail` (live 2026-08-26T05:37:47Z).
2. **The WhatsApp signal must be the OWNER's thread**, matched by `psid`
   (E.164 digits, no `+`). KYP has 5 threads, 4 leads; the newest lead
   message is hours old while the owner's own thread carries the literal
   epoch `1970-01-01T00:00:00+00:00` (= never). Reading "newest thread"
   reports WhatsApp LIVE on the one tenant whose WhatsApp is dead on 131042.
3. **Link clicks must exclude `likely_prefetch`.** Preview cards and carrier
   scanners fetch every link seconds after delivery, so counting them
   manufactures a permanent liveness signal for a channel nobody reads.

**`neq` is NULL-unsafe and it nearly shipped** (Bugbot, High, PR #1711).
`read_by_actor <> 'admin'` is NULL, not TRUE, for a NULL actor, so PostgREST
drops every pre-migration row. Measured live: KYP `isdistinct=5 neq=0`, Amy
`isdistinct=89 neq=0`: Amy would have become a NEW false degraded alert.
Use `.filter(col,"isdistinct",val)`. The unit tests could not catch it: the
PostgREST double returns the fixture regardless of filters, so a row-level
assertion passes under both operators. Assert the OPERATOR there.

**Thresholds (calibrated, not guessed).** Floor: 10 sends/30d before a
channel is judgeable: 6 of 11 tenants send 1-3 alerts a month and would
otherwise read dark forever. Silence: 21d for sms/whatsapp/dashboard; **30d
for slack** because the only Slack signal is the owner POSTING and New
Coworker's owner (the sole healthy Slack tenant) sits at ~17.5d, which 21d
would leave 3 days from tripping.

**States:** `dark` (a channel silent, none live) = error row, call the
customer. `degraded` (silent beside a live one) = warn. `undecidable` and
`unused` count as neither, so they can neither darken nor rescue a tenant.

**A `vps` residency tenant is SKIPPED, never judged**, and the skip is
reported: `notifications`/`email_log` are centrally purged and the purge
removes READ notifications first, so a central read is thinned in exactly
the direction this measures. Zero tenants are `vps` today.

Admin-only: `system_logs` under `source: "notifications"`, which the tenant
dashboard's `source: "aiflow"` filter never returns.
