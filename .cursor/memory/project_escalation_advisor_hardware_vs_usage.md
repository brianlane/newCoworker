---
name: project-escalation-advisor-hardware-vs-usage
description: "The hardware-escalation advisor conflated Stripe entitlements with machine load; rewritten Aug 21 2026 into hardware vs usage sections with real CPU/memory signals"
metadata:
  node_type: memory
  type: project
---

The daily `hardware-escalation-advisor` cron used to recommend a bigger box
for ANY signal, including two that measure a billing entitlement rather than
a machine. `voice_volume` fires at 80% of the tier's INCLUDED voice pool, so
on 2026-08-21 ops was told to escalate Amy kvm2 -> kvm4 for "~219 voice
min/month (250 included)" while her box showed peak concurrency 2 of 10,
zero on-box errors, loadavg 0.07 across 2 cores, and 4485 MiB free of 7940.
Reloadable packs make that reading wrong outright, and running OUT of
minutes makes a box do LESS work (calls get refused).

Rewritten in PR #1577 (with #1575 and #1576 as groundwork):

- Signals carry a category. Only **hardware** produces a rung and the
  migrate-size link; **usage** links to billing.
- New hardware signals: `cpu_saturation` and `memory_pressure` from the
  heartbeat's hourly `vps_posture_reports.metrics`, normalized PER CORE, and
  `local_model_fallback`, which fires on ONE turn.
- Both usage signals now count `voice_bonus_grants` / `sms_bonus_grants` and
  are suppressed when auto-reload is armed on an un-revoked card.
- `sms_volume` moved from `daily_usage.sms_sent` (messages) to
  `sms_text_units` (carrier parts). It had been firing ~2.5x too late.

**The AI budget is the ONE budget with a real hardware consequence.** Over
cap, `pickSmsTurn` routes SMS, owner chat, and webchat to the local twin
agents (`CoworkerLocal` / `OwnerCoworkerLocal` / `WebchatCoworkerLocal`), so
work moves onto the tenant's own vCPUs. Both surfaces were moved OFF that
model for being unusable. On kvm1 there is no local model and the turn is
REFUSED, so the customer gets silence.

As of Aug 21 2026 the fuse had never tripped in production: zero
`owner_chat_model_spend` rows with `fuse_tripped_at`, zero
`ai_reply_reasoning` rows with `model = 'local'`.

**How to apply:** when a signal claims a tenant needs hardware, check what
it actually measured. A fraction of a plan allowance is not a machine
reading. Related: [[project-ollama-context-length-fleet-gap]],
[[project-fleet-redeploy-check]].
