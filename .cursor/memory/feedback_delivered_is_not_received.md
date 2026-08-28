---
name: feedback-delivered-is-not-received
description: "a carrier/provider \"delivered\" receipt proves a device acknowledged, never that the intended person reads it; ask the human"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5bed6e6d-64e7-47ff-9869-624a657957c7
  modified: 2026-08-28T16:15:49.269Z
---

A `delivered` receipt is the strongest signal the transport layer can give,
and it still does not answer "is this person getting our messages?" It means
a device on the network acknowledged the message. It does not mean the
intended person holds that device, still carries that SIM, or ever looks at
it. **No receipt of any kind can close that gap. Only the person can.**

Burned on KYP Ads (2026-08-28). James Lee's roster row held his Hong Kong
number, which our long codes cannot originate SMS to at all, so every team
notify failed loudly with Telnyx 40306. I pulled the delivery receipts for
his Canadian `+15145188192`, saw 16 of 16 owner alerts stamped `delivered`
over 7 days, and presented that as proof the number reached him even while
he was in Hong Kong. Brian had flagged "but James is physically in Hong
Kong" and I answered the flag with the receipts instead of treating it as
the question it was. He then said plainly: **James has no Canadian SIM.**
The repoint had moved a LOUD failure into a SILENT one.

**Why:** this inverts the value of the fix. A failing send raises
`alert_delivery_failed` on the admin System Errors card; a send accepted into
a handset nobody checks raises nothing. Afterwards the tenant looks healthier
while the owner is just as unreachable, which is the exact failure mode
`reportFailedChannels` was written to end ("Recorded is not the same as
noticed"). Same shape as [[hiding-is-not-refusing]] and
[[empty-page-reads-as-nothing-to-do]]: the alarm got disconnected, not the
outage fixed. Related: [[ok-true-is-not-a-commit]] (accepted is not
committed) and [[email-delivery-truth]] / [[whatsapp-delivery-truth]] (an id
back is not delivery). This memory is the rung ABOVE those: delivery itself
is not receipt.

**How to apply:** when the question is "is this person receiving our
notifications", telemetry can only narrow it, never settle it. Check whether
they ever REPLY on the channel. On KYP the last inbound from that number
was 2026-07-24, six days before James asked to switch his number, and
nothing arrived across the 35 days and ~200 sends since, every one of which
came back `delivered`. Last-inbound outranks any delivery receipt, and when a human who knows them raises a
doubt about reachability, treat that as authoritative over any receipt and
ask before acting. Before "fixing" a channel by repointing it, ask which
direction the change moves the failure on the loud/silent axis: a loud
broken channel beats a silent one, and swapping toward silence needs a
positive reason, not just a greener dashboard. State the residual doubt in
the writeup instead of resolving it with data that cannot resolve it.
