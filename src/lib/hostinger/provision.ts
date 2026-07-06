/**
 * High-level VPS provisioning for a single tenant business.
 *
 * Composes the raw Hostinger API primitives (`./client.ts`), key material
 * (`./keypair.ts`), and the DB keystore (`../db/vps-ssh-keys.ts`) into a
 * single function the orchestrator can call.
 *
 * Responsibilities (in order):
 *   1. Generate a fresh ed25519 keypair (comment = business id for audit).
 *   2. Upload the public half to Hostinger as a named resource.
 *   3. Try to register a post-install script via Hostinger's
 *      `/api/vps/v1/post-install-scripts`. On accounts that already own a
 *      VPS this returns 200 and we attach `post_install_script_id` to the
 *      setup payload so cloud-init runs the bootstrap at first boot.
 *      Brand-new accounts hit `403 [VPS:2000] Unauthorized` here — that's
 *      expected (chicken-and-egg: you can only register a script after the
 *      account owns at least one VPS), so we swallow the 403 and let the
 *      orchestrator's SSH-bootstrap path run the same script content over
 *      SSH after the VPS reaches `running`. Either path produces the same
 *      end state because the script is idempotent.
 *   4. Purchase a VPS (price item `item_id`), passing a setup payload that
 *      attaches our public key (and the post-install script id if step 3
 *      succeeded).
 *   5. Poll until the VPS reaches `running` and has a public IPv4.
 *   6. Install Monarx (malware scanner).
 *   7. Persist the private key + metadata in `vps_ssh_keys`.
 *
 * Docker Manager is enabled automatically because we purchase the Ubuntu
 * 24.04 + Docker template (id 1121); no API call is required. A separate
 * `createDockerProject` helper is available for callers that want to preload
 * compose projects.
 */

import { logger } from "@/lib/logger";
import {
  type Action,
  type CatalogItem,
  type HostingerClient,
  type VirtualMachine,
  type VpsPurchaseRequest,
  type VpsSetupRequest
} from "./client";
import { generateSshKeypair, type SshKeypair } from "./keypair";
import { insertVpsSshKey, type VpsSshKeyRow } from "@/lib/db/vps-ssh-keys";
import { resolveVpsSize, type VpsSize } from "@/lib/vps/size";

/**
 * Price-item id for each hardware size.
 *
 * We hardcode the monthly-billing (`-1m`) SKUs; annual/biennial give a bigger
 * discount but lock capital longer than we want on a first-gen deploy. Ops
 * can override via env when this changes.
 */
export const VPS_SIZE_PRICE_ITEM: Record<VpsSize, string> = {
  kvm1: "hostingercom-vps-kvm1-usd-1m",
  kvm2: "hostingercom-vps-kvm2-usd-1m",
  kvm4: "hostingercom-vps-kvm4-usd-1m",
  kvm8: "hostingercom-vps-kvm8-usd-1m"
};

/**
 * Historical tier → price-item mapping. Kept for callers (preflight script,
 * debug tooling) that reason in tier terms; new code should key off
 * {@link VPS_SIZE_PRICE_ITEM} via `resolveVpsSize`.
 */
export const DEFAULT_TIER_PRICE_ITEM: Record<"starter" | "standard", string> = {
  starter: VPS_SIZE_PRICE_ITEM.kvm1,
  standard: VPS_SIZE_PRICE_ITEM.kvm2
};

/** Ubuntu 24.04 with Docker (verified via `GET /api/vps/v1/templates`). */
export const DEFAULT_TEMPLATE_ID = 1121;

/**
 * Boston 2 — the only US data center in Hostinger's fleet as of 2026-04-29.
 *
 * The previous Boston DC (id 17) was retired and replaced with `bos2` (id 24).
 * `GET /api/vps/v1/data-centers` is the source of truth — verify with
 * `scripts/hostinger-preflight.ts` whenever Hostinger announces a fleet
 * change. Sending `data_center_id: 17` to the purchase endpoint after the
 * retirement returns HTTP 422 with `{ "errors": { "data_center_id": ["…"] } }`,
 * which surfaces as `Hostinger API HTTP 422` and prevents provisioning.
 */
