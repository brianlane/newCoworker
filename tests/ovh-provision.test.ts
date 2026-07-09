import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import {
  makeOvhProvisioner,
  ovhCartOsValue,
  provisionOvhVpsForBusiness
} from "@/lib/ovh/provision";
import type { OvhClient } from "@/lib/ovh/client";

const BIZ = "11111111-1111-4111-8111-111111111111";

const keypair = {
  publicKey: "ssh-ed25519 AAAA ovh\n",
  privateKeyPem: "OVH-PEM",
  fingerprintSha256: "SHA256:ovhfp"
};

function makeClient(overrides: Partial<Record<keyof OvhClient, unknown>> = {}) {
  let delivered = false;
  let rebuilt = false;
  const client = {
    listVps: vi.fn(async () => (delivered ? ["vps-old", "vps-new"] : ["vps-old"])),
    createCart: vi.fn(async () => ({ cartId: "cart-1" })),
    assignCart: vi.fn(async () => undefined),
    addVpsToCart: vi.fn(async () => ({ itemId: 7 })),
    configureCartItem: vi.fn(async () => undefined),
    checkoutCart: vi.fn(async () => {
      delivered = true;
      return { orderId: 9001 };
    }),
    getVps: vi.fn(async () => ({
      name: "vps-new",
      state: rebuilt ? "running" : "running"
    })),
    getAvailableImages: vi.fn(async () => [
      { id: "img-deb", name: "Debian 12" },
      { id: "img-ubu", name: "Ubuntu 24.04" }
    ]),
    rebuildVps: vi.fn(async () => {
      rebuilt = true;
      return { id: 42 };
    }),
    getVpsIps: vi.fn(async () => ["2607:5300::1", "203.0.113.44"]),
    ...overrides
  };
  return client as unknown as OvhClient & Record<string, ReturnType<typeof vi.fn>>;
}

function makeDeps(client: ReturnType<typeof makeClient>) {
  const insertVpsSshKey = vi.fn(async (input: Record<string, unknown>) => ({
    id: "row-ovh",
    business_id: BIZ,
    created_at: "2026-07-08T00:00:00Z",
    rotated_at: null,
    hostinger_public_key_id: null,
    ...input
  }));
  return {
    client,
    generateKeypair: vi.fn(async () => keypair),
    sleep: vi.fn(async () => undefined),
    db: { insertVpsSshKey: insertVpsSshKey as never },
    env: {} as Record<string, string | undefined>,
    insertVpsSshKey
  };
}

describe("ovhCartOsValue", () => {
  it("defaults to Ubuntu 24.04 with env override + blank fall-through", () => {
    expect(ovhCartOsValue({})).toBe("Ubuntu 24.04");
    expect(ovhCartOsValue({ OVH_VPS_OS: " Ubuntu 26.04 " })).toBe("Ubuntu 26.04");
    expect(ovhCartOsValue({ OVH_VPS_OS: "  " })).toBe("Ubuntu 24.04");
  });
});

