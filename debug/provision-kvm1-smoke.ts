/**
 * provision-kvm1-smoke.ts — Phase E EXPERIMENT: buy + bootstrap a KVM1
 * (1 vCPU / 4GB RAM) VPS and smoke-test the STARTER stack on it, minus
 * Ollama (Gemini-only with the hard budget fuse), per the fleet-economics
 * plan: "If it fits: starter default hardware = KVM1 on term (~$8/mo
 * effective)."
 *
 * Shape mirrors debug/provision-kvm2-smoke.ts (the June 2026 KVM2
 * experiment), with three deliberate differences:
 *
 *   1. PURCHASE SKU is `hostingercom-vps-kvm1-usd-1m` via the `itemId`
 *      override on provisionVpsForBusiness — but the BOOTSTRAP profile stays
 *      `VPS_SIZE=kvm2` because "kvm1" is not (yet) a first-class VpsSize;
 *      the kvm2 profile is the constrained-hardware profile (ZRAM 4G lz4,
 *      Ollama single-model tuning) and is the closest match. If the
 *      experiment succeeds, "kvm1" gets its own profile in a follow-up PR.
 *   2. After bootstrap, Ollama is DISABLED over SSH (service + keep-warm
 *      timer stopped, pulled models removed): the KVM1 shape is
 *      "full starter stack minus Ollama" — 4GB RAM has no headroom for a
 *      resident 3B model next to Docker + the tenant stack.
 *   3. State file is debug/.kvm1-smoke.json. Teardown:
 *        npx tsx debug/cancel-vps-billing.ts --vm <vmId> --apply
 *      then mark the clone business offline manually (or delete the row).
 *
 * Usage:
 *   npx tsx debug/provision-kvm1-smoke.ts             # dry run: price + plan
 *   npx tsx debug/provision-kvm1-smoke.ts --apply     # ⚠️ PURCHASES the VPS
 *   npx tsx debug/provision-kvm1-smoke.ts --source <businessId> --apply
 *
 * Adopt mode (NO purchase): Hostinger's order API sometimes charges the card
 * and STILL fails the request (observed Jul 5 2026: a 422 on hostname AND a
 * 402 "card payment could not be completed" each left a PAID KVM1 stuck in
 * `initial`). Adopt such a box instead of buying another — same
 * setup→recreate flow provision-kvm2-smoke.ts validated:
 *   npx tsx debug/provision-kvm1-smoke.ts --adopt-vm <vmId>          # dry run
 *   npx tsx debug/provision-kvm1-smoke.ts --adopt-vm <vmId> --apply
 *
 * After it completes, deploy the clone (no Cloudflare tunnel — probes go
 * over SSH so the experiment never publishes hostnames):
 *   set -a && source .env && set +a
 *   CLOUDFLARE_TUNNEL_TOKEN= npx tsx scripts/redeploy-deploy-client.ts --business <cloneId>
 *
 * Then measure (the whole point of Phase E):
 *   npx tsx debug/vps-exec.ts <cloneId> "free -m && docker stats --no-stream"
 *   npx tsx debug/smoke-owner-chat.ts <cloneId> "Are you there?"
 *   npx tsx debug/smoke-voice-concurrency.ts --business <cloneId> --calls 1
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnv, makeHostingerClient } from "./_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const sourceArgIdx = process.argv.indexOf("--source");
const SOURCE_BUSINESS_ID =
  sourceArgIdx > -1
    ? process.argv[sourceArgIdx + 1]
    : "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3"; // Amy
const adoptArgIdx = process.argv.indexOf("--adopt-vm");
const ADOPT_VM_ID = adoptArgIdx > -1 ? Number(process.argv[adoptArgIdx + 1]) : null;
if (adoptArgIdx > -1 && (!Number.isInteger(ADOPT_VM_ID) || ADOPT_VM_ID! <= 0)) {
  console.error("--adopt-vm requires a numeric Hostinger virtual machine id");
  process.exit(1);
}

const STATE_FILE = path.resolve(process.cwd(), "debug/.kvm1-smoke.json");
const KVM1_ITEM_ID = "hostingercom-vps-kvm1-usd-1m";

const { provisionVpsForBusiness, buildDefaultPostInstallScript } =
  await import("../src/lib/hostinger/provision.ts");
const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");

const hostinger = makeHostingerClient();
const db = await createSupabaseServiceClient();

// ---------------------------------------------------------------- dry-run info
const catalog = await hostinger.listCatalog("VPS");
const kvm1 = catalog.find((c) => c.prices.some((p) => p.id === KVM1_ITEM_ID));
const kvm1Price = kvm1?.prices.find((p) => p.id === KVM1_ITEM_ID);
const priceStr = kvm1Price
  ? `$${(kvm1Price.price / 100).toFixed(2)}/${kvm1Price.period_unit}` +
    (kvm1Price.first_period_price !== undefined
      ? ` (first period $${(kvm1Price.first_period_price / 100).toFixed(2)})`
      : "")
  : "UNKNOWN — item not in catalog!";

const { data: srcBiz, error: bizErr } = await db
  .from("businesses")
  .select("id, name, tier, status, timezone, business_type, owner_name, phone, service_area, owner_email")
  .eq("id", SOURCE_BUSINESS_ID)
  .single();
if (bizErr || !srcBiz) {
  console.error(`source business ${SOURCE_BUSINESS_ID} not found: ${bizErr?.message}`);
  process.exit(1);
}
const { data: srcCfg, error: cfgErr } = await db
  .from("business_configs")
  .select("soul_md, identity_md, memory_md, website_md")
  .eq("business_id", SOURCE_BUSINESS_ID)
  .single();
if (cfgErr || !srcCfg) {
  console.error(`source business_configs missing: ${cfgErr?.message}`);
  process.exit(1);
}

console.log(`== KVM1 smoke provision (Phase E) ==`);
console.log(`source business : ${srcBiz.name} (${SOURCE_BUSINESS_ID}, tier=${srcBiz.tier})`);
console.log(`item            : ${KVM1_ITEM_ID}  →  ${priceStr}`);
console.log(`clone tier      : starter (bootstrap profile VPS_SIZE=kvm2 — see header #1)`);
console.log(
  `vault sizes     : soul=${srcCfg.soul_md.length}ch identity=${srcCfg.identity_md.length}ch ` +
    `memory=${srcCfg.memory_md.length}ch website=${srcCfg.website_md.length}ch`
);

if (fs.existsSync(STATE_FILE)) {
  console.error(`\nRefusing: ${STATE_FILE} already exists — an experiment box may be live.`);
  console.error(`Tear it down first (cancel-vps-billing.ts --vm <vmId> --apply) or delete the file.`);
  process.exit(1);
}

if (ADOPT_VM_ID !== null) {
  const vm = await hostinger.getVirtualMachine(ADOPT_VM_ID);
  console.log(`adopt target    : vm=${vm.id} state=${vm.state} ip=${vm.ipv4?.[0]?.address ?? "none"}`);
}

if (!APPLY) {
  if (ADOPT_VM_ID !== null) {
    console.log(`\n[dry-run] Would ADOPT existing VM ${ADOPT_VM_ID} (no purchase): setup→recreate`);
    console.log(`[dry-run] with TIER=starter VPS_SIZE=kvm2 post-install, persist the SSH key,`);
    console.log(`[dry-run] and clone the source config onto a scratch tenant row.`);
  } else {
    console.log(`\n[dry-run] Would purchase ONE ${KVM1_ITEM_ID} VPS, bootstrap TIER=starter`);
    console.log(`[dry-run] VPS_SIZE=kvm2 (ZRAM on), clone the source config onto a scratch`);
    console.log(`[dry-run] tenant row, then disable Ollama over SSH (Gemini-only shape).`);
  }
  console.log(`[dry-run] Re-run with --apply to act.`);
  process.exit(0);
}

// ---------------------------------------------------------------- clone rows
const cloneId = randomUUID();
const cloneName = `KVM1 Smoke (${srcBiz.name} clone)`;
console.log(`\ncreating clone business ${cloneId} — "${cloneName}"`);

const { error: insBizErr } = await db.from("businesses").insert({
  id: cloneId,
  name: cloneName,
  // NOT the source owner's email — see provision-kvm2-smoke.ts for the
  // session-hijack incident this prevents. Synthetic, undeliverable.
  owner_email: `kvm1-smoke+${cloneId}@invalid.newcoworker.com`,
  tier: "starter",
  // Closest valid hardware pin ("kvm1" is not a VpsSize) — matches the
  // bootstrap profile actually applied to the box.
  vps_size: "kvm2",
  status: "offline",
  business_type: srcBiz.business_type,
  owner_name: srcBiz.owner_name,
  phone: srcBiz.phone,
  service_area: srcBiz.service_area,
  timezone: srcBiz.timezone,
  // Keep every channel gate closed: this tenant must never answer real traffic.
  is_paused: true,
  customer_channels_enabled: false
});
if (insBizErr) {
  console.error(`clone business insert failed: ${insBizErr.message}`);
  process.exit(1);
}

const { error: insCfgErr } = await db.from("business_configs").insert({
  business_id: cloneId,
  soul_md: srcCfg.soul_md,
  identity_md: srcCfg.identity_md,
  memory_md: srcCfg.memory_md,
  website_md: srcCfg.website_md
});
if (insCfgErr) {
  console.error(`clone business_configs insert failed: ${insCfgErr.message}`);
  process.exit(1);
}

// ------------------------------------------------------- purchase OR adopt
let result: Awaited<ReturnType<typeof provisionVpsForBusiness>>;
if (ADOPT_VM_ID !== null) {
  // Same proven setup→recreate sequence production pool-adopts use —
  // adoptVpsForBusiness reuses/mints the key row, registers the TIER=starter
  // VPS_SIZE=kvm2 post-install, recreates until the key attaches, and waits
  // for the box's own post-install run to go quiescent.
  const { adoptVpsForBusiness } = await import("../src/lib/hostinger/adopt.ts");
  console.log(`adopting existing VM ${ADOPT_VM_ID} (no purchase)…`);
  result = await adoptVpsForBusiness(
    { businessId: cloneId, tier: "starter", vpsSize: "kvm2", virtualMachineId: ADOPT_VM_ID },
    { client: hostinger }
  );
} else {
  console.log(`purchasing ${KVM1_ITEM_ID} (this can take several minutes)…`);
  result = await provisionVpsForBusiness(
    {
      businessId: cloneId,
      tier: "starter",
      vpsSize: "kvm2",
      itemId: KVM1_ITEM_ID,
      postInstallScript: buildDefaultPostInstallScript({ tier: "starter", vpsSize: "kvm2" })
    },
    {
      client: hostinger,
      onProgress: (phase, detail) => console.log(`  [${phase}] ${JSON.stringify(detail)}`)
    }
  );
}

await db
  .from("businesses")
  .update({
    hostinger_vps_id: String(result.virtualMachineId),
    hostinger_subscription_id: result.hostingerBillingSubscriptionId,
    hostinger_post_install_script_id: result.postInstallScriptId
  })
  .eq("id", cloneId);

const state = {
  createdAt: new Date().toISOString(),
  experiment: "kvm1-starter-phase-e",
  adoptedExistingVm: ADOPT_VM_ID !== null,
  sourceBusinessId: SOURCE_BUSINESS_ID,
  cloneBusinessId: cloneId,
  virtualMachineId: result.virtualMachineId,
  publicIp: result.publicIp,
  publicKeyId: result.publicKeyId,
  postInstallScriptId: result.postInstallScriptId,
  hostingerBillingSubscriptionId: result.hostingerBillingSubscriptionId
};
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");

console.log(`\nVPS ready: vm=${result.virtualMachineId} ip=${result.publicIp}`);
console.log(`billing subscription: ${result.hostingerBillingSubscriptionId ?? "UNKNOWN (look up before teardown!)"}`);
console.log(`state written to ${STATE_FILE}`);
console.log(`\nbootstrap.sh (TIER=starter VPS_SIZE=kvm2) runs via cloud-init at first boot — tail it:`);
console.log(`  npx tsx debug/vps-exec.ts ${cloneId} "tail -50 /post_install.log"`);
console.log(`once bootstrap is quiescent, disable Ollama (Gemini-only shape):`);
console.log(
  `  npx tsx debug/vps-exec.ts ${cloneId} "systemctl disable --now ollama ollama-keep-warm.timer 2>/dev/null; ollama rm llama3.2:3b 2>/dev/null; true"`
);
console.log(`then deploy the clone config (no tunnel):`);
console.log(`  set -a && source .env && set +a`);
console.log(`  CLOUDFLARE_TUNNEL_TOKEN= npx tsx scripts/redeploy-deploy-client.ts --business ${cloneId}`);
