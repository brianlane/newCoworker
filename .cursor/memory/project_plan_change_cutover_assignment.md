---
name: project-plan-change-cutover-assignment
description: A paid plan change must not pool the live box unless a different VM is assigned in inventory and the voice bridge is heartbeating; businesses.tier must be written both directions
metadata:
  type: project
---

KIN 2026-09-18 (`a912aff5-dd87-49fb-ad6a-477acefb66c0`): paid Standard → Starter. `upgrade_switch` returned vm 1936826 to the pool (~8:25 AM PT) while `businesses.hostinger_vps_id` still pointed at it, `businesses.tier` stayed `standard`, and no inventory row was assigned. Voice-bridge last heartbeat 2026-09-18T15:24:37Z; inbound calls failed. The worker had started at 8:24:46 with no assigned box.

Brian 2026-09-18: do not release or replace a tenant's box while that box
still has paid Hostinger time (`vps_inventory.expires_at` in the future).
KIN's kvm2 (vm 1936826) had `expires_at` 2026-09-28 and was still pooled
by `upgrade_switch`. Entitlements (`businesses.tier`) still flip immediately.
Hardware moves only when that paid-through instant is at or past now, and
only then if size changes or a same-tier term alignment needs a newly
bought box. Unknown expiry fails toward keep.

Rules that must hold on upgrade, downgrade, and same-size moves:

1. `boxHasPaidTimeLeft` / `shouldMigrateHardwareForPlanChange`: a live box
   with prepaid time is never replaced. Term alignment and size changes wait
   until lapse (the same `expires_at` signal the pool already uses).
2. Never `releaseVpsToPool` unless `isReplacementVm` (new id !== old id),
   inventory `state=assigned` to this business, deploy did not fail, the
   voice bridge heartbeat is healthy, AND the old box's paid-through is
   at/past now.
3. Write `businesses.tier` via `updateBusinessEntitlementTier` (`.select()`
   read-back) as soon as the new subscription row exists, both directions.
4. Log `changePlan: complete` only when the tier write landed, a box is
   actually assigned, and the bridge is heartbeating.
5. Generic heal (`healPlanChangeAftereffects`, provisioning-retry every
   5 min): copy live `subscriptions.tier` onto `businesses.tier`; if the
   business points at a numeric VM with zero assigned inventory and that
   inventory row is `available`, `claimSpecificAvailableVps` (never steal
   a row assigned to someone else), start the VM, wait for a heartbeat.
   No hardcoded business id. A failed tier sync must not skip the reclaim.

Related: [[project_change_plan_deleted_webhook_ordering]], [[project_orchestrate_input_rebuilt_field_by_field]].
