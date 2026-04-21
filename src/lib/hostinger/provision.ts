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
 *   3. Ensure a post-install script is registered for first-boot setup.
 *   4. Purchase a VPS (price item `item_id`), passing the setup payload so
 *      the instance ships with our public key + post-install script attached.
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

/**
 * Price-item id for each tier.
 *
 * We hardcode the monthly-billing (`-1m`) SKUs; annual/biennial give a bigger
 * discount but lock capital longer than we want on a first-gen deploy. Ops
 * can override via env when this changes.
 */
export const DEFAULT_TIER_PRICE_ITEM: Record<"starter" | "standard", string> = {
  starter: "hostingercom-vps-kvm2-usd-1m",
  standard: "hostingercom-vps-kvm8-usd-1m"
};

/** Ubuntu 24.04 with Docker (verified via `GET /api/vps/v1/templates`). */
export const DEFAULT_TEMPLATE_ID = 1121;

/** Boston, US — the only US data center in Hostinger's fleet as of 2026-04-20. */
export const DEFAULT_US_DATA_CENTER_ID = 17;

export type ProvisionVpsForBusinessInput = {
  businessId: string;
  tier: "starter" | "standard";
  /** Override the price-item id (e.g. annual billing). */
  itemId?: string;
  /** Override the template (default: Ubuntu 24.04 with Docker). */
  templateId?: number;
  /** Override the data center (default: Boston, us). */
  dataCenterId?: number;
  /** Hostname assigned to the VPS. Defaults to a deterministic `nc-<biz>` label. */
  hostname?: string;
  /** Contents of the post-install script (see {@link buildDefaultPostInstallScript}). */
  postInstallScript: string;
  /** Optional override: a previously-registered script id (avoids re-uploading). */
  postInstallScriptId?: number;
  /** Optional Hostinger payment method id. Defaults to account default. */
  paymentMethodId?: number;
  /** Optional promo coupons. */
  coupons?: string[];
  /** Poll interval while waiting for VPS to become ready. Default 10s. */
  pollIntervalMs?: number;
  /** Total time budget to wait for VPS readiness. Default 15 min. */
  readyTimeoutMs?: number;
};

