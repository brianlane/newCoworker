/**
 * migrate-vps-size.ts — move an existing business to a different VPS hardware
 * size (kvm2 ↔ kvm8) with no entitlement change.
 *
 * This is the operational half of the tier/hardware decoupling
 * (businesses.vps_size, src/lib/vps/size.ts): the tenant keeps their `tier`
 * (minutes, SMS caps, concurrency, AI budget, aiflow-render) and only the box
 * underneath changes. Flow — the same primitives the change-plan orchestrator
 * uses, sequenced for an elective migration instead of a paid plan change:
 *
 *   1. Snapshot the old VM (best-effort safety net; Hostinger keeps ONE
 *      snapshot per VM and it dies with the VM — the durable artefact is
 *      step 2's tarball).
 *   2. SSH-tarball backup of /opt/rowboat/{vault,memory} to Supabase Storage
 *      (backupBusinessData). FAIL-CLOSED: an elective migration aborts if the
 *      backup fails, unlike change-plan which continues (a paid upgrade must
 *      not be blocked by a dead old box; an elective move can wait).
 *   3. Pin businesses.vps_size to the target size.
 *   4. orchestrateProvisioning with the pinned size — buys the new box
 *      (kvm2/kvm8 SKU), bootstraps (ZRAM/Ollama profile keyed on VPS_SIZE,
 *      render gate keyed on TIER), deploys the tenant, re-registers the
 *      per-tenant Cloudflare tunnel (DNS swings when the new cloudflared
 *      connects), and overwrites businesses.hostinger_vps_id.
 *   5. Restore the tarball onto the new box (restoreBusinessData).
 *   6. Old box teardown: stop the VM + DISABLE AUTO-RENEWAL on its Hostinger
 *      billing subscription. (Hostinger removed the immediate-cancel
 *      endpoint `DELETE /api/billing/v1/subscriptions/{id}` on 2026-01-12 —
 *      auto-renew-off + lapse at period end is the only teardown.)
 *   7. Repoint subscriptions.hostinger_billing_subscription_id at the NEW
 *      box's billing subscription so the lifecycle engine tears down the
 *      right thing on a future cancel.
 *
 * The owner "your coworker is live" email/SMS is suppressed by default
 * (ownerEmail is NOT passed → orchestrator notifies ADMIN_EMAIL instead);
 * pass --notify-owner for a real communicated maintenance window.
 *
 * Usage:
 *   npx tsx debug/migrate-vps-size.ts --business <id> --size kvm2         # dry run
 *   npx tsx debug/migrate-vps-size.ts --business <id> --size kvm2 --apply # ⚠️ buys a VPS
 *   Flags: --notify-owner   send the owner the provisioning-complete email/SMS
 *          --keep-old       skip step 6 (leave the old box running + renewing)
 *
 * State (for audit / manual recovery) is written to
 * debug/.migrate-vps-size-<businessId>.json after each apply run.
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv, makeHostingerClient } from "./_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const NOTIFY_OWNER = process.argv.includes("--notify-owner");
const KEEP_OLD = process.argv.includes("--keep-old");

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

const BUSINESS_ID = argValue("--business");
const TARGET_SIZE = argValue("--size");
if (!BUSINESS_ID || (TARGET_SIZE !== "kvm2" && TARGET_SIZE !== "kvm8")) {
  console.error("usage: migrate-vps-size.ts --business <uuid> --size kvm2|kvm8 [--apply] [--notify-owner] [--keep-old]");
  process.exit(1);
}

const { resolveVpsSize } = await import("../src/lib/vps/size.ts");
const { VPS_SIZE_PRICE_ITEM } = await import("../src/lib/hostinger/provision.ts");
const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");

const hostinger = makeHostingerClient();
const db = await createSupabaseServiceClient();

// ---------------------------------------------------------------- load state
const { data: biz, error: bizErr } = await db
  .from("businesses")
  .select("id, name, tier, status, hostinger_vps_id, owner_email, vps_size, is_paused")
  .eq("id", BUSINESS_ID)
  .single();
if (bizErr || !biz) {
  console.error(`business ${BUSINESS_ID} not found: ${bizErr?.message}`);
  process.exit(1);
}
if (biz.tier !== "starter" && biz.tier !== "standard") {
  console.error(`tier=${biz.tier} is not migratable by this script (enterprise is custom)`);
  process.exit(1);
}

const { data: subRows } = await db
  .from("subscriptions")
  .select("id, status, hostinger_billing_subscription_id, created_at")
  .eq("business_id", BUSINESS_ID)
  .eq("status", "active")
  .order("created_at", { ascending: false })
  .limit(1);
const activeSub = subRows?.[0] ?? null;

const currentSize = resolveVpsSize(biz.tier, biz.vps_size);
const targetItem = VPS_SIZE_PRICE_ITEM[TARGET_SIZE as "kvm2" | "kvm8"];

const oldVmIdRaw = biz.hostinger_vps_id;
const oldVmId = oldVmIdRaw && /^\d+$/.test(oldVmIdRaw) ? Number.parseInt(oldVmIdRaw, 10) : null;
let oldVmIp: string | null = null;
let oldBillingId: string | null = activeSub?.hostinger_billing_subscription_id ?? null;
if (oldVmId !== null) {
  try {
    const vm = await hostinger.getVirtualMachine(oldVmId);
    oldVmIp = vm.ipv4?.[0]?.address ?? null;
    console.log(`old VM          : ${oldVmId} state=${vm.state} ip=${oldVmIp ?? "none"}`);
  } catch (err) {
    console.log(`old VM          : ${oldVmId} (lookup failed: ${err instanceof Error ? err.message : String(err)})`);
  }
  if (!oldBillingId) {
    try {
      const subs = await hostinger.listBillingSubscriptions();
      oldBillingId = subs.find((s) => s.resource_id === String(oldVmId))?.id ?? null;
    } catch {
      /* keep null — teardown will warn */
    }
  }
}

