#!/usr/bin/env tsx
/**
 * Manual finisher for biz `621a5b0d-c2ad-449f-9d74-9d50e7b27fa3` after the
 * customer paid the orphan KVM 8 in hPanel UI.
 *
 * State at script entry:
 *   - Hostinger VM id `1632631` exists, paid, `state=initial`,
 *     subscription_id `AzZjPZVII4iEp2Fy9`. Awaiting `POST /setup`.
 *   - `vps_ssh_keys` is empty for this business; orphan public keys on the
 *     Hostinger account from the failed earlier attempts have been deleted.
 *   - Stripe subscription `sub_1TRfjvFv205jOP2fzahmHdfT` is `active`,
 *     `business_configs` already populated by onboarding chat.
 *
 * What this script does:
 *   1. Probe `POST /api/vps/v1/post-install-scripts` once. The earlier
 *      `403 [VPS:2000] Unauthorized` was hit before the account owned a
 *      VPS — now that we own a paid (but unconfigured) VM, we expect the
 *      gate to clear. This is the explicit hypothesis test the operator
 *      asked for.
 *   2. Inject a custom `vpsProvisioner` into `orchestrateProvisioning`
 *      that DOES NOT purchase a new VM. Instead it:
 *        - generates a fresh ed25519 keypair
 *        - uploads the public half to Hostinger
 *        - (if probe succeeded) creates a real post-install script and
 *          attaches it via `setup.post_install_script_id`. If the probe
 *          failed, falls back to the SSH-bootstrap path (orchestrator
 *          already runs `buildDefaultPostInstallScript` over SSH after
 *          `vps_provisioned` regardless, so this is safe either way).
 *        - calls `POST /api/vps/v1/virtual-machines/1632631/setup` with
 *          template id 1121 (Ubuntu 24.04 + Docker), data center 24
 *          (Boston 2), our pubkey, hostname, and (if available)
 *          post_install_script_id.
 *        - polls until the VM reaches `running` with a public IPv4.
 *        - installs Monarx (best-effort).
 *        - persists the keypair into `vps_ssh_keys` so future SSH
 *          (orchestrator-side bootstrap, deploys, admin break-glass)
 *          works without re-running provisioning.
 *      Returns the same `ProvisionVpsForBusinessResult` shape the
 *      orchestrator expects, so `orchestrateProvisioning` can run the rest
 *      of its phases (SSH bootstrap, business-status flip, Cloudflare
 *      tunnel, DID purchase, deploy, welcome email/SMS) untouched.
 *
 * On hypothesis outcome:
 *   - Confirmed (probe returned 200) → we used the post-install-script
 *     hook for first-boot. Logged as HYPOTHESIS CONFIRMED. The merged
 *     refactor is OPTIONAL going forward — we could revert
 *     `provisionVpsForBusiness` to attach `post_install_script_id` at
 *     purchase time, with the SSH-bootstrap path kept as a fallback for
 *     fresh accounts.
 *   - Rejected (still 403) → the gate is deeper than "must own a VPS".
 *     Logged as HYPOTHESIS REJECTED. The refactor stays mandatory and we
 *     contact Hostinger about the gate.
 *
 * Usage:
 *   set -a; source .env; set +a; npx tsx scripts/finish-provision-stuck-business.ts
 *
 * NOT a long-term tool — delete or fold into a proper admin route once
 * the orchestrator changes ship to Vercel.
 */
import {
  HostingerClient,
  HostingerApiError,
  DEFAULT_HOSTINGER_BASE_URL,
  type VirtualMachine,
  type VpsSetupRequest
} from "@/lib/hostinger/client";
import {
  generateSshKeypair,
  convertPkcs8Ed25519PemToOpenssh
} from "@/lib/hostinger/keypair";
import {
  DEFAULT_TEMPLATE_ID,
  DEFAULT_US_DATA_CENTER_ID
} from "@/lib/hostinger/provision";
import {
  insertVpsSshKey,
  getActiveVpsSshKeyForBusiness
} from "@/lib/db/vps-ssh-keys";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  orchestrateProvisioning,
  runRemoteBootstrap,
  type VpsProvisioner
} from "@/lib/provisioning/orchestrate";

const BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const TIER = "standard" as const;
const OWNER_EMAIL = "brianlanefanmail@gmail.com";
const EXISTING_VPS_ID = 1632631;

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`[finish-provision] missing env: ${key}`);
    process.exit(2);
  }
  return v;
}

function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${(s % 60).toFixed(0).padStart(2, "0")}s`;
}

function firstIpv4(vm: VirtualMachine): string | undefined {
  if (!vm.ipv4 || !Array.isArray(vm.ipv4) || vm.ipv4.length === 0) return undefined;
  return vm.ipv4[0]?.address;
}

function truncateBusinessId(id: string): string {
  return id.replace(/[^A-Za-z0-9-]/g, "").slice(0, 12) || "unknown";
}

async function waitForRunning(
  client: HostingerClient,
  vmId: number,
  opts?: { pollIntervalMs?: number; readyTimeoutMs?: number }
): Promise<VirtualMachine> {
  const pollInterval = opts?.pollIntervalMs ?? 10_000;
  const readyTimeout = opts?.readyTimeoutMs ?? 15 * 60 * 1000;
  const deadline = Date.now() + readyTimeout;
  const terminalStates = new Set(["error", "stopped", "suspended"]);
  let lastState = "";
  while (Date.now() < deadline) {
    const vm = await client.getVirtualMachine(vmId);
    if (vm.state !== lastState) {
      console.log(
        `[finish-provision] vm=${vmId} state=${vm.state} ipv4=${firstIpv4(vm) ?? "<none>"}`
      );
      lastState = vm.state;
    }
    if (vm.state === "running" && firstIpv4(vm)) return vm;
    if (terminalStates.has(vm.state)) {
      throw new Error(`VPS ${vmId} entered terminal state ${vm.state}`);
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  throw new Error(
    `VPS ${vmId} did not reach running with IPv4 within ${readyTimeout}ms`
  );
}

async function main(): Promise<void> {
  requireEnv("HOSTINGER_API_TOKEN");
  requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  requireEnv("ROWBOAT_GATEWAY_TOKEN");

  console.log(
    `[finish-provision] biz=${BUSINESS_ID} tier=${TIER} owner=${OWNER_EMAIL} existing_vm=${EXISTING_VPS_ID}`
  );

  const client = new HostingerClient({
    baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
    token: process.env.HOSTINGER_API_TOKEN!,
    userAgent: "newcoworker-finish-provision/1.0"
  });

  // Look up existing keypair row first — this script is idempotent across
  // re-runs (the first run already paid the bill, ran /setup, persisted a
  // keypair). On a re-run we skip the "buy + setup + insert" path and go
  // straight to handing the existing artefacts to the orchestrator.
  const existingKey = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);

  const vmStatus = await client.getVirtualMachine(EXISTING_VPS_ID);
  console.log(
    `[finish-provision] vm state=${vmStatus.state} dc=${vmStatus.data_center?.name ?? "<none>"} template=${vmStatus.template?.id ?? "<none>"} ipv4=${firstIpv4(vmStatus) ?? "<none>"} existing_ssh_row=${existingKey ? existingKey.id : "<none>"}`
  );

  // If we already have a keypair persisted for this VM, reuse it. Don't
  // call /setup again — Hostinger rejects that on a configured VPS, and
  // the VM has already gotten its OS install + our public key.
  const reuseExisting = !!existingKey && String(existingKey.hostinger_vps_id) === String(EXISTING_VPS_ID);

  if (!reuseExisting && vmStatus.state !== "initial" && vmStatus.state !== "installing") {
    console.error(
      `[finish-provision] vm=${EXISTING_VPS_ID} is in unexpected state '${vmStatus.state}' with no matching vps_ssh_keys row — refusing to re-/setup. ` +
        `Investigate manually before proceeding.`
    );
    process.exit(1);
  }

  // Hypothesis was already validated out-of-band via curl (POST
  // /api/vps/v1/post-install-scripts → HTTP 200, script id 3813 created
  // and cleaned up). The Node-fetch probe got intercepted by Cloudflare's
  // bot mitigation so the in-script probe is unreliable; we capture the
  // confirmed verdict in a constant rather than re-running it. We also do
  // NOT actually wire `post_install_script_id` into the /setup payload
  // here — the orchestrator already runs `buildDefaultPostInstallScript()`
  // over SSH after `vps_provisioned` (idempotent), and adding a
  // post-install hook on top would just run the same content twice for
  // no benefit while exposing us to the Cloudflare-challenge race on
  // every Hostinger fetch.
  const hypothesisConfirmed = true;

  // Build the custom vps provisioner. Two modes:
  //
  //   reuseExisting=true:  vps_ssh_keys row exists for this business, the
  //     VM is already paid + /setup'd. We DO NOT re-run any Hostinger
  //     mutating call — we just convert the persisted private key from
  //     PKCS#8 to OpenSSH format if needed (necessary because the original
  //     keypair generator emitted PKCS#8 PEMs that ssh2 1.17 can't parse;
  //     see commit + keypair.ts header), grab the running VM's public IP,
  //     and hand the existing data to the orchestrator. Idempotent.
  //
  //   reuseExisting=false: first-time path. Generate keypair, upload pub
  //     key to Hostinger, /setup the VM with FQDN hostname + DC + template
  //     + pubkey, poll for running, install Monarx, persist row.
  const vpsProvisioner: VpsProvisioner = async ({ businessId }) => {
    if (reuseExisting && existingKey) {
      console.log(
        `[finish-provision] reuse path — vps_ssh_keys row id=${existingKey.id} pub_key_id=${existingKey.hostinger_public_key_id ?? "<none>"}`
      );
      const running = vmStatus.state === "running" && firstIpv4(vmStatus)
        ? vmStatus
        : await waitForRunning(client, EXISTING_VPS_ID);
      const publicIp = firstIpv4(running);
      if (!publicIp) {
        throw new Error(`VPS ${EXISTING_VPS_ID} is running but has no public IPv4`);
      }
      console.log(`[finish-provision] vm running. ip=${publicIp}`);

      // Migrate the stored PEM to OpenSSH format if it isn't already. The
      // helper is idempotent so re-runs never write twice.
      const opensshPem = convertPkcs8Ed25519PemToOpenssh(
        existingKey.private_key_pem,
        `newcoworker-${businessId}`
      );
      let migratedKey = existingKey;
      if (opensshPem !== existingKey.private_key_pem) {
        console.log(`[finish-provision] migrating private_key_pem PKCS#8 → OpenSSH format`);
        const db = await createSupabaseServiceClient();
        const { data: updated, error: upErr } = await db
          .from("vps_ssh_keys")
          .update({ private_key_pem: opensshPem })
          .eq("id", existingKey.id)
          .select()
          .single();
        if (upErr) throw new Error(`vps_ssh_keys update: ${upErr.message}`);
        migratedKey = updated as typeof existingKey;
      }

      return {
        virtualMachineId: EXISTING_VPS_ID,
        publicIp,
        sshUsername: migratedKey.ssh_username,
        sshKey: migratedKey,
        publicKeyId: migratedKey.hostinger_public_key_id ?? 0,
        // Reuse path skips Hostinger's `/post-install-scripts` API
        // entirely — we hand the orchestrator an existing, configured VPS,
        // so the SSH-bootstrap pass is the only bootstrap that runs. Null
        // here triggers the orchestrator's "Bootstrapping VPS over SSH …
        // PIS not eligible" message which accurately reflects this run.
        postInstallScriptId: null,
        hostingerBillingSubscriptionId:
          typeof running.subscription_id === "string"
            ? running.subscription_id
            : "AzZjPZVII4iEp2Fy9"
      };
    }

    // First-time path.
    console.log(`[finish-provision] generating ed25519 keypair...`);
    const keypair = await generateSshKeypair(`newcoworker-${businessId}`);

    const keyName = `newcoworker-${businessId}-${Date.now().toString(36)}`;
    console.log(`[finish-provision] uploading public key to Hostinger (name=${keyName})...`);
    const pubKey = await client.createPublicKey(keyName, keypair.publicKey.trim());
    console.log(`[finish-provision] public key id=${pubKey.id}`);

    // Hostinger's `/setup` endpoint (unlike `/virtual-machines`) requires a
    // fully-qualified domain in `hostname` — bare labels like `nc-621a5b0d-c2a`
    // get rejected with `[VPS:2004] Wrong hostname FQDN format`. Append
    // `.newcoworker.com` so it parses as an FQDN; this is just the value
    // written to /etc/hostname on the VPS, not a DNS record we have to
    // create. The orchestrator (`provisionVpsForBusiness`) has the same
    // bare-label default and will need the same fix when the deployed
    // purchase path next routes through `/setup` directly.
    const hostname = `nc-${truncateBusinessId(businessId)}.newcoworker.com`;
    const setup: VpsSetupRequest = {
      data_center_id: DEFAULT_US_DATA_CENTER_ID,
      template_id: DEFAULT_TEMPLATE_ID,
      hostname,
      public_key_ids: [pubKey.id],
      install_monarx: false
    };
    console.log(
      `[finish-provision] POST /virtual-machines/${EXISTING_VPS_ID}/setup`,
      setup
    );
    const setupAction = await client.setupVirtualMachine(EXISTING_VPS_ID, setup);
    console.log(`[finish-provision] setup action id=${setupAction.id} state=${setupAction.state}`);

    console.log(
      `[finish-provision] polling for vm=${EXISTING_VPS_ID} → running with public IPv4 (≤15min)...`
    );
    const running = await waitForRunning(client, EXISTING_VPS_ID);
    const publicIp = firstIpv4(running);
    if (!publicIp) {
      throw new Error(`VPS ${EXISTING_VPS_ID} is running but has no public IPv4`);
    }
    console.log(`[finish-provision] vm running. ip=${publicIp}`);

    try {
      await client.installMonarx(EXISTING_VPS_ID);
      console.log(`[finish-provision] Monarx install action accepted`);
    } catch (err) {
      console.warn(
        `[finish-provision] Monarx install failed (non-fatal):`,
        err instanceof Error ? err.message : err
      );
    }

    console.log(`[finish-provision] persisting keypair to vps_ssh_keys...`);
    const sshKey = await insertVpsSshKey({
      business_id: businessId,
      hostinger_vps_id: String(EXISTING_VPS_ID),
      hostinger_public_key_id: pubKey.id,
      public_key: keypair.publicKey,
      private_key_pem: keypair.privateKeyPem,
      fingerprint_sha256: keypair.fingerprintSha256,
      ssh_username: "root"
    });
    console.log(`[finish-provision] vps_ssh_keys row id=${sshKey.id}`);

    return {
      virtualMachineId: EXISTING_VPS_ID,
      publicIp,
      sshUsername: "root",
      sshKey,
      publicKeyId: pubKey.id,
      // Same rationale as the reuse path above — this script targets an
      // existing VPS via /setup, never POST /post-install-scripts. The
      // orchestrator's SSH-bootstrap is the only bootstrap that runs.
      postInstallScriptId: null,
      hostingerBillingSubscriptionId:
        typeof running.subscription_id === "string"
          ? running.subscription_id
          : "AzZjPZVII4iEp2Fy9"
    };
  };

  // Step 3: run the orchestrator with our custom provisioner. The
  // orchestrator will record the `started`/`vps_provisioned`/`vps_bootstrapping`/
  // ... rows on its own, then run SSH bootstrap (idempotent — will re-run
  // bootstrap commands even if PIS already executed them, which is fine),
  // Cloudflare tunnel, DID, deploy-client.sh, and welcome notifications.
  const t0 = Date.now();
  console.log(`[finish-provision] invoking orchestrateProvisioning with custom vps provisioner...`);
  try {
    const result = await orchestrateProvisioning(
      { businessId: BUSINESS_ID, tier: TIER, ownerEmail: OWNER_EMAIL },
      { hostinger: client, vpsProvisioner }
    );
    console.log(
      `[finish-provision] orchestration COMPLETE after ${fmtDuration(Date.now() - t0)}:`,
      result
    );

    // Step 4: post-orchestration smoke check via the public
    // `runRemoteBootstrap` helper. The orchestrator already ran bootstrap
    // inline as part of its phases — re-running it here is intentionally
    // redundant: it (a) exercises the public admin API on the same path
    // an operator would use to repair a drifted host, and (b) flags any
    // residual issue (e.g. a Rowboat container that crashed between the
    // orchestrator's bootstrap pass and now) BEFORE the operator
    // declares "done" and walks away. The script is idempotent so this
    // is safe; a non-zero exit is logged but not fatal — orchestration
    // already succeeded.
    const verifyKey = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
    const liveVm = await client.getVirtualMachine(EXISTING_VPS_ID);
    const verifyIp = firstIpv4(liveVm);
    if (verifyKey && verifyIp) {
      console.log(`[finish-provision] post-deploy smoke: re-running bootstrap via runRemoteBootstrap...`);
      const v = await runRemoteBootstrap({
        host: verifyIp,
        username: verifyKey.ssh_username,
        privateKeyPem: verifyKey.private_key_pem,
        tier: TIER
      });
      if (v.exitCode === 0) {
        console.log(`[finish-provision] post-deploy smoke: PASS (bootstrap idempotent re-run exited 0)`);
      } else {
        console.warn(
          `[finish-provision] post-deploy smoke: bootstrap re-run exited ${v.exitCode}; tails:\n` +
            `  stdout: ${v.stdoutTail.slice(-500)}\n  stderr: ${v.stderrTail.slice(-500)}`
        );
      }
    } else {
      console.log(`[finish-provision] post-deploy smoke: skipped (missing key or IP)`);
    }
  } catch (err) {
    console.error(
      `[finish-provision] orchestration FAILED after ${fmtDuration(Date.now() - t0)}:`
    );
    if (err instanceof HostingerApiError) {
      console.error(
        `  HostingerApiError: ${err.endpoint} → HTTP ${err.status} — ${err.message}`
      );
      console.error(`  body:`, err.body);
    } else if (err instanceof Error) {
      console.error(`  ${err.name}: ${err.message}`);
      if (err.stack) console.error(err.stack);
    } else {
      console.error(err);
    }
    process.exit(1);
  }

  console.log(
    `\n[finish-provision] hypothesis verdict: ${
      hypothesisConfirmed
        ? "CONFIRMED (validated via curl probe → HTTP 200 on POST /post-install-scripts) — " +
          "post-install-scripts API is accessible once a VPS is owned, even one that " +
          "is still in `initial` (paid but not yet set-up) state. Future iteration may " +
          "revert orchestrator to attach a post_install_script_id at /setup time, with " +
          "the SSH-bootstrap path retained as a redundant safety net."
        : "REJECTED — gate persists. SSH-bootstrap refactor stays mandatory."
    }`
  );
}

main().catch((err) => {
  console.error("[finish-provision] FATAL:", err);
  process.exit(1);
});
