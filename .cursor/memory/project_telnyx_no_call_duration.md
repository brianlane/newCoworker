---
name: project_telnyx_no_call_duration
description: Telnyx voice hangup webhooks never send call_duration; derive it from end_time - start_time
metadata: 
  node_type: memory
  type: project
  originSessionId: 1853fac1-3d39-4628-a901-cf148cebee2d
  modified: 2026-08-04T01:16:08.993Z
---

Telnyx `call.hangup` / `call.ended` webhooks do **not** carry a
`call_duration` field. They carry `start_time` and `end_time`.

Found Aug 3 2026 while investigating why Amy's plan card read 9 of 250 voice
minutes. `parseCallDurationSeconds` read only `call_duration`, so it returned
null for every call the platform had ever handled. Consequences, both silent:

- `meterForwardedCallSeconds` skipped every forwarded / warm-transferred leg
  with `no_duration`. `voice_forwarded_call_metered` had **zero** telemetry
  rows fleet-wide, ever.
- `voice_settlements.telnyx_reported_duration_seconds` was null on every row
  fleet-wide.

Fixed in PR #1151 (`supabase/functions/_shared/telnyx_call_duration.ts`):
`call_duration` first, then `end_time - start_time`, rejecting negative spans
and anything over 24h rather than clamping. Backfill in PR #1152.

**Why it matters:** if a future feature needs call duration from a Telnyx
webhook, use that shared helper. Do not reach for `payload.call_duration`
again, and do not trust a zero/absent duration to mean a zero-length call.
See [[project_fleet_redeploy_check]] for the related "shipped is not live"
trap.
