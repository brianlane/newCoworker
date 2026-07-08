/**
 * High-level OVH VPS provisioning for a single tenant business — the
 * Canadian (Beauharnois) analog of `provisionVpsForBusiness` in
 * src/lib/hostinger/provision.ts. Returns the same result shape so the
 * orchestrator's downstream phases (SSH bootstrap, tunnel, DID, deploy,
 * gateway token) run unchanged.
 *
 * Sequence:
 *   1. Generate a fresh ed25519 keypair (comment = business id).
 *   2. Snapshot the account's VPS service names BEFORE checkout — OVH's
 *      checkout response carries an orderId, not the delivered service
 *      name, so the new box is identified by diffing the list.
 *   3. Order-cart purchase: create/assign cart, add the size's plan code,
 *      configure vps_datacenter=bhs + vps_os, checkout with auto-pay.
 *   4. Poll `GET /vps` until a NEW service name appears, then poll its
 *      state until it leaves `installing`.
 *   5. Rebuild with Ubuntu 24.04 + the public key. The rebuild is the
 *      DETERMINISTIC key attach (lesson from Hostinger's flaky
 *      `public_key_ids`): the key lands in root's authorized_keys as part
 *      of the OS install, not via a separate attach call.
 *   6. Poll state back to `running`, resolve the public IPv4.
 *   7. Persist the keypair to `vps_ssh_keys` (provider='ovh', region='ca',
 *      host=IP, box id = the OVH service name). Last step, same as the
 *      Hostinger path — never persist a key to a box that doesn't exist.
 */

import { logger } from "@/lib/logger";
import { OvhClient } from "./client";
import {
  OVH_DATACENTER_CANADA,
  OVH_DEFAULT_DURATION,
  OVH_DEFAULT_PRICING_MODE,
  OVH_UBUNTU_IMAGE_MATCH,
  ovhPlanCodeForSize
} from "./plans";
import { generateSshKeypair, type SshKeypair } from "@/lib/hostinger/keypair";
import { insertVpsSshKey } from "@/lib/db/vps-ssh-keys";
import type { ProvisionVpsForBusinessResult } from "@/lib/hostinger/provision";
import type { VpsProvisioner } from "@/lib/provisioning/orchestrate";
import type { VpsSize } from "@/lib/vps/size";

export type ProvisionOvhVpsInput = {
  businessId: string;
  vpsSize: VpsSize;
  /** Poll interval while waiting for delivery/state. Default 15s. */
  pollIntervalMs?: number;
  /** Total budget for delivery + install waits. Default 20 min each phase. */
  readyTimeoutMs?: number;
};

export type ProvisionOvhVpsDeps = {
  client: OvhClient;
  /** Override keypair generation (testing). */
  generateKeypair?: (comment: string) => Promise<SshKeypair>;
  /** Override the sleep primitive (testing). */
  sleep?: (ms: number) => Promise<void>;
  db?: {
    insertVpsSshKey?: typeof insertVpsSshKey;
  };
  /** Injectable env for the vps_os cart value + plan overrides (testing). */
  env?: Record<string, string | undefined>;
};

/**
 * The `vps_os` order-cart configuration value. The rebuild step re-images
 * the box anyway (that's where the SSH key lands), so this only needs to be
 * a value the catalog accepts; overridable when OVH renames it.
 */
export function ovhCartOsValue(env: Record<string, string | undefined> = process.env): string {
  const override = env.OVH_VPS_OS;
  if (typeof override === "string" && override.trim().length > 0) return override.trim();
  return "Ubuntu 24.04";
}