export const DEFAULT_US_DATA_CENTER_ID = 24;

export type ProvisionVpsForBusinessInput = {
  businessId: string;
  tier: "starter" | "standard";
  /**
   * Hardware pin (`businesses.vps_size`). Omitted/null falls back to the
   * tier default (starter→kvm2, standard→kvm8). Drives the Hostinger SKU
   * only — entitlements stay on `tier`.
   */
  vpsSize?: VpsSize | null;
  /** Override the price-item id (e.g. annual billing). */
  itemId?: string;
  /** Override the template (default: Ubuntu 24.04 with Docker). */
  templateId?: number;
  /** Override the data center (default: Boston, us). */
  dataCenterId?: number;
  /** Hostname assigned to the VPS. Defaults to a deterministic `nc-<biz>` label. */
  hostname?: string;
  /** Optional Hostinger payment method id. Defaults to account default. */
  paymentMethodId?: number;
  /** Optional promo coupons. */
  coupons?: string[];
  /** Poll interval while waiting for VPS to become ready. Default 10s. */
  pollIntervalMs?: number;
  /** Total time budget to wait for VPS readiness. Default 15 min. */
  readyTimeoutMs?: number;
  /**
   * Inline content for the Hostinger post-install script. When provided we
   * try to register it via `POST /api/vps/v1/post-install-scripts` and
   * attach the resulting `post_install_script_id` to the setup payload so
   * it runs at first boot. On 403 (the chicken-and-egg the endpoint hits
   * for accounts without an existing VPS) we silently fall back to "no
   * script attached" — the orchestrator's SSH-bootstrap path runs the
   * same content after the VPS is up.
   *
   * When omitted we DO NOT attempt the API call (the orchestrator can
   * still choose to SSH-bootstrap on its own).
   */
  postInstallScript?: string;
  /**
   * Optional name for the post-install script resource. Defaults to a
   * timestamped `newcoworker-<biz>-<ts>` so re-provisions don't collide
   * with the previous run's resource in Hostinger's panel.
   */
  postInstallScriptName?: string;
};

export type ProvisionVpsForBusinessResult = {
  virtualMachineId: number;
  /** Primary IPv4 address for SSH. */
  publicIp: string;
  /** SSH username. Always `root` on a fresh Hostinger VPS. */
  sshUsername: string;
  /** The row we wrote to `vps_ssh_keys`, including the private key PEM. */
  sshKey: VpsSshKeyRow;
  /** Id of the public key resource we registered. */
  publicKeyId: number;
  /**
   * Id of the post-install-script resource we registered, if attaching
   * succeeded. `null` means either the caller didn't provide a script OR
   * the API rejected it (403 chicken-and-egg on a brand-new account).
   * Surfaced to the orchestrator so the SSH-bootstrap fallback can decide
   * how loudly to log.
   */
  postInstallScriptId: number | null;
  /**
   * Hostinger billing subscription id that backs this VPS. Required by the
   * lifecycle engine to cancel the VPS-side billing on user cancel. Pulled
   * from the purchase response; null if Hostinger didn't return it (we'll
   * fall back to a subscriptions-list lookup in that case).
   */
  hostingerBillingSubscriptionId: string | null;
};

export type ProvisionVpsDeps = {
  client: HostingerClient;
  /** Override keypair generation (testing). */
  generateKeypair?: (comment: string) => Promise<SshKeypair>;
  /** Override the sleep/polling primitive (testing). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Override DB writes (testing). Only `insertVpsSshKey` is consumed by
   * {@link provisionVpsForBusiness}; rotation / business-status writes happen
   * in the higher-level orchestrator (`src/lib/provisioning/orchestrate.ts`)
   * and are injected there, not here. Don't add fields to this shape without
   * a caller that actually reads them — stale override hooks give test
   * authors false confidence that their mocks are being exercised.
   */
  db?: {
    insertVpsSshKey?: typeof insertVpsSshKey;
  };
  /** Progress hook called after each significant step. */
  onProgress?: (phase: ProvisioningPhase, detail: Record<string, unknown>) => void;
};

