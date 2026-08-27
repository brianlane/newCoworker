---
name: project_aiflow_phone_field_trap
description: AiFlow extraction fields named with a phone token get their values validated as phone numbers; naming a gate field phone_* silently blanks it
metadata: 
  node_type: memory
  type: project
  originSessionId: 5e776f31-fee0-424f-b8c4-a0ed5c90c13a
  modified: 2026-07-31T23:47:57.141Z
---

In the New Coworker AiFlow engine, `isPhoneFieldName` matches a phone token
ANYWHERE in an extraction field's name, and the worker runs
`sanitizeExtractedPhone` on any field it matches. Any non-phone value in such a
field becomes the string `"none"`, which silently kills every `when` guard
reading it.

This shipped as PR #885 (2026-07-24) and broke Amy Laidlaw's ReferralExchange
routing for 8 days: `phone_lead_type` held buyer/seller/both, so all three
`route_to_team` steps skipped and 11 leads were texted but never offered to her
team. Fixed in PR #1076 by `postProcessExtractedField`, which only validates a
value that contains a digit.

**Why:** `isPhoneFieldName` is deliberately loose because its real job is the
"fill an empty phone field from the page text" fallback, where a false positive
is harmless. It is also used by lead ingestion (`src/lib/leads/submissions.ts`),
so tightening the predicate is the wrong fix.

**How to apply:** Never name a gate/routing field `phone_*`, `*_phone`, or
`has_phone` unless it holds an actual number. Run
`tsx debug/audit-phone-field-names.ts` before changing anything in phone-field
handling to see which tenant flows it would touch. When a flow step skips
unexpectedly, `tsx debug/flow-run-autopsy.ts <runId> --vars` shows the guard and
the var value side by side. Relates to [[project_newcoworker_oneshot_flow]].