// Target-SKU price from the live catalog so the dry run states the real cost.
let priceStr = "unknown";
try {
  const catalog = await hostinger.listCatalog("VPS");
  const item = catalog.find((c) => c.prices.some((p) => p.id === targetItem));
  const price = item?.prices.find((p) => p.id === targetItem);
  if (price) {
    priceStr =
      `$${(price.price / 100).toFixed(2)}/${price.period_unit}` +
      (price.first_period_price !== undefined
        ? ` (first period $${(price.first_period_price / 100).toFixed(2)})`
        : "");
  }
} catch {
  /* dry-run nicety only */
}

console.log(`== VPS size migration ==`);
console.log(`business        : ${biz.name} (${biz.id})`);
console.log(`tier            : ${biz.tier} (entitlements — unchanged by this migration)`);
console.log(`size            : ${currentSize} (pin=${biz.vps_size ?? "null/tier-default"}) → ${TARGET_SIZE}`);
console.log(`target SKU      : ${targetItem}  →  ${priceStr}`);
console.log(`old billing sub : ${oldBillingId ?? "UNKNOWN — teardown will need a manual lookup"}`);
console.log(`owner notify    : ${NOTIFY_OWNER ? `YES → ${biz.owner_email}` : "no (admin email only)"}`);
console.log(`old box         : ${KEEP_OLD ? "KEPT (renewing!)" : "stop + auto-renew off (lapses at period end)"}`);

if (currentSize === TARGET_SIZE) {
  console.log(`\nNOTE: effective size is already ${TARGET_SIZE}. Proceeding anyway would still`);
  console.log(`buy a fresh ${TARGET_SIZE} box and migrate onto it (box refresh). Aborting —`);
  console.log(`if that's what you want, flip the pin first or edit this guard.`);
  process.exit(1);
}