export type ProvisioningPhase =
  | "keypair_generated"
  | "public_key_uploaded"
  | "post_install_script_registered"
  | "purchase_initiated"
  | "purchase_completed"
  | "vps_running"
  | "monarx_installed"
  | "ssh_key_persisted";

export async function provisionVpsForBusiness(
  input: ProvisionVpsForBusinessInput,
  deps: ProvisionVpsDeps
): Promise<ProvisionVpsForBusinessResult> {
  const {
    client,
    /* c8 ignore next -- production default; tests inject a fake keypair */
    generateKeypair = generateSshKeypair,
    /* c8 ignore next -- production default; tests inject a fake sleep */
    sleep = defaultSleep,
    onProgress
  } = deps;
  /* c8 ignore next -- production default; tests inject db.insertVpsSshKey */
  const dbInsert = deps.db?.insertVpsSshKey ?? insertVpsSshKey;

  const vpsSize = resolveVpsSize(input.tier, input.vpsSize);
  const itemId = input.itemId ?? VPS_SIZE_PRICE_ITEM[vpsSize];
  const templateId = input.templateId ?? DEFAULT_TEMPLATE_ID;
  const dataCenterId = input.dataCenterId ?? DEFAULT_US_DATA_CENTER_ID;
  // FQDN required: Hostinger's purchase-embedded setup historically accepted
  // bare labels (`nc-<uuid12>`), but as of Jul 2026 it 422s with
  // "[VPS:2004] Wrong hostname FQDN format" exactly like the standalone
  // setup endpoint always did (see adopt.ts). Same `nc-<uuid12>.<domain>`
  // shape the adopt path uses.
  const hostname = input.hostname ?? `nc-${truncateBusinessId(input.businessId)}.newcoworker.com`;
  const pollInterval = input.pollIntervalMs ?? 10_000;
  const readyTimeout = input.readyTimeoutMs ?? 15 * 60 * 1000;

  // 1. Keypair — comment includes the businessId for later audit + rotation.
  const keypair = await generateKeypair(`newcoworker-${input.businessId}`);
  onProgress?.("keypair_generated", { fingerprint: keypair.fingerprintSha256 });

  // 2. Upload the public half. Name is businessId-scoped so a key rotation
  //    doesn't collide with the previous one in Hostinger's account panel.
  const keyName = `newcoworker-${input.businessId}-${Date.now().toString(36)}`;
  const publicKeyResource = await client.createPublicKey(keyName, keypair.publicKey.trim());
  onProgress?.("public_key_uploaded", {
    publicKeyId: publicKeyResource.id,
    keyName
  });

  // 3. Try to register a Hostinger post-install script (PIS) so cloud-init
  //    runs the bootstrap at first boot — saves the orchestrator from
  //    waiting on sshd to come up before kicking off install. The endpoint
  //    is famously gated for fresh accounts: `POST /post-install-scripts`
  //    returns `403 [VPS:2000] Unauthorized` until the account already
  //    owns at least one VPS (chicken-and-egg). That 403 is expected and
  //    NOT an error — we degrade to "no script attached" and the
  //    orchestrator's SSH-bootstrap path runs the same content over SSH
  //    after the VPS reaches `running`. Both paths converge to the same
  //    final state because the script is idempotent.
  let postInstallScriptId: number | null = null;
  if (input.postInstallScript) {
    const scriptName =
      input.postInstallScriptName ??
      `newcoworker-${input.businessId}-${Date.now().toString(36)}`;
    try {
      const created = await client.createPostInstallScript(scriptName, input.postInstallScript);
      postInstallScriptId = created.id;
      onProgress?.("post_install_script_registered", {
        postInstallScriptId,
        scriptName
      });
    } catch (err) {
      const status = errStatus(err);
      if (status === 403) {
        // Expected on brand-new accounts. Log + continue; SSH-bootstrap
        // will pick up the slack downstream.
        logger.warn(
          "Hostinger post-install-scripts attach skipped (account not yet eligible — falling back to SSH-bootstrap)",
          {
            businessId: input.businessId,
            scriptName,
            status
          }
        );
      } else {
        throw err;
      }
    }
  }

  // 4. Purchase the VPS. `setup.public_key_ids` attaches at first boot, so
  //    SSH works immediately once cloud-init finishes — no later attach call.
  //    `post_install_script_id` is included only when step 3 succeeded; on
  //    fallback we let the orchestrator do the bootstrap over SSH.
  const setup: VpsSetupRequest = {
    data_center_id: dataCenterId,
    template_id: templateId,
    hostname,
    public_key_ids: [publicKeyResource.id],
    ...(postInstallScriptId !== null
      ? { post_install_script_id: postInstallScriptId }
      : {}),
    // Malware scanner is set up via its own endpoint below rather than the
    // setup payload's `install_monarx` flag — the dedicated endpoint returns
    // an Action we can track, whereas setup-embedded install is fire-and-forget.
    install_monarx: false
  };
  const purchaseReq: VpsPurchaseRequest = {
    item_id: itemId,
    setup,
    ...(input.paymentMethodId !== undefined ? { payment_method_id: input.paymentMethodId } : {}),
    /* c8 ignore next -- empty-coupons branch is trivial guard */
    ...(input.coupons && input.coupons.length > 0 ? { coupons: input.coupons } : {})
  };
  onProgress?.("purchase_initiated", {
    itemId,
    hostname,
    dataCenterId,
    templateId,
    postInstallScriptId
  });

  const order = await client.purchaseVirtualMachine(purchaseReq);
  if (!order.virtual_machines || order.virtual_machines.length === 0) {
    throw new Error(
      /* c8 ignore next -- order.order_id is always present in Hostinger responses */
      `Hostinger purchase returned no virtual_machines (orderId=${order.order_id ?? "?"})`
    );
  }
  const vm = order.virtual_machines[0];
  onProgress?.("purchase_completed", {
    virtualMachineId: vm.id,
    orderId: order.order_id
  });

  // 5. Poll for `running` + public IPv4. Hostinger's API returns the VPS
  //    immediately in `initial`/`installing`; we don't get an SSH-ready IP
  //    until it flips to `running`.
  const ready = await waitForVpsReady(client, vm.id, {
    pollInterval,
    readyTimeout,
    sleep
  });
  const publicIp = firstIpv4(ready);
  /* c8 ignore next 3 -- waitForVpsReady already enforces firstIpv4; guard is defensive */
  if (!publicIp) {
    throw new Error(`VPS ${vm.id} is running but has no public IPv4`);
  }
  onProgress?.("vps_running", { virtualMachineId: vm.id, publicIp });

  // 6. Install Monarx. We don't await the action to SUCCESS because Monarx
  //    install can take up to 60 minutes per Hostinger's docs; the API call
  //    itself is synchronous (returns an Action id), which is all we need.
  try {
    await client.installMonarx(vm.id);
    onProgress?.("monarx_installed", { virtualMachineId: vm.id });
  } catch (err) {
    // Non-fatal: Monarx is defense-in-depth, not a gate. Log and continue —
    // ops can retry via POST /api/vps/v1/virtual-machines/{id}/monarx.
    logger.warn("Monarx install failed; continuing without malware scanner", {
      businessId: input.businessId,
      virtualMachineId: vm.id,
      error: errToMessage(err)
    });
  }

  // 7. Persist the keypair so the orchestrator (and later redeploys) can
  //    SSH in. This is the last step — if anything above fails we never
  //    write a key to a VPS that doesn't exist.
  const sshKey = await dbInsert({
    business_id: input.businessId,
    hostinger_vps_id: String(vm.id),
    hostinger_public_key_id: publicKeyResource.id,
    public_key: keypair.publicKey,
    private_key_pem: keypair.privateKeyPem,
    fingerprint_sha256: keypair.fingerprintSha256,
    ssh_username: "root"
  });
  onProgress?.("ssh_key_persisted", { sshKeyId: sshKey.id });

  // `vm.subscription_id` is populated by Hostinger's purchase response. If
  // absent we fall back to a subscriptions-list lookup below so the lifecycle
  // engine always has a billing id to cancel.
  let hostingerBillingSubscriptionId = typeof vm.subscription_id === "string" ? vm.subscription_id : null;
  if (!hostingerBillingSubscriptionId) {
    try {
      const subs = await client.listBillingSubscriptions();
      const match = subs.find((s) => s.resource_id === String(vm.id));
      if (match?.id) hostingerBillingSubscriptionId = match.id;
    } catch (err) {
      logger.warn("Hostinger listBillingSubscriptions lookup failed", {
        businessId: input.businessId,
        virtualMachineId: vm.id,
        error: errToMessage(err)
      });
    }
  }

  return {
    virtualMachineId: vm.id,
    publicIp,
    sshUsername: "root",
    sshKey,
    publicKeyId: publicKeyResource.id,
    postInstallScriptId,
    hostingerBillingSubscriptionId
  };
}