export async function provisionOvhVpsForBusiness(
  input: ProvisionOvhVpsInput,
  deps: ProvisionOvhVpsDeps
): Promise<ProvisionVpsForBusinessResult> {
  const {
    client,
    /* c8 ignore next -- production default; tests inject a fake keypair */
    generateKeypair = generateSshKeypair,
    /* c8 ignore next -- production default; tests inject a fake sleep */
    sleep = defaultSleep
  } = deps;
  /* c8 ignore next -- production default; tests inject db.insertVpsSshKey */
  const dbInsert = deps.db?.insertVpsSshKey ?? insertVpsSshKey;
  const env = deps.env ?? process.env;
  const pollInterval = input.pollIntervalMs ?? 15_000;
  const readyTimeout = input.readyTimeoutMs ?? 20 * 60 * 1000;

  const keypair = await generateKeypair(`newcoworker-ovh-${input.businessId}`);

  // 2. Pre-checkout snapshot — the delivered service name is found by diff.
  const before = new Set(await client.listVps());

  // 3. Order-cart purchase.
  const planCode = ovhPlanCodeForSize(input.vpsSize, env);
  const cart = await client.createCart("CA");
  await client.assignCart(cart.cartId);
  const item = await client.addVpsToCart(cart.cartId, {
    planCode,
    duration: OVH_DEFAULT_DURATION,
    pricingMode: OVH_DEFAULT_PRICING_MODE
  });
  await client.configureCartItem(cart.cartId, item.itemId, "vps_datacenter", OVH_DATACENTER_CANADA);
  await client.configureCartItem(cart.cartId, item.itemId, "vps_os", ovhCartOsValue(env));
  const order = await client.checkoutCart(cart.cartId);
  logger.info("OVH VPS ordered", {
    businessId: input.businessId,
    planCode,
    orderId: order.orderId
  });

  // 4. Wait for delivery (a new service name), then for install to finish.
  const serviceName = await waitFor(
    async () => {
      const names = await client.listVps();
      return names.find((n) => !before.has(n)) ?? null;
    },
    { what: `OVH order ${order.orderId} delivery`, pollInterval, readyTimeout, sleep }
  );
  await waitFor(
    async () => {
      const vps = await client.getVps(serviceName);
      return vps.state !== "installing" ? vps.state : null;
    },
    { what: `OVH ${serviceName} initial install`, pollInterval, readyTimeout, sleep }
  );

  // 5. Rebuild with Ubuntu 24.04 + our key (deterministic key attach).
  const images = await client.getAvailableImages(serviceName);
  const ubuntu = images.find((img) =>
    img.name.toLowerCase().includes(OVH_UBUNTU_IMAGE_MATCH.toLowerCase())
  );
  if (!ubuntu) {
    throw new Error(
      `OVH ${serviceName}: no image matching '${OVH_UBUNTU_IMAGE_MATCH}' available ` +
        `(got: ${images.map((i) => i.name).join(", ") || "<none>"})`
    );
  }
  await client.rebuildVps(serviceName, {
    imageId: ubuntu.id,
    publicSshKey: keypair.publicKey.trim()
  });

  // 6. Back to running, then resolve the IPv4.
  await waitFor(
    async () => {
      const vps = await client.getVps(serviceName);
      return vps.state === "running" ? vps.state : null;
    },
    { what: `OVH ${serviceName} rebuild`, pollInterval, readyTimeout, sleep }
  );
  const ips = await client.getVpsIps(serviceName);
  const publicIp = ips.find((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip));
  if (!publicIp) {
    throw new Error(`OVH ${serviceName} is running but has no public IPv4 (ips: ${ips.join(", ")})`);
  }

  // 7. Persist the key — last, so a failed provision never strands a row.
  const sshKey = await dbInsert({
    business_id: input.businessId,
    hostinger_vps_id: serviceName,
    hostinger_public_key_id: null,
    public_key: keypair.publicKey,
    private_key_pem: keypair.privateKeyPem,
    fingerprint_sha256: keypair.fingerprintSha256,
    ssh_username: "root",
    provider: "ovh",
    region: "ca",
    host: publicIp
  });
  logger.info("OVH VPS provisioned", {
    businessId: input.businessId,
    serviceName,
    publicIp
  });

  return {
    virtualMachineId: serviceName,
    publicIp,
    sshUsername: "root",
    sshKey,
    publicKeyId: null,
    postInstallScriptId: null,
    // OVH billing is keyed on the service name itself (serviceInfos /
    // delete-at-expiration) — there is no separate billing-subscription id.
    hostingerBillingSubscriptionId: null
  };
}

/**
 * VpsProvisioner adapter for the orchestrator (provider='ovh').
 */
export function makeOvhProvisioner(deps: ProvisionOvhVpsDeps): VpsProvisioner {
  return ({ businessId, vpsSize }) =>
    provisionOvhVpsForBusiness({ businessId, vpsSize }, deps);
}

async function waitFor<T>(
  probe: () => Promise<T | null>,
  opts: {
    what: string;
    pollInterval: number;
    readyTimeout: number;
    sleep: (ms: number) => Promise<void>;
  }
): Promise<T> {
  const deadline = Date.now() + opts.readyTimeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== null) return result;
    await opts.sleep(opts.pollInterval);
  }
  throw new Error(
    `Timed out waiting for ${opts.what} after ${opts.readyTimeout}ms (polling every ${opts.pollInterval}ms)`
  );
}

/* c8 ignore next 3 -- trivial default; tests inject a mock sleep */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
