# Voice AI rollout runbook

End-to-end procedure for turning on the Telnyx + Gemini Live voice path for a
single business, or for rolling out a change to the voice stack across the
fleet. Pairs with the two tooling scripts we maintain specifically for this:

- `scripts/rollout-verify.ts` — post-call telemetry diff (can be run from any
  workstation with `SUPABASE_SERVICE_ROLE_KEY`).
- `vps/scripts/flip-flags.sh` — idempotent env toggles for the bridge on the
  VPS, and a printer for the Edge-side `supabase secrets set` command.

> **Scope.** This runbook only covers rollout verification. Provisioning a
> new VPS (Hostinger purchase, SSH key, bootstrap) is handled by
> `orchestrateProvisioning` and the preflight script. See
> `scripts/hostinger-preflight.ts` for the upstream smoke test.

---

## 0. Prerequisites

Before you start a rollout:

- [ ] The tenant has a row in `business_telnyx_settings` with
      `telnyx_connection_id`, `telnyx_messaging_profile_id`, and
      `bridge_media_wss_origin` set.
- [ ] There is a `telnyx_voice_routes` row pointing the DID at
      `business_telnyx_settings.bridge_media_wss_origin`.
- [ ] The bridge is deployed via `vps/scripts/deploy-client.sh` and
      `curl https://<bridge-origin>/` returns `voice-bridge ok`.
- [ ] The voice health cron is scheduled (migration
      `20260424000000_schedule_voice_bridge_health_alerts.sql` applied, Vault
      secrets `internal_cron_secret` and `edge_base_url` present).

---

## 1. The two rollout kill switches

The voice path has two independent kill switches, on opposite sides of the
pipe, and they are the focus of every rollout gate.

| Flag                       | Lives on                              | Effect when `false`                                             | How to flip                                                   |
| -------------------------- | ------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| `VOICE_AI_STREAM_ENABLED`  | Supabase Edge (secret)                | `telnyx-voice-inbound` answers with speak-only; NO stream URL   | `supabase secrets set` (see below)                             |
| `GEMINI_LIVE_ENABLED`      | VPS `/opt/voice-bridge/.env`          | Media WS stays up; bridge is silent (no AI audio)               | `sudo vps/scripts/flip-flags.sh --gemini-live on\|off`         |

You almost always want to ramp in this order:

1. **Wire up** — all infra green, both flags off.
2. **Bridge only** — `GEMINI_LIVE_ENABLED=true`, `VOICE_AI_STREAM_ENABLED=false`.
   This exercises the Edge → bridge handshake WITHOUT ever routing real audio
   to Gemini. Test calls hit a speak-only fallback.
3. **Full on** — flip `VOICE_AI_STREAM_ENABLED=true` last.

Rollback is the reverse order.

---

## 2. Flipping the Edge flag (`VOICE_AI_STREAM_ENABLED`)

From your workstation (NOT the VPS):

```bash
export SUPABASE_PROJECT_REF=<your-project-ref>
supabase secrets set --project-ref "$SUPABASE_PROJECT_REF" VOICE_AI_STREAM_ENABLED=true
```

Or print the exact command from the VPS (no secrets leave the VPS; it only
prints the CLI snippet):

```bash
sudo ./flip-flags.sh --stream-enabled on
```

Supabase redeploys affected Edge functions automatically. Give it ~30s before
placing a test call.

---

## 3. Flipping the VPS flag (`GEMINI_LIVE_ENABLED`)

SSH to the VPS (using the per-tenant key retrieved via
`GET /api/admin/vps/[businessId]/ssh-key` — break-glass path) and run:

```bash
sudo /opt/newcoworker-repo/vps/scripts/flip-flags.sh --gemini-live on
# or, if the repo isn't staged at /opt:
sudo ./flip-flags.sh --gemini-live on
```

The script:

- Edits `/opt/voice-bridge/.env` in place (0600, root-owned).
- Is idempotent: if the value didn't change it does NOT restart the container.
- Otherwise calls `docker compose … up -d --force-recreate voice-bridge`.

Check current state:

```bash
sudo ./flip-flags.sh --status
```

---

## 4. Placing the test call