if (!APPLY) {
  console.log(`\n[dry-run] Would: snapshot+backup old box → pin vps_size=${TARGET_SIZE} →`);
  console.log(`[dry-run] provision ${targetItem} (⚠️ charges the Hostinger account) → restore`);
  console.log(`[dry-run] data → ${KEEP_OLD ? "leave old box running" : "stop old box + disable its billing auto-renewal"}.`);
  console.log(`[dry-run] Re-run with --apply to act.`);
  process.exit(0);
}

// ---------------------------------------------------------------- 1. snapshot
if (oldVmId !== null) {
  try {
    await hostinger.createSnapshot(oldVmId);
    console.log(`\n[snapshot] requested on old VM ${oldVmId}`);
  } catch (err) {
    console.log(`\n[snapshot] failed (continuing — tarball is the durable artefact): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------- 2. backup
const { backupBusinessData, restoreBusinessData } = await import("../src/lib/hostinger/data-migration.ts");
if (!oldVmIp) {
  console.error(`[backup] ABORT: old VM has no resolvable IP — cannot take the durable backup.`);
  console.error(`         If the old box is truly gone and you accept template state, backup/restore`);
  console.error(`         must be skipped manually (edit this script's guard).`);
  process.exit(1);
}
console.log(`[backup] tarballing /opt/rowboat/{vault,memory} from ${oldVmIp}…`);
const backup = await backupBusinessData({ businessId: BUSINESS_ID, vpsHost: oldVmIp });
console.log(`[backup] ok: ${backup.storagePath} (${backup.sizeBytes} bytes, sha256=${backup.sha256.slice(0, 12)}…)`);

// ---------------------------------------------------------------- 3. pin size
const { updateBusinessVpsSize } = await import("../src/lib/db/businesses.ts");
await updateBusinessVpsSize(BUSINESS_ID, TARGET_SIZE as "kvm2" | "kvm8");
console.log(`[pin] businesses.vps_size = ${TARGET_SIZE}`);

// ---------------------------------------------------------------- 4. provision
const { orchestrateProvisioning } = await import("../src/lib/provisioning/orchestrate.ts");
console.log(`[provision] purchasing + bootstrapping ${targetItem} (this takes ~10-20 min)…`);
let newProv: Awaited<ReturnType<typeof orchestrateProvisioning>>;
try {
  newProv = await orchestrateProvisioning({
    businessId: BUSINESS_ID,
    tier: biz.tier,
    vpsSize: TARGET_SIZE,
    ...(NOTIFY_OWNER && biz.owner_email ? { ownerEmail: biz.owner_email } : {})
  });
} catch (err) {
  console.error(`[provision] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`[provision] The old box is untouched and still serving; the vps_size pin stays`);
  console.error(`[provision] at ${TARGET_SIZE} (desired state) — re-run once the cause is fixed,`);
  console.error(`[provision] or reset the pin: updateBusinessVpsSize('${BUSINESS_ID}', ${biz.vps_size === null ? "null" : `'${biz.vps_size}'`}).`);
  process.exit(1);
}
console.log(`[provision] new VM ${newProv.vpsId}, tunnel ${newProv.tunnelUrl}`);

// ---------------------------------------------------------------- 5. restore
const newVmId = Number.parseInt(newProv.vpsId, 10);
let newVmIp: string | null = null;
try {
  const vm = await hostinger.getVirtualMachine(newVmId);
  newVmIp = vm.ipv4?.[0]?.address ?? null;
} catch {
  /* handled below */
}
if (!newVmIp) {
  console.error(`[restore] cannot resolve the new VM's IP — restore manually:`);
  console.error(`          restoreBusinessData({ businessId: '${BUSINESS_ID}', vpsHost: <ip> })`);
} else {
  try {
    await restoreBusinessData({ businessId: BUSINESS_ID, vpsHost: newVmIp });
    console.log(`[restore] durable data restored onto ${newVmIp}`);
  } catch (err) {
    console.error(`[restore] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`[restore] The new box is serving TEMPLATE state. The tarball is safe at`);
    console.error(`[restore] ${backup.storagePath} — retry restoreBusinessData before tearing`);
    console.error(`[restore] down the old box (it still has the live data).`);
    process.exit(1);
  }
}

// ------------------------------------------------- 6+7. old box + billing swap
let newBillingId: string | null = newProv.hostingerBillingSubscriptionId;
if (!newBillingId) {
  try {
    const subs = await hostinger.listBillingSubscriptions();
    newBillingId = subs.find((s) => s.resource_id === String(newVmId))?.id ?? null;
  } catch {
    /* warned below */
  }
}
if (activeSub) {
  if (newBillingId) {
    const { error } = await db
      .from("subscriptions")
      .update({ hostinger_billing_subscription_id: newBillingId })
      .eq("id", activeSub.id);
    console.log(
      error
        ? `[billing] subscriptions row update FAILED: ${error.message}`
        : `[billing] subscriptions.hostinger_billing_subscription_id → ${newBillingId}`
    );
  } else {
    console.log(`[billing] WARNING: new box's billing subscription id unknown — look it up`);
    console.log(`[billing] (listBillingSubscriptions, resource_id=${newVmId}) and update the sub row.`);
  }
}

if (KEEP_OLD) {
  console.log(`[old-box] kept per --keep-old — REMEMBER it keeps billing until you tear it down.`);
} else if (oldVmId !== null) {
  try {
    await hostinger.stopVirtualMachine(oldVmId);
    console.log(`[old-box] VM ${oldVmId} stop requested`);
  } catch (err) {
    console.log(`[old-box] stop failed (may already be stopped): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (oldBillingId) {
    try {
      await hostinger.disableBillingAutoRenewal(oldBillingId);
      console.log(`[old-box] billing ${oldBillingId} auto-renewal disabled (lapses at period end;`);
      console.log(`[old-box] the immediate-cancel endpoint was removed by Hostinger 2026-01-12)`);
    } catch (err) {
      console.log(`[old-box] auto-renew disable FAILED: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`[old-box] Disable it manually in hPanel or you keep paying for the old box.`);
    }
  } else {
    console.log(`[old-box] WARNING: no billing subscription id for the old box — disable its`);
    console.log(`[old-box] auto-renewal manually or you keep paying for it.`);
  }
}

// ---------------------------------------------------------------- audit state
const stateFile = path.resolve(process.cwd(), `debug/.migrate-vps-size-${BUSINESS_ID}.json`);
fs.writeFileSync(
  stateFile,
  JSON.stringify(
    {
      migratedAt: new Date().toISOString(),
      businessId: BUSINESS_ID,
      tier: biz.tier,
      fromSize: currentSize,
      toSize: TARGET_SIZE,
      oldVmId,
      oldVmIp,
      oldBillingId,
      oldBillingHandling: KEEP_OLD ? "kept" : "auto-renew-disabled",
      newVmId,
      newVmIp,
      newBillingId,
      tunnelUrl: newProv.tunnelUrl,
      backupPath: backup.storagePath,
      backupSha256: backup.sha256
    },
    null,
    2
  ) + "\n"
);

console.log(`\nMigration complete: ${biz.name} is on ${TARGET_SIZE} (VM ${newVmId}, ${newVmIp ?? "ip?"}).`);
console.log(`State written to ${stateFile}`);
console.log(`Post-checks:`);
console.log(`  npx tsx debug/vps-exec.ts ${BUSINESS_ID} "docker ps --format '{{.Names}} {{.Status}}'"`);
console.log(`  npx tsx debug/smoke-owner-chat.ts ${BUSINESS_ID} "Are you there?"`);
console.log(`  npx tsx debug/check-vault-sync.ts ${BUSINESS_ID}`);