/**
 * Default post-install / SSH-bootstrap script.
 *
 * The same content runs in two places:
 *   1. As Hostinger's first-boot hook (when {@link provisionVpsForBusiness}
 *      successfully attaches it via `POST /api/vps/v1/post-install-scripts`).
 *   2. As an orchestrator-side SSH exec (fallback when the PIS attach 403'd
 *      on a brand-new account) — see `runOrchestrator` in
 *      `src/lib/provisioning/orchestrate.ts`.
 *
 * Both invocations converge to the same end state because the script is
 * idempotent: it stages git+curl, clones our repo, installs deploy-client.sh
 * to /opt/, and then *delegates the heavy lifting to the FULL
 * `vps/scripts/bootstrap.sh`* in the repo. Keeping the heavy bootstrap in a
 * tracked file (rather than inlining it here) means changes to system
 * hardening / Ollama / Rowboat / cloudflared install land on every new VPS
 * via a normal commit, with no one-off post-install-script churn in
 * Hostinger's API.
 *
 * Hostinger's post-install-script payload is capped at 48KB so this MUST
 * stay slim — bootstrap.sh on the cloned repo is unbounded.
 */
export function buildDefaultPostInstallScript(opts?: {
  repoUrl?: string;
  repoRef?: string;
  /**
   * Entitlement tier passed through to the full bootstrap (`TIER=…` env).
   * Drives entitlement-side deploy behavior (e.g. the aiflow-render gate in
   * deploy-client.sh). Defaults to `standard`.
   */
  tier?: "starter" | "standard";
  /**
   * Hardware size passed through as `VPS_SIZE=…`. Drives ZRAM, Ollama
   * tuning/model, and which Rowboat compose profile to render. Defaults to
   * the tier's historical mapping (starter→kvm2, standard→kvm8). A KVM2
   * host MUST get `kvm2` or ZRAM swap won't be configured and Ollama will
   * crash-loop with the wrong parallelism settings.
   */
  vpsSize?: VpsSize | null;
  /**
   * When set, the script writes this OpenSSH public key into
   * `/root/.ssh/authorized_keys` before anything else. This is the
   * DETERMINISTIC key-attach path for adopt/recreate flows: Hostinger's
   * standalone setup, recreate, and attach endpoints all silently drop
   * `public_key_ids` on some VMs (observed on VM 1798267 during the KVM2
   * experiment and VM 1806097 during the KVM1 Phase E smoke, Jul 2026 —
   * recreate reported success twice, key never landed). Embedding the key
   * in the post-install script sidesteps the flaky attach entirely; the
   * purchase-embedded setup path still honors `public_key_ids` so this is
   * belt-and-suspenders there.
   */
  authorizedSshPublicKey?: string | null;
}): string {
  const repoUrl = opts?.repoUrl ?? "https://github.com/brianlane/newCoworker.git";
  const repoRef = opts?.repoRef ?? "main";
  const tier = opts?.tier ?? "standard";
  const vpsSize = resolveVpsSize(tier, opts?.vpsSize);
  const authorizedKey = opts?.authorizedSshPublicKey?.trim() || null;

  // Defense-in-depth: reject values that could break out of the bash string
  // even before single-quote escaping runs. `repoUrl` must be an http(s) URL;
  // `repoRef` must look like a git ref (no shell metachars, no spaces, no
  // leading `-` which would be interpreted as a git flag). This complements
  // the single-quote emission below — callers should never reach the script
  // generator with hostile input, but we belt-and-suspenders it because this
  // script runs as root on a fresh VPS.
  assertSafeRepoUrl(repoUrl);
  assertSafeRepoRef(repoRef);
  assertSafeTier(tier);
  if (authorizedKey !== null) {
    assertSafeAuthorizedKey(authorizedKey);
  }
  // vpsSize needs no assert: `resolveVpsSize` whitelists to 'kvm2'|'kvm8'
  // (any other input — including hostile strings — falls to the tier default).

  return `#!/bin/bash
# newCoworker VPS bootstrap (slim loader).
#
# Runs as root via either:
#   * Hostinger's post-install-script hook on first boot, OR
#   * orchestrator SSH-bootstrap fallback on accounts that aren't yet
#     PIS-eligible (see src/lib/hostinger/provision.ts header).
#
# Both paths are idempotent: re-running this script is a no-op except for a
# fresh \`git fetch\` + \`bash bootstrap.sh\` (which is itself idempotent).
set -euo pipefail
exec > >(tee -a /post_install.log) 2>&1
echo "[newcoworker] post_install start: $(date -Is)"
${
  authorizedKey !== null
    ? `
# Deterministic key attach: Hostinger's setup/recreate/attach endpoints all
# silently drop public_key_ids on some VMs — write the key ourselves, first
# thing, so SSH access never depends on their flaky attach.
mkdir -p /root/.ssh && chmod 700 /root/.ssh
grep -qF ${bashSingleQuote(authorizedKey)} /root/.ssh/authorized_keys 2>/dev/null || \\
  echo ${bashSingleQuote(authorizedKey)} >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
`
    : ""
}
# Race protection for the dual-path bootstrap (Hostinger PIS + orchestrator
# SSH fallback). When PIS attaches successfully, Hostinger's cloud-init
# executes THIS script via its \`runcmd\` module during first-boot. We
# deliberately do NOT call \`cloud-init status --wait\` here:
#
#   * Under PIS: \`runcmd\` is part of cloud-init's stages. \`cloud-init
#     status --wait\` would block waiting for cloud-init to signal \`done\`,
#     but cloud-init can't reach \`done\` until \`runcmd\` (i.e. this
#     script) returns — a hard self-deadlock the \`|| true\` guard cannot
#     cover (it only catches non-zero exits, not infinite hangs).
#   * Under SSH: the orchestrator's \`buildBootstrapSshCommand\` already
#     prefixes \`cloud-init status --wait\` BEFORE invoking this script,
#     so first-boot is already complete by the time we get here. A second
#     wait would be redundant.
#
# Defence-in-depth instead: \`-o DPkg::Lock::Timeout=300\` tells apt to
# retry-with-backoff for up to 5 minutes when ANY other apt
# (cloud-init's apt module, unattended-upgrades, etc.) holds the lock,
# instead of bailing immediately under \`set -euo pipefail\`. Safe under
# both paths.
#
# DPkg::Lock::Timeout does NOT cover \`apt-get update\`'s
# /var/lib/apt/lists/lock on the apt shipped with our template (verified
# empirically Jul 2026: update bailed instantly while Hostinger's own
# maintenance \`apt\` held the lists lock). Explicitly wait for both apt
# lock files to free before invoking apt at all.
wait_for_apt() {
  local deadline=$((SECONDS + 300))
  while fuser /var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      echo "[newcoworker] apt lock still held after 300s — proceeding (apt will retry via DPkg::Lock::Timeout)"
      break
    fi
    sleep 5
  done
}

export DEBIAN_FRONTEND=noninteractive
wait_for_apt
apt-get -y -o DPkg::Lock::Timeout=300 update
wait_for_apt
apt-get -y -o DPkg::Lock::Timeout=300 install --no-install-recommends git curl ca-certificates

# Stage the newCoworker repo. Values are emitted in single quotes so bash
# performs NO interpolation on them — this neutralises \`$(...)\`, backticks,
# and \\ even if the JS-side validators ever regress. Do not switch these
# back to double quotes.
REPO_URL=${bashSingleQuote(repoUrl)}
REPO_REF=${bashSingleQuote(repoRef)}
REPO_PATH="/opt/newcoworker-repo"
mkdir -p "$(dirname "$REPO_PATH")"
if [[ -d "$REPO_PATH/.git" ]]; then
  git -C "$REPO_PATH" fetch --depth=1 origin "$REPO_REF" || true
  git -C "$REPO_PATH" checkout -B "$REPO_REF" "origin/$REPO_REF" || true
else
  git clone --depth=1 --branch "$REPO_REF" "$REPO_URL" "$REPO_PATH" || \\
    { echo "[newcoworker] FATAL: repo clone failed — bootstrap cannot proceed"; exit 1; }
fi

# Install deploy-client.sh into /opt so the orchestrator's SSH exec finds it
# at a stable path. Done BEFORE running the full bootstrap so a partial
# bootstrap failure still leaves /opt/deploy-client.sh in place — letting
# operators retry deploy-client.sh independently.
if [[ -f "$REPO_PATH/vps/scripts/deploy-client.sh" ]]; then
  install -m 0755 "$REPO_PATH/vps/scripts/deploy-client.sh" /opt/deploy-client.sh
fi

# Hand off to the full bootstrap (system hardening, ZRAM, Docker, Ollama,
# Rowboat compose, cloudflared). \`TIER\` (entitlements) and \`VPS_SIZE\`
# (hardware: ZRAM, Ollama tuning, compose profile) are locked at
# script-generation time so a future bug in the orchestrator can't
# accidentally run a KVM 2 host with the KVM 8 hardware profile (which
# would OOM-kill it).
TIER=${bashSingleQuote(tier)} VPS_SIZE=${bashSingleQuote(vpsSize)} bash "$REPO_PATH/vps/scripts/bootstrap.sh"

echo "[newcoworker] post_install complete: $(date -Is)"
`;
}