1. Call the tenant's DID from any phone.
2. Let it answer fully (verify you hear the greeting).
3. Say 1–2 sentences. Hang up.
4. Wait ~30s for the settlement sweep to fire (runs every 5 min at worst; most
   calls settle in < 10s via the Telnyx hangup webhook + bridge close).

---

## 5. Verify with `scripts/rollout-verify.ts`

Run from any workstation:

```bash
export NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<service-role-key>

# Check a specific tenant's last 15 minutes (default window):
npx tsx scripts/rollout-verify.ts --business <biz-uuid>

# Narrow to a single DID (useful when multiple tenants share a bridge host):
npx tsx scripts/rollout-verify.ts --business <biz-uuid> --to-e164 +15551234567

# Machine-readable:
npx tsx scripts/rollout-verify.ts --business <biz-uuid> --json

# Widen the window if your test call was > 15m ago:
npx tsx scripts/rollout-verify.ts --business <biz-uuid> --since 1h
```

The script prints one line per check. All green → rollout successful. Any red
line tells you exactly which piece of the chain to inspect next.

Typical green output:

```
[rollout-verify] window 2026-04-20T23:40:00Z → 2026-04-20T23:55:00Z (6/6 checks green)
  [ok]   voice_inbound_stream_answered — found at 2026-04-20T23:47:12Z
  [ok]   voice_rollout_stream_disabled == 0 — rollout flag is on (or not fired)
  [ok]   voice_call_settlement_finalized > 0 — 1 finalized
  [ok]   voice_bridge_health_check is green — stale_bridges=0, stuck_settlements=0 @ …
  [ok]   voice_answer_fail == 0 — no answer failures
  [ok]   edge_webhook_rejected baseline — edge_webhook_rejected=0, telnyx_webhook_signature_reject=0
```

---

## 6. When a check fails

| Failing check                             | Likely cause                                                                  | Next step                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `voice_inbound_stream_answered` missing   | Edge function never saw the call OR Telnyx webhook signature mismatch         | Check Telnyx Mission Control webhooks tab; `telemetry_events` for `edge_webhook_rejected` |
| `voice_rollout_stream_disabled > 0`       | `VOICE_AI_STREAM_ENABLED=false` on Edge                                       | See §2                                                                          |
| `voice_call_settlement_finalized == 0`    | Bridge crashed OR hangup webhook didn't fire                                  | `docker logs voice-bridge`; check `voice_settlements` directly                   |
| `voice_bridge_health_check` missing/red   | Cron not scheduled OR bridge heartbeat broken                                 | See §0; `select * from cron.job where jobname like 'edge-voice-%'`               |
| `voice_answer_fail > 0`                   | Telnyx call-actions API rejected our answer (auth, sim expired, etc.)         | `supabase functions logs telnyx-voice-inbound`                                  |
| `edge_webhook_rejected` elevated          | Bad signature, replayed event, or spoofed origin                              | `select payload from telemetry_events where event_type='edge_webhook_rejected' order by created_at desc limit 20;` |

---

## 7. Post-rollout alerting

The `voice-bridge-health-alerts` Edge cron fires every 5 minutes and pages on:

- Any `business_telnyx_settings.bridge_last_heartbeat_at` older than
  `VOICE_HEALTH_BRIDGE_STALE_SECONDS` (default 300s).
- Any `voice_settlements` row with `finalized_at IS NULL` older than
  `VOICE_HEALTH_SETTLEMENT_STUCK_SECONDS` (default 1800s).

Set `ALERT_WEBHOOK_URL` on the Edge function environment to POST a
Slack-compatible alert on issue-detect. Every run records a
`voice_bridge_health_check` telemetry event whether or not there's an issue,
so you can trend the stale/stuck counts without parsing logs.

---

## 8. Rollback

- `sudo ./flip-flags.sh --gemini-live off` on the VPS (takes ~5s; the bridge
  restarts but in-flight calls fail over cleanly because the media WS closes
  with code 1012).
- `supabase secrets set --project-ref "$SUPABASE_PROJECT_REF" VOICE_AI_STREAM_ENABLED=false`
  (takes ~30s to propagate to Edge).

Rollback never touches the database; telemetry continues recording so you can
verify the traffic actually did drop to speak-only.
