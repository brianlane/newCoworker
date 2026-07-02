/**
 * provision-kvm2-smoke.ts — EXPERIMENT: buy + bootstrap a KVM2 (starter-tier)
 * VPS through the exact Hostinger API path production provisioning uses, and
 * point it at a scratch CLONE of a real business's config so the starter
 * hardware can be smoke-tested against real tenant data with zero risk to the
 * production box.
 *
 * How production deploys a VPS (mirrored 1:1 here — see
 * src/lib/hostinger/provision.ts `provisionVpsForBusiness`):
 *   1. Generate an ed25519 keypair (comment = business id).
 *   2. POST /api/vps/v1/public-keys                — upload the public half.
 *   3. POST /api/vps/v1/post-install-scripts       — register the slim
 *      bootstrap loader (buildDefaultPostInstallScript, TIER=starter) so
 *      cloud-init runs vps/scripts/bootstrap.sh at first boot.
 *   4. POST /api/vps/v1/virtual-machines           — PURCHASE. item_id
 *      `hostingercom-vps-kvm2-usd-1m` (starter) vs `...kvm8...` (standard),
 *      Ubuntu-24.04-with-Docker template (1121), Boston-2 DC (24), the
 *      public key + post-install script attached via `setup`.
 *      ⚠️ This charges the Hostinger account's default payment method.
 *   5. Poll GET /api/vps/v1/virtual-machines/{id} until state=running + IPv4.
 *   6. POST /api/vps/v1/virtual-machines/{id}/monarx (best-effort scanner).
 *   7. Persist the private key in `vps_ssh_keys` (service-role only).
 *   8. Capture the Hostinger BILLING SUBSCRIPTION id from the purchase
 *      response (`vm.subscription_id`, fallback GET /api/billing/v1/
 *      subscriptions matched on resource_id) — this is what the lifecycle
 *      engine later cancels to stop paying (see cancel-vps-billing.ts).
 *
 * What this script adds around that:
 *   - Creates a scratch business row `KVM2 Smoke (<source> clone)` with
 *     tier=starter and copies the source business's `business_configs`
 *     (soul/identity/memory/website markdown) so deploy-client.sh seeds the
 *     clone box with the REAL vault. The clone id is what you pass to the
 *     rest of the debug tooling (vps-exec.ts, rowboat-logs.ts, …).
 *   - Records everything needed for teardown in debug/.kvm2-smoke.json.
 *
 * After it completes, run the deploy phase (no Cloudflare tunnel — probes go
 * over SSH so the experiment never publishes hostnames):
 *   set -a && source .env && set +a
 *   CLOUDFLARE_TUNNEL_TOKEN= npx tsx scripts/redeploy-deploy-client.ts --business <cloneId>
 *
 * Teardown when done:  npx tsx debug/cancel-vps-billing.ts --state --apply
 *
 * Usage:
 *   npx tsx debug/provision-kvm2-smoke.ts                 # dry run: price + plan
 *   npx tsx debug/provision-kvm2-smoke.ts --apply         # PURCHASES the VPS
 *   npx tsx debug/provision-kvm2-smoke.ts --source <businessId> --apply
 *
 * Adopt mode (NO purchase): when a KVM2 was already bought (e.g. the June 30
 * experiment left VMs stuck in `initial` because the card 402'd at setup
 * time), adopt it instead of buying another. Runs Hostinger's setup endpoint
 * on the existing VM with the same payload production purchases use (Ubuntu
 * 24.04 + Docker template, fresh keypair, TIER=starter post-install script),
 * then continues the identical poll → Monarx → vps_ssh_keys → state-file flow:
 *   npx tsx debug/provision-kvm2-smoke.ts --adopt-vm <vmId>          # dry run
 *   npx tsx debug/provision-kvm2-smoke.ts --adopt-vm <vmId> --apply
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

const STATE_FILE = path.resolve(process.cwd(), "debug/.kvm2-smoke.json");
const KVM2_ITEM_ID = "hostingercom-vps-kvm2-usd-1m";

const {
  provisionVpsForBusiness,
  buildDefaultPostInstallScript,
  DEFAULT_TIER_PRICE_ITEM,
  DEFAULT_TEMPLATE_ID,
  DEFAULT_US_DATA_CENTER_ID
} = await import("../src/lib/hostinger/provision.ts");
const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");

const hostinger = makeHostingerClient();
const db = await createSupabaseServiceClient();

// ---------------------------------------------------------------- dry-run info
const catalog = await hostinger.listCatalog("VPS");
const kvm2 = catalog.find((c) => c.prices.some((p) => p.id === KVM2_ITEM_ID));
const kvm2Price = kvm2?.prices.find((p) => p.id === KVM2_ITEM_ID);
const priceStr = kvm2Price
  ? `$${(kvm2Price.price / 100).toFixed(2)}/${kvm2Price.period_unit}` +
    (kvm2Price.first_period_price !== undefined
      ? ` (first period $${(kvm2Price.first_period_price / 100).toFixed(2)})`
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

console.log(`== KVM2 smoke provision ==`);
console.log(`source business : ${srcBiz.name} (${SOURCE_BUSINESS_ID}, tier=${srcBiz.tier})`);
console.log(`item            : ${KVM2_ITEM_ID}  →  ${priceStr}`);
console.log(`tier mapping    : starter→${DEFAULT_TIER_PRICE_ITEM.starter}  standard→${DEFAULT_TIER_PRICE_ITEM.standard}`);
console.log(
  `vault sizes     : soul=${srcCfg.soul_md.length}ch identity=${srcCfg.identity_md.length}ch ` +
    `memory=${srcCfg.memory_md.length}ch website=${srcCfg.website_md.length}ch`
);

if (fs.existsSync(STATE_FILE)) {
  console.error(`\nRefusing: ${STATE_FILE} already exists — an experiment box may be live.`);
  console.error(`Tear it down first (debug/cancel-vps-billing.ts --state --apply) or delete the file.`);
  process.exit(1);
}

if (ADOPT_VM_ID !== null) {
  const vm = await hostinger.getVirtualMachine(ADOPT_VM_ID);
  console.log(`adopt target    : vm=${vm.id} state=${vm.state} ip=${vm.ipv4?.[0]?.address ?? "none"}`);
}

if (!APPLY) {
  if (ADOPT_VM_ID !== null) {
    console.log(`\n[dry-run] Would ADOPT existing VM ${ADOPT_VM_ID} (no purchase): run Hostinger`);
    console.log(`[dry-run] setup (Ubuntu-Docker template ${DEFAULT_TEMPLATE_ID}, fresh key, TIER=starter`);
    console.log(`[dry-run] post-install), wait for running, persist the SSH key, and clone the`);
    console.log(`[dry-run] source business config onto a scratch tenant row.`);
  } else {
    console.log(`\n[dry-run] Would purchase ONE ${KVM2_ITEM_ID} VPS, bootstrap TIER=starter,`);
    console.log(`[dry-run] and clone the source business config onto a scratch tenant row.`);
  }
  console.log(`[dry-run] Re-run with --apply to act.`);
  process.exit(0);
}

// ---------------------------------------------------------------- clone rows
const cloneId = randomUUID();
const cloneName = `KVM2 Smoke (${srcBiz.name} clone)`;
console.log(`\ncreating clone business ${cloneId} — "${cloneName}"`);

const { error: insBizErr } = await db.from("businesses").insert({
  id: cloneId,
  name: cloneName,
  owner_email: srcBiz.owner_email,
  tier: "starter",
  // businesses_status_check allows online|offline|high_load|wiped; deploy-client
  // flips it to online at the end. Start offline.
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
type ProvisionResultLike = {
  virtualMachineId: number;
  publicIp: string;
  publicKeyId: number;
  postInstallScriptId: number | null;
  hostingerBillingSubscriptionId: string | null;
};

/**
 * Adopt an already-purchased VM: same steps as provisionVpsForBusiness minus
 * the purchase — Hostinger's setup endpoint takes the identical payload the
 * purchase-time `setup` field carries, so the box comes up exactly like a
 * production one (cloud-init runs the TIER=starter bootstrap at first boot).
 */