/**
 * Wrap `value` in bash single quotes with correct escaping. Inside single
 * quotes bash performs zero interpolation, so the only character that needs
 * handling is the single quote itself, which we close, emit as an escaped
 * literal (`'\''`), and re-open.
 *
 * This is the canonical safe-shell-string pattern; see e.g. Python's
 * `shlex.quote` and Ruby's `Shellwords.escape`.
 */
function bashSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function assertSafeRepoUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`buildDefaultPostInstallScript: invalid repoUrl (not a URL): ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `buildDefaultPostInstallScript: repoUrl must be http(s), got ${parsed.protocol}`
    );
  }
  // Extra safety net: reject any ASCII control or shell metachars even though
  // `bashSingleQuote` would already neutralise them. This turns silent-but-
  // quoted values into loud errors during script build.
  if (/[\s`$\\"';&|<>]/.test(url)) {
    throw new Error(
      `buildDefaultPostInstallScript: repoUrl contains disallowed characters`
    );
  }
}

function assertSafeAuthorizedKey(key: string): void {
  // Single-line OpenSSH public key: `<type> <base64> [comment]`. The value is
  // emitted through bashSingleQuote so shell injection is already neutralised;
  // this validator exists to catch garbage (multi-line PEM blocks, private
  // keys) before it lands in authorized_keys and silently breaks SSH.
  if (/[\r\n]/.test(key)) {
    throw new Error(
      "buildDefaultPostInstallScript: authorizedSshPublicKey must be a single line"
    );
  }
  if (!/^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/=]+( [^\s][^\r\n]*)?$/.test(key)) {
    throw new Error(
      "buildDefaultPostInstallScript: authorizedSshPublicKey is not a valid OpenSSH public key"
    );
  }
}

