---
name: project-vps-inventory-write-traps
description: vps_inventory helpers treat an omitted key as preserve but an explicit null as wipe, and releaseVpsToPool un-assigns with no ownership check
metadata:
  type: project
---

`recordVpsAssigned` and `releaseVpsToPool` (`src/lib/db/vps-inventory.ts`) are upserts whose payload is built key by key. Three traps, all of which Bugbot caught in one 2026-08-28 one-shot and one of which had already blanked a live row:

**1. Omit preserves, null wipes.** `expires_at` is only patched when the key is present, so leaving it out keeps whatever the daily billing-posture cron resolved. But `hostinger_billing_subscription_id` is written UNCONDITIONALLY as `input.hostingerBillingSubscriptionId ?? null`, so omitting it ERASES the link on an existing row. That is not a symmetry you can guess from the call site. `paidThroughFromBillingSub` returns null when Hostinger reports neither `expires_at` nor `next_billing_at`, so `...(sub ? { expiresAt: paidThroughFromBillingSub(sub) } : {})` still passes an explicit null through and wipes a known date. Spread nothing unless a real value resolved.

Losing `hostinger_billing_subscription_id` is not cosmetic: it is what makes `never_renew` checkable against Hostinger, and what the adopt path needs to disable renewal later.

**2. `releaseVpsToPool` un-assigns with no ownership predicate.** It clears `assigned_business_id` for the given `vm_id` whatever that row currently says. `skipIfClaimed: true` skips ANY existing `assigned` row, which is right for the orphan reconciler but wrong for a migration teardown (where the row is legitimately assigned to the tenant that is leaving). A caller that is re-runnable must check `assigned_business_id` itself and refuse a row belonging to someone else, or a re-run strips a live tenant's claim and leaves their hardware claimable for a destructive recreate.

**3. `plan` is used only on INSERT.** An existing row keeps its recorded plan (the SKU captured at purchase time is ground truth). So a wrong `plan` is silent until the one case it matters: seeding a row that does not exist yet. Never default it to some other box's size; read the box's own plan from Hostinger.

Related: [[project-postgrest-write-matching-zero-rows]] and [[feedback-verify-the-column-is-written]]. Read every write back and assert the fields you meant to set, including the ones you did not think you were touching.
