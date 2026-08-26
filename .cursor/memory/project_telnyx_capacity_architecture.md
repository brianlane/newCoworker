---
name: telnyx-capacity-architecture
description: "Per-tenant Telnyx apps/profiles, the three stacked concurrency limits (min wins), and the capacity defense stack shipped Aug 16 2026"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5dc6ee4d-f476-4bac-b65a-b95c717c4ecd
  modified: 2026-08-17T01:44:43.800Z
---

Telnyx caps concurrent OUTBOUND calls at three layers; the MINIMUM wins: each Call Control app's `outbound.channel_limit`, each outbound voice profile's `concurrent_call_limit`, and the ACCOUNT pool (support-ticket-only, invisible to the API; the granted number lives in admin_platform_settings key `telnyx_capacity`, currently 100 from ticket #582143; env is fallback). The 2026-08-16 incident: the connection sat at 2 while the profile said 10, and the 08:30 Phoenix burst 403'd a lead call.

Since Aug 16 2026 (PRs #1403/#1405/#1406/#1407): every DID tenant has a DEDICATED app + profile named `<name> [nc:<businessId>]` (adopt-by-marker, names clamped to Telnyx's 64-char cap), channel limits = plan `maxConcurrentCalls`, $25/day per-tenant fuse, full whitelist. Provisioning creates them (`ensureTenantVoiceInfra`, injectable like didProvisioner, degrades to the shared platform app on failure); `scripts/oneshot/migrate-tenants-to-dedicated-telnyx-apps.ts` converges existing tenants and re-syncs caps after tier changes. The legacy platform app (2937312861107521228, env `TELNYX_CONNECTION_ID`) holds zero DIDs, kept as HQ/demo/failback default. One webhook URL serves all apps: dispatch routes by dialed number.

Defenses in order: per-tenant carrier caps -> pre-dial fleet gate (`voice_check_availability` p_platform_max_outbound = `TELNYX_ACCOUNT_CHANNEL_LIMIT` - `PLATFORM_OUTBOUND_HEADROOM`(3), counts `voice_reservations.direction='outbound'`) -> capacity-classified 403s defer with jittered backoff ([[telnyx-carrier-capacity-defer]]) -> hourly-deduped admin email + weekly `voice-capacity-monitor` cron that mails a ready-to-send raise ticket.

**Why:** isolation without pool growth adds zero capacity (min rule), so the account raise ticket matters; and per-tenant caps make the "up to 10 concurrent calls" marketing promise carrier-enforced per tenant instead of a shared fiction.

**How to apply:** inspect with `tsx debug/telnyx-capacity.ts` (read-only, all limits + in-flight). After Telnyx grants a raise, ONE row update: jsonb_set on admin_platform_settings key telnyx_capacity; everything derives. Per-tenant dial headroom: business_telnyx_settings.voice_outbound_dial_headroom (default 3, owner-editable on the dashboard phone card) reserves the tenant own lines for transfers/reach legs; the Monday monitor enforces pool >= 2x committed caps. Reach ladder is honest since PR #1411: pre-alerts follow the dial, dials_refused vs nobody_answered. README runbook: "Telnyx outbound call capacity".

## telnyx-carrier-capacity-defer

A Telnyx channel-limit dial rejection (HTTP 403 + "channel limit exceeded", classified by `classifyTelnyxDialFailure` in `_shared/voice_outbound.ts`) or the platform gate's `platform_capacity` refusal returns `error:"capacity"` from originate. `placeAiCallStep` treats it like the budget block: release the dial-ledger lock and DEFER on [2, 5, 12] minutes + up to 90s jitter (counter in `scope.vars` via `capacityRetryCountVar`), re-running window/STOP/dial-cap guards each resume; only after 3 retries does it resolve `not_placed` with reason `carrier_capacity` ("could not call: all phone lines were busy").

**Why:** before this, one capacity blip resolved `not_placed`/`dial_failed`, which cancelled seller-ladder retries (cf_not_placed carries none) and false-alerted the owner "the AI did NOT call". Related trap: [[callWindow skip resolves to not_placed]] is the same sentinel via a different door.

**How to apply:** never gate a flow on distinguishing capacity from config failures by `not_placed` alone; the reason token `carrier_capacity` exists for that. Also: `applyResumeJitter` adds 0..5min to the three WALL-CLOCK resume sites (flow window, callWindow defer, sleep untilTime), so deferred cohorts no longer phase-lock on 08:30:00 Phoenix; duration/date-anchored sleeps stay exact. A capacity rejection creates NO leg, NO CDR, NO webhook: its only traces are the enriched `voice_outbound_dial_failed` telemetry, the systemLog error, and the hourly-deduped admin email.