async function adoptExistingVm(vmId: number): Promise<ProvisionResultLike> {
  const { generateSshKeypair } = await import("../src/lib/hostinger/keypair.ts");
  const { insertVpsSshKey } = await import("../src/lib/db/vps-ssh-keys.ts");

  const keypair = await generateSshKeypair(`newcoworker-${cloneId}`);
  const keyName = `newcoworker-${cloneId}-${Date.now().toString(36)}`;
  const pubKey = await hostinger.createPublicKey(keyName, keypair.publicKey.trim());
  console.log(`  [public_key_uploaded] id=${pubKey.id} name=${keyName}`);

  const script = await hostinger.createPostInstallScript(
    `newcoworker-${cloneId}-${Date.now().toString(36)}`,
    buildDefaultPostInstallScript({ tier: "starter" })
  );
  console.log(`  [post_install_script_registered] id=${script.id}`);

  console.log(`  [setup_initiated] vm=${vmId} template=${DEFAULT_TEMPLATE_ID}`);
  await hostinger.setupVirtualMachine(vmId, {
    data_center_id: DEFAULT_US_DATA_CENTER_ID,
    template_id: DEFAULT_TEMPLATE_ID,
    hostname: `nc-${cloneId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 12)}`,
    public_key_ids: [pubKey.id],
    post_install_script_id: script.id,
    install_monarx: false
  });

  // Poll running + IPv4 (same happy path as production's waitForVpsReady,
  // same 15-min budget; error/suspended/stopped are terminal).
  const deadline = Date.now() + 15 * 60 * 1000;
  let publicIp: string | null = null;
  for (;;) {
    const vm = await hostinger.getVirtualMachine(vmId);
    const ip = vm.ipv4?.[0]?.address;
    if (vm.state === "running" && ip) {
      publicIp = ip;
      break;
    }
    if (vm.state === "error" || vm.state === "suspended" || vm.state === "stopped") {
      throw new Error(`VM ${vmId} entered terminal state=${vm.state} during setup`);
    }
    if (Date.now() > deadline) throw new Error(`VM ${vmId} not running after 15 min`);
    console.log(`  [waiting] state=${vm.state} ip=${ip ?? "none"}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log(`  [vps_running] ip=${publicIp}`);

  try {
    await hostinger.installMonarx(vmId);
    console.log(`  [monarx_installed]`);
  } catch (err) {
    console.log(`  [monarx_failed] ${err instanceof Error ? err.message : String(err)} (continuing)`);
  }

  await insertVpsSshKey({
    business_id: cloneId,
    hostinger_vps_id: String(vmId),
    hostinger_public_key_id: pubKey.id,
    public_key: keypair.publicKey,
    private_key_pem: keypair.privateKeyPem,
    fingerprint_sha256: keypair.fingerprintSha256,
    ssh_username: "root"
  });
  console.log(`  [ssh_key_persisted]`);

  let billingId: string | null = null;
  try {
    const subs = await hostinger.listBillingSubscriptions();
    billingId = subs.find((s) => s.resource_id === String(vmId))?.id ?? null;
  } catch (err) {
    console.log(`  [billing_lookup_failed] ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    virtualMachineId: vmId,
    publicIp,
    publicKeyId: pubKey.id,
    postInstallScriptId: script.id,
    hostingerBillingSubscriptionId: billingId
  };
}

let result: ProvisionResultLike;
if (ADOPT_VM_ID !== null) {
  console.log(`adopting existing VM ${ADOPT_VM_ID} (no purchase)…`);
  result = await adoptExistingVm(ADOPT_VM_ID);
} else {
  console.log(`purchasing ${KVM2_ITEM_ID} (this can take several minutes)…`);
  result = await provisionVpsForBusiness(
    {
      businessId: cloneId,
      tier: "starter",
      postInstallScript: buildDefaultPostInstallScript({ tier: "starter" })
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
  // Adopted boxes were purchased earlier — teardown still cancels their
  // billing subscription the same way, this flag is just provenance.
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
console.log(`\nbootstrap.sh (TIER=starter) runs via cloud-init at first boot — tail it with:`);
console.log(`  npx tsx debug/vps-exec.ts ${cloneId} "tail -50 /post_install.log"`);
console.log(`then deploy the clone config (no tunnel):`);
console.log(`  set -a && source .env && set +a`);
console.log(`  CLOUDFLARE_TUNNEL_TOKEN= npx tsx scripts/redeploy-deploy-client.ts --business ${cloneId}`);