describe("provisionOvhVpsForBusiness", () => {
  beforeEach(() => vi.clearAllMocks());

  it("orders in bhs, discovers the delivered box by diff, rebuilds with the key, persists + returns the standard shape", async () => {
    const client = makeClient();
    const deps = makeDeps(client);

    const res = await provisionOvhVpsForBusiness(
      { businessId: BIZ, vpsSize: "kvm8", pollIntervalMs: 1, readyTimeoutMs: 1000 },
      deps
    );

    // Cart flow: bhs datacenter + OS configured on the added item.
    expect(client.addVpsToCart).toHaveBeenCalledWith("cart-1", {
      planCode: expect.any(String),
      duration: "P1M",
      pricingMode: "default"
    });
    expect(client.createCart).toHaveBeenCalledWith("US");
    expect(client.configureCartItem).toHaveBeenCalledWith("cart-1", 7, "vps_datacenter", "BHS");
    expect(client.configureCartItem).toHaveBeenCalledWith("cart-1", 7, "vps_os", "Ubuntu 24.04");

    // Deterministic key attach: rebuild carries the trimmed public key.
    expect(client.rebuildVps).toHaveBeenCalledWith("vps-new", {
      imageId: "img-ubu",
      publicSshKey: "ssh-ed25519 AAAA ovh"
    });

    // Key persisted with provider/region/host, box id = service name.
    expect(deps.insertVpsSshKey).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ,
        hostinger_vps_id: "vps-new",
        provider: "ovh",
        region: "ca",
        host: "203.0.113.44",
        ssh_username: "root"
      })
    );

    expect(res).toEqual(
      expect.objectContaining({
        virtualMachineId: "vps-new",
        publicIp: "203.0.113.44",
        sshUsername: "root",
        publicKeyId: null,
        postInstallScriptId: null,
        hostingerBillingSubscriptionId: null
      })
    );
  });

  it("polls through installing → running before rebuilding, and rebuilding → running after", async () => {
    const states = ["installing", "running", "rebuilding", "running"];
    const client = makeClient({
      getVps: vi.fn(async () => ({ name: "vps-new", state: states.shift() ?? "running" }))
    });
    const deps = makeDeps(client);
    await provisionOvhVpsForBusiness(
      { businessId: BIZ, vpsSize: "kvm2", pollIntervalMs: 1, readyTimeoutMs: 1000 },
      deps
    );
    expect(deps.sleep).toHaveBeenCalled();
  });

  it("times out when the order never delivers a new service name", async () => {
    const client = makeClient({
      listVps: vi.fn(async () => ["vps-old"]),
      checkoutCart: vi.fn(async () => ({ orderId: 1 }))
    });
    const deps = makeDeps(client);
    await expect(
      provisionOvhVpsForBusiness(
        { businessId: BIZ, vpsSize: "kvm8", pollIntervalMs: 1, readyTimeoutMs: 5 },
        deps
      )
    ).rejects.toThrow(/Timed out waiting for OVH order 1 delivery/);
  });

  it("fails loudly when no Ubuntu 24.04 image is available", async () => {
    const client = makeClient({
      getAvailableImages: vi.fn(async () => [{ id: "img-deb", name: "Debian 12" }])
    });
    const deps = makeDeps(client);
    await expect(
      provisionOvhVpsForBusiness(
        { businessId: BIZ, vpsSize: "kvm8", pollIntervalMs: 1, readyTimeoutMs: 1000 },
        deps
      )
    ).rejects.toThrow(/no image matching 'ubuntu 24.04'.*Debian 12/is);
  });

  it("fails loudly when the empty image list yields no match", async () => {
    const client = makeClient({
      getAvailableImages: vi.fn(async () => [])
    });
    const deps = makeDeps(client);
    await expect(
      provisionOvhVpsForBusiness(
        { businessId: BIZ, vpsSize: "kvm8", pollIntervalMs: 1, readyTimeoutMs: 1000 },
        deps
      )
    ).rejects.toThrow(/<none>/);
  });

  it("fails loudly when the running box has no public IPv4 (and never persists a key)", async () => {
    const client = makeClient({
      getVpsIps: vi.fn(async () => ["2607:5300::1"])
    });
    const deps = makeDeps(client);
    await expect(
      provisionOvhVpsForBusiness(
        { businessId: BIZ, vpsSize: "kvm8", pollIntervalMs: 1, readyTimeoutMs: 1000 },
        deps
      )
    ).rejects.toThrow(/no public IPv4/);
    expect(deps.insertVpsSshKey).not.toHaveBeenCalled();
  });

  it("makeOvhProvisioner adapts the orchestrator input shape (production defaults for env/timeouts)", async () => {
    const client = makeClient();
    const deps = makeDeps(client);
    // `env` deliberately omitted → the process.env default arm is used; the
    // stub client resolves instantly so the default timeouts never elapse.
    const provision = makeOvhProvisioner({
      client,
      generateKeypair: deps.generateKeypair,
      sleep: deps.sleep,
      db: deps.db
    });
    const res = await provision({ businessId: BIZ, tier: "standard", vpsSize: "kvm8" });
    expect(res.virtualMachineId).toBe("vps-new");
  });
});
