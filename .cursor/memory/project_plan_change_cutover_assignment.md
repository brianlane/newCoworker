---
name: project-plan-change-cutover-assignment
description: A paid plan change must not pool the live box unless a different VM is assigned in inventory and the voice bridge is heartbeating; businesses.tier must be written both directions
metadata:
  type: project
---

KIN 2026-09-18 (`a912aff5-dd87-49fb-ad6a-477acefb66c0`): paid Standard → Starter. `upgrade_switch` returned vm 1936826 to the pool (~8:25 AM PT) while `businesses.hostinger_vps_id` still pointed at it, `businesses.tier` stayed `standard`, and no inventory row was assigned. Voice-bridge last heartbeat 2026-09-18T15:24:37Z; inbound calls failed. The worker had started at 8:24:46 with no assigned box.

Wrong guess, discarded: "the bridge didn't restart on the same box." Live truth was: the old box was pooled and nothing replaced it.

Root cause in `runChangePlanFromCheckout`: `migrateVps = !sameTier` moved hardware even when resolved size was unchanged (kvm2 pin). adopt-first then returned the tenant's already-assigned same-plan box (`claimOwnAssignedVps`), deploy-client recreated it, and step 7 `stopVirtualMachine` + `releaseVpsToPool` ran on that same id. `releaseVpsToPool` un-assigns with no ownership check (see [[project_vps_inventory_write_traps]]). Entitlement gates read `businesses.tier`, which change-plan never wrote.

Rules that must hold on upgrade, downgrade, and same-size moves:

1. `shouldMigrateHardwareForPlanChange`: term alignment always migrates; otherwise migrate only when resolved size changes. Pins win, so kvm2-pinned Standard → Starter keeps that kvm2. Null-pin Starter → Standard is also kvm2 → kvm2 after the Jul 2026 flip.
2. Never `releaseVpsToPool` unless `isReplacementVm` (new id !== old id), inventory `state=assigned` to this business (a stale `hostinger_vps_id` is not an assignment), deploy did not fail, and the voice bridge heartbeat is healthy.
3. Write `businesses.tier` via `updateBusinessEntitlementTier` (`.select()` read-back) as soon as the new subscription row exists, both directions. External Zapier/Make/public-API/webhook-channel AiFlows and outbound REST hooks follow that column; internal producers stay allowed on every tier.
4. Log `changePlan: complete` only when the tier write landed, a box is actually assigned, and the bridge is heartbeating.
5. Generic heal (`healPlanChangeAftereffects`, provisioning-retry every 5 min): copy live `subscriptions.tier` onto `businesses.tier`; if the business points at a numeric VM with zero assigned inventory and that inventory row is `available`, `claimSpecificAvailableVps` (never steal a row assigned to someone else), start the VM, wait for a heartbeat. No hardcoded business id. A failed tier sync must not skip the reclaim.

Related: [[project_change_plan_deleted_webhook_ordering]], [[project_orchestrate_input_rebuilt_field_by_field]].
