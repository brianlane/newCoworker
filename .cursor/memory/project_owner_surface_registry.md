---
name: owner-surface-registry
description: "Adding a coworker surface is one registry entry plus a caller; staff mode is per surface and OFF means silent, never customer"
metadata:
  type: project
---

Shipped 2026-08-26 (PRs #1629, #1632). `src/lib/owner-surfaces/` is now the
single place a coworker surface is defined.

**Adding a surface** = an entry in `registry.ts` (identity: labels, plus
`flowEditSource` / `customTableSource` / `changeNoticeLabel` / `historyLabel`)
and, if it runs an owner turn, one in `turn-surfaces.ts` (persona, prompt
block, budget, gates channel). Tests refuse a half-filled entry. Before this,
those four provenance strings lived in four files that could not see each
other, and Slack had to edit all four by hand.

**Two fail directions, deliberately opposite, and easy to get backwards:**
- `resolveSurfaceSpeaker` (speaker.ts) fails CLOSED: uncertain means
  `customer`, because guessing "owner" hands out send_sms, roster CRUD, and
  flow edits. It is also stricter than `_shared/ai_flows/staff_numbers.ts` on
  deactivated roster rows (that module counts them as staff so nothing dials
  them; here they are customers).
- `staffModeEnabled` (staff-mode.ts) fails OPEN: a blip must not silence the
  owner.

For the closed direction to mean anything the reads must be LOUD. Bugbot
caught that `businessOwnerNumbers` swallows PostgREST errors into `[]`, which
would classify the owner as a customer AND report `readFailed: false`. Use
`businessOwnerNumbersResult` / `ownerNumbersOrThrow`, never the bare form,
wherever the answer decides ACCESS. See [[feedback-verify-the-column-is-written]].

**Staff mode semantics:** `public.coworker_staff_mode`, one row per
(business, surface), missing row = enabled. ON = answer them as staff. OFF =
do not answer them there. NEVER "answer them as a customer". Settings >
Coworker renders a switch per registered surface from the registry.
`business_telnyx_settings.staff_sms_assistant_reply_enabled` is SUPERSEDED
and has no readers; the SMS webhook reads the new table.

No CHECK constraint on `surface_key` on purpose: the app validates against
the registry so adding a surface needs no migration.