function assertSafeRepoRef(ref: string): void {
  // Git refs permit a wide range of chars, but for our own repo staging we
  // only ever pass branch/tag names. Restrict to the intersection that is
  // safe everywhere (also no leading `-` to avoid `git checkout -B -foo`
  // being interpreted as a flag).
  if (ref.length === 0 || ref.length > 255) {
    throw new Error("buildDefaultPostInstallScript: repoRef must be 1-255 chars");
  }
  if (ref.startsWith("-")) {
    throw new Error("buildDefaultPostInstallScript: repoRef must not start with '-'");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new Error(
      `buildDefaultPostInstallScript: repoRef contains disallowed characters`
    );
  }
}

function assertSafeTier(tier: string): asserts tier is "starter" | "standard" {
  // Defense-in-depth: bootstrap.sh switches behavior on $TIER and the value
  // is interpolated into the slim loader's `TIER=…` env assignment. The
  // single-quote emitter neutralises shell metachars, but a bogus tier
  // string would still flow through to bootstrap.sh and silently mis-tier
  // the VPS (e.g. configuring ZRAM only when TIER=='starter'). Whitelist
  // the two values we support.
  if (tier !== "starter" && tier !== "standard") {
    throw new Error(
      `buildDefaultPostInstallScript: tier must be 'starter' or 'standard', got '${tier}'`
    );
  }
}