export type ProvisionVpsForBusinessResult = {
  virtualMachineId: number;
  /** Primary IPv4 address for SSH. */
  publicIp: string;
  /** SSH username. Always `root` on a fresh Hostinger VPS. */
  sshUsername: string;
  /** The row we wrote to `vps_ssh_keys`, including the private key PEM. */
  sshKey: VpsSshKeyRow;
  /** Id of the post-install script we registered (or reused). */
  postInstallScriptId: number;
  /** Id of the public key resource we registered. */
  publicKeyId: number;
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
  | "post_install_registered"
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

  const itemId = input.itemId ?? DEFAULT_TIER_PRICE_ITEM[input.tier];
  const templateId = input.templateId ?? DEFAULT_TEMPLATE_ID;
  const dataCenterId = input.dataCenterId ?? DEFAULT_US_DATA_CENTER_ID;
  const hostname = input.hostname ?? `nc-${truncateBusinessId(input.businessId)}`;
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

  // 3. Post-install script — reuse when the caller already registered one
  //    for this business (on a re-provision), otherwise create a new one.
  let postInstallScriptId: number;
  if (typeof input.postInstallScriptId === "number") {
    postInstallScriptId = input.postInstallScriptId;
  } else {
    const scriptName = `newcoworker-${input.businessId}`;
    const registered = await client.createPostInstallScript(scriptName, input.postInstallScript);
    postInstallScriptId = registered.id;
  }
  onProgress?.("post_install_registered", { postInstallScriptId });

  // 4. Purchase the VPS. `setup.public_key_ids` attaches at first boot, so
  //    SSH works immediately once cloud-init finishes — no later attach call.
  const setup: VpsSetupRequest = {
    data_center_id: dataCenterId,
    template_id: templateId,
    hostname,
    public_key_ids: [publicKeyResource.id],
    post_install_script_id: postInstallScriptId,
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
  onProgress?.("purchase_initiated", { itemId, hostname, dataCenterId, templateId });

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

  return {
    virtualMachineId: vm.id,
    publicIp,
    sshUsername: "root",
    sshKey,
    postInstallScriptId,
    publicKeyId: publicKeyResource.id
  };
}

/**
 * Default post-install script. Runs once, as root, on the VPS's first boot.
 *
 * Responsibilities:
 *  - Install baseline OS dependencies (git, rsync, jq, ufw, fail2ban, python3).
 *    Docker is already present because we purchase the `Ubuntu 24.04 with
 *    Docker` template (id 1121).
 *  - Harden SSH: disable password auth, keep root-with-key (we need it for
 *    orchestrator-side ssh exec).
 *  - Pre-stage the newCoworker repo at /opt/newcoworker-repo so
 *    `deploy-client.sh`'s rsync source is ready on the first orchestrator
 *    SSH exec.
 *  - Basic firewall: allow 22 (SSH) and 443 (HTTPS from Cloudflare tunnel).
 *    We do NOT open 8090 (voice bridge) publicly — the bridge is reached
 *    over the private Cloudflare tunnel.
 */
export function buildDefaultPostInstallScript(opts?: {
  repoUrl?: string;
  repoRef?: string;
}): string {
  const repoUrl = opts?.repoUrl ?? "https://github.com/brianlane/newCoworker.git";
  const repoRef = opts?.repoRef ?? "main";

  // Defense-in-depth: reject values that could break out of the bash string
  // even before single-quote escaping runs. `repoUrl` must be an http(s) URL;
  // `repoRef` must look like a git ref (no shell metachars, no spaces, no
  // leading `-` which would be interpreted as a git flag). This complements
  // the single-quote emission below — callers should never reach the script
  // generator with hostile input, but we belt-and-suspenders it because this
  // script runs as root on a fresh VPS.
  assertSafeRepoUrl(repoUrl);
  assertSafeRepoRef(repoRef);

  // Keep under 48KB (Hostinger hard limit). Idempotent by design so that a
  // recreate re-runs safely.
  return `#!/bin/bash
# newCoworker VPS bootstrap
# This runs ONCE as root on first boot (Hostinger post-install hook).
# Subsequent orchestrator-side deploys SSH in and run /opt/deploy-client.sh.
set -euo pipefail
exec > >(tee -a /post_install.log) 2>&1
echo "[newcoworker] post_install start: $(date -Is)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends git rsync jq ufw fail2ban python3 curl ca-certificates

# Docker is pre-installed by template 1121; verify.
if ! command -v docker >/dev/null 2>&1; then
  echo "[newcoworker] docker missing — installing via get.docker.com"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker || true
if ! command -v docker-compose >/dev/null 2>&1; then
  # We rely on the plugin, not the standalone binary; verify 'docker compose'.
  docker compose version >/dev/null 2>&1 || apt-get install -y docker-compose-plugin || true
fi

# Firewall: deny-by-default, allow SSH + 443. The voice bridge (8090) and
# anything else stays local — Cloudflare Tunnel carries public traffic.
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 443/tcp
ufw --force enable || true
systemctl enable --now fail2ban || true

# SSH hardening: key-auth only. We generated a fresh per-VPS keypair and it's
# already attached via Hostinger setup's public_key_ids — disabling password
# auth is safe here.
sed -ri 's/^#?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -ri 's/^#?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
# Keep 'PermitRootLogin prohibit-password' — Hostinger's default, and we need
# root+key for orchestrator exec. Do NOT flip to 'no' or deploys break.
systemctl reload ssh || systemctl reload sshd || true

# Stage the repo so deploy-client.sh's VOICE_BRIDGE_SRC rsync works.
# Values are emitted in single quotes so bash performs NO interpolation on
# them — this neutralises \`$(...)\`, backticks, and \\ even if the JS-side
# validators ever regress. Do not switch these back to double quotes.
REPO_URL=${bashSingleQuote(repoUrl)}
REPO_REF=${bashSingleQuote(repoRef)}
REPO_PATH="/opt/newcoworker-repo"
mkdir -p "$(dirname "$REPO_PATH")"
if [[ -d "$REPO_PATH/.git" ]]; then
  git -C "$REPO_PATH" fetch --depth=1 origin "$REPO_REF" || true
  git -C "$REPO_PATH" checkout -B "$REPO_REF" "origin/$REPO_REF" || true
else
  git clone --depth=1 --branch "$REPO_REF" "$REPO_URL" "$REPO_PATH" || \\
    echo "[newcoworker] WARN: repo clone failed — orchestrator deploy must re-sync"
fi

# Copy the deploy script to /opt so orchestrator SSH exec finds it there.
if [[ -f "$REPO_PATH/vps/scripts/deploy-client.sh" ]]; then
  install -m 0755 "$REPO_PATH/vps/scripts/deploy-client.sh" /opt/deploy-client.sh
fi

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

async function waitForVpsReady(
  client: HostingerClient,
  virtualMachineId: number,
  opts: { pollInterval: number; readyTimeout: number; sleep: (ms: number) => Promise<void> }
): Promise<VirtualMachine> {
  const deadline = Date.now() + opts.readyTimeout;
  // The VPS transitions through initial → installing → running. Error and
  // stopped are terminal failures we bail on loudly.
  while (Date.now() < deadline) {
    const vm = await client.getVirtualMachine(virtualMachineId);
    if (vm.state === "running" && firstIpv4(vm)) return vm;
    if (vm.state === "error") {
      throw new Error(`VPS ${virtualMachineId} is in state=error`);
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

