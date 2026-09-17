---
name: project-outreach-contacted-intl-phone
description: "Formatted international prospect phones fail the Contacted reconcile if lookup uses isE164 then NANP; coerceDialableE164 must compact a leading-plus first"
metadata:
  type: project
---

HQ Bloom Digital, 2026-09-17. Outbound Prospecting (Grok MCP) drafted
`melissa@gobloomdigital.com` with Places/MCP phone `+61 415 972 868`. Auto
sent at 15:00 UTC. Prospect outreach follow-through filed the contact four
minutes later as `+61415972868` tagged New Lead + prospect. The Contacted
reconcile looks up `prospect.phone` through `fireLifecycleStage`, which used
`isE164(raw) ? raw : normalizeNanpToE164(raw)`. Spaces fail isE164. +61 is
not NANP. Outcome `no_contact` for 30 minutes, then `contacted_stage_at`
stamped and the card stayed in New Lead. Same-batch US numbers moved at
15:05.

The filing path already used `coerceDialableE164` after extract stripped
spaces. The lookup path did not.

Fix: compact separators on a leading `+` inside `coerceDialableE164`, and
route `fireLifecycleStage` / `prospectContactKey` / draft writes through it.
A row already stamped `contacted_stage_at` will not be retried; move the
card with `fireLifecycleStage(compactE164, "contacted")`.