async function waitForVpsReady(
  client: HostingerClient,
  virtualMachineId: number,
  opts: { pollInterval: number; readyTimeout: number; sleep: (ms: number) => Promise<void> }
): Promise<VirtualMachine> {
  const deadline = Date.now() + opts.readyTimeout;
  // The happy path is initial → installing → running. Anything that lands
  // in `error`, `stopped`, or `suspended` during first-boot is a terminal
  // failure from the orchestrator's perspective:
  //   - error:     Hostinger reports the provision itself failed.
  //   - stopped:   the VPS reached a `stopped` state mid-provision (billing
  //                decline, ToS hold, or the user shut it down through
  //                hPanel). It won't transition to `running` without an
  //                out-of-band action.
  //   - suspended: Hostinger put the account into review. Same deal.
  // Fail fast instead of burning the full `readyTimeout` window (default 15
  // min) polling a VPS that will never become SSH-ready.
  const terminalStates = new Set(["error", "stopped", "suspended"]);
  while (Date.now() < deadline) {
    const vm = await client.getVirtualMachine(virtualMachineId);
    if (vm.state === "running" && firstIpv4(vm)) return vm;
    if (terminalStates.has(vm.state)) {
      throw new Error(`VPS ${virtualMachineId} is in state=${vm.state}`);
    }
    await opts.sleep(opts.pollInterval);
  }
  throw new Error(
    `VPS ${virtualMachineId} not running after ${opts.readyTimeout}ms (polling every ${opts.pollInterval}ms)`
  );
}

function firstIpv4(vm: VirtualMachine): string | undefined {
  if (!vm.ipv4 || !Array.isArray(vm.ipv4) || vm.ipv4.length === 0) return undefined;
  return vm.ipv4[0]?.address;
}

function truncateBusinessId(id: string): string {
  // Hostinger hostnames must be <= 63 chars per RFC 1035; `nc-` prefix + 12
  // chars of uuid keeps it safely under that and avoids hitting the VM count
  // duplicates on an account since UUID prefixes rarely collide.
  return id.replace(/[^A-Za-z0-9-]/g, "").slice(0, 12) || "unknown";
}

/* c8 ignore next 3 -- trivial default; tests inject a mock sleep */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* c8 ignore start -- non-Error rejections from client.installMonarx are defensive */
function errToMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
/* c8 ignore stop */

/**
 * Pull the HTTP status off a thrown error WITHOUT importing the
 * Hostinger client class (avoids an import cycle with the test harness
 * that injects a mock client). Mirrors the `name === "HostingerApiError"`
 * + numeric-status discriminator used in `src/lib/provisioning/orchestrate.ts`'s
 * `describeProvisioningError`.
 */
function errStatus(err: unknown): number | undefined {
  if (err instanceof Error && err.name === "HostingerApiError") {
    const e = err as Error & { status?: unknown };
    return typeof e.status === "number" ? e.status : undefined;
  }
  return undefined;
}

/**
 * Lookup wrapper around {@link CatalogItem} → price-item id so ops can audit
 * what the orchestrator would charge before pulling the trigger.
 */
export function resolvePriceItemId(
  catalog: CatalogItem[],
  planId: string,
  periodUnit: "month" | "year" = "month"
): string | null {
  const plan = catalog.find((c) => c.id === planId);
  if (!plan) return null;
  const price = plan.prices.find((p) => p.period_unit === periodUnit && p.period === 1);
  return price?.id ?? null;
}

