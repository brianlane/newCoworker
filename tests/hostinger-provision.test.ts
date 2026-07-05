import { describe, expect, it, vi } from "vitest";
import {
  provisionVpsForBusiness,
  buildDefaultPostInstallScript,
  resolvePriceItemId,
  DEFAULT_TEMPLATE_ID,
  DEFAULT_US_DATA_CENTER_ID,
  DEFAULT_TIER_PRICE_ITEM,
  VPS_SIZE_PRICE_ITEM
} from "@/lib/hostinger/provision";
import type { HostingerClient } from "@/lib/hostinger/client";

function makeClientStub<T extends Record<string, unknown> = Record<string, never>>(
  overrides: T = {} as T
) {
  return {
    createPublicKey: vi.fn().mockResolvedValue({ id: 9, name: "k", key: "ssh-ed25519 AAA k" }),
    // Hostinger post-install-script registration. Default success returns a
    // resource id; tests that exercise the 403 chicken-and-egg fallback
    // override this with a rejection. All tests that DON'T pass an
    // `input.postInstallScript` won't hit this stub at all because
    // provisionVpsForBusiness only calls it when content is provided.
    createPostInstallScript: vi
      .fn()
      .mockResolvedValue({ id: 555, name: "pis", content: "#!/bin/bash" }),
    purchaseVirtualMachine: vi.fn().mockResolvedValue({
      order_id: "o1",
      virtual_machines: [{ id: 42, state: "initial" }]
    }),
    getVirtualMachine: vi.fn(),
    installMonarx: vi.fn().mockResolvedValue({ id: 1, name: "a", state: "initiated" }),
    ...overrides
  } as T & {
    createPublicKey: ReturnType<typeof vi.fn>;
    createPostInstallScript: ReturnType<typeof vi.fn>;
    purchaseVirtualMachine: ReturnType<typeof vi.fn>;
    getVirtualMachine: ReturnType<typeof vi.fn>;
    installMonarx: ReturnType<typeof vi.fn>;
  };
}

/**
 * Minimal HostingerApiError-shaped stub. We don't import the real class to
 * keep this test decoupled from the client module — provisionVpsForBusiness
 * checks `err.name === "HostingerApiError"` duck-typed for the same reason
 * (see the `errStatus` helper in src/lib/hostinger/provision.ts).
 */
class FakeHostingerApiError extends Error {
  readonly endpoint: string;
  readonly status: number;
  readonly body: unknown;
  constructor(endpoint: string, status: number, body: unknown) {
    super(`Hostinger API ${endpoint} → HTTP ${status}`);
    this.name = "HostingerApiError";
    this.endpoint = endpoint;
    this.status = status;
    this.body = body;
  }
}

const fakeKeypair = {
  publicKey: "ssh-ed25519 AAAA test-comment\n",
  privateKeyPem: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
  fingerprintSha256: "SHA256:abcdef"
};

describe("provisionVpsForBusiness", () => {
  it("runs the full happy path: keypair → upload → purchase → poll → monarx → persist (no Hostinger post-install hook)", async () => {
    const client = makeClientStub({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValueOnce({ id: 42, state: "installing", ipv4: [] })
        .mockResolvedValueOnce({
          id: 42,
          state: "running",
          ipv4: [{ id: 1, address: "1.2.3.4" }]
        })
    });

    const dbInsert = vi.fn().mockResolvedValue({
      id: "row-uuid",
      business_id: "biz-1",
      hostinger_vps_id: "42",
      hostinger_public_key_id: 9,
      public_key: fakeKeypair.publicKey,
      private_key_pem: fakeKeypair.privateKeyPem,
      fingerprint_sha256: fakeKeypair.fingerprintSha256,
      ssh_username: "root",
      created_at: "2026-01-01T00:00:00Z",
      rotated_at: null
    });

    const phases: string[] = [];

    const result = await provisionVpsForBusiness(
      {
        businessId: "biz-1",
        tier: "starter",
        pollIntervalMs: 1,
        readyTimeoutMs: 10_000
      },
      {
        client: client as unknown as HostingerClient,
        generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
        sleep: vi.fn().mockResolvedValue(undefined),
        db: { insertVpsSshKey: dbInsert },
        onProgress: (p) => phases.push(p)
      }
    );

    expect(result).toEqual({
      virtualMachineId: 42,
      publicIp: "1.2.3.4",
      sshUsername: "root",
      sshKey: expect.objectContaining({ id: "row-uuid", business_id: "biz-1" }),
      publicKeyId: 9,
      // No `postInstallScript` was provided in the input above so the
      // attach API was never called → result is `null` and the orchestrator
      // will exclusively rely on its SSH-bootstrap phase. The PIS-attached
      // path is exercised by the dedicated `attaches a Hostinger…` tests
      // further down.
      postInstallScriptId: null,
      hostingerBillingSubscriptionId: null
    });
    expect(phases).toEqual([
      "keypair_generated",
      "public_key_uploaded",
      "purchase_initiated",
      "purchase_completed",
      "vps_running",
      "monarx_installed",
      "ssh_key_persisted"
    ]);

    expect(client.purchaseVirtualMachine).toHaveBeenCalledTimes(1);
    const purchaseArg = client.purchaseVirtualMachine.mock.calls[0][0];
    expect(purchaseArg.item_id).toBe(DEFAULT_TIER_PRICE_ITEM.starter);
    expect(purchaseArg.setup.template_id).toBe(DEFAULT_TEMPLATE_ID);
    expect(purchaseArg.setup.data_center_id).toBe(DEFAULT_US_DATA_CENTER_ID);
    expect(purchaseArg.setup.public_key_ids).toEqual([9]);
    // No `input.postInstallScript` was provided → no attach attempt → no
    // `post_install_script_id` on the setup payload.
    expect(purchaseArg.setup.post_install_script_id).toBeUndefined();
    expect(client.createPostInstallScript).not.toHaveBeenCalled();
    expect(purchaseArg.setup.install_monarx).toBe(false);
    // FQDN required: Hostinger 422s bare labels since Jul 2026 (VPS:2004).
    expect(purchaseArg.setup.hostname).toMatch(/^nc-[A-Za-z0-9-]+\.newcoworker\.com$/);
  });

  it("uses Hostinger billing subscription lookup when purchase response omits subscription_id", async () => {
    const client = makeClientStub({
      getVirtualMachine: vi.fn().mockResolvedValueOnce({
        id: 42,
        state: "running",
        ipv4: [{ id: 1, address: "1.2.3.4" }]
      }),
      listBillingSubscriptions: vi.fn().mockResolvedValue([
        { id: "billing-other", resource_id: "999" },
        { id: "billing-42", resource_id: "42" }
      ])
    });
    const dbInsert = vi.fn().mockResolvedValue({
      id: "row-uuid",
      business_id: "biz-1",
      hostinger_vps_id: "42",
      hostinger_public_key_id: 9,
      public_key: fakeKeypair.publicKey,
      private_key_pem: fakeKeypair.privateKeyPem,
      fingerprint_sha256: fakeKeypair.fingerprintSha256,
      ssh_username: "root",
      created_at: "2026-01-01T00:00:00Z",
      rotated_at: null
    });

    const result = await provisionVpsForBusiness(
      {
        businessId: "biz-1",
        tier: "starter",
        pollIntervalMs: 1,
        readyTimeoutMs: 10_000
      },
      {
        client: client as unknown as HostingerClient,
        generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
        sleep: vi.fn().mockResolvedValue(undefined),
        db: { insertVpsSshKey: dbInsert }
      }
    );

    expect(result.hostingerBillingSubscriptionId).toBe("billing-42");
  });

  it("keeps billing subscription id null when lookup finds no matching VPS", async () => {
    const client = makeClientStub({
      getVirtualMachine: vi.fn().mockResolvedValueOnce({
        id: 42,
        state: "running",
        ipv4: [{ id: 1, address: "1.2.3.4" }]
      }),
      listBillingSubscriptions: vi.fn().mockResolvedValue([
        { id: "billing-other", resource_id: "999" }
      ])
    });
    const dbInsert = vi.fn().mockResolvedValue({
      id: "row-uuid",
      business_id: "biz-1",
      hostinger_vps_id: "42",
      hostinger_public_key_id: 9,
      public_key: fakeKeypair.publicKey,
      private_key_pem: fakeKeypair.privateKeyPem,
      fingerprint_sha256: fakeKeypair.fingerprintSha256,
      ssh_username: "root",
      created_at: "2026-01-01T00:00:00Z",
      rotated_at: null
    });

    const result = await provisionVpsForBusiness(
      {
        businessId: "biz-1",
        tier: "starter",
        pollIntervalMs: 1,
        readyTimeoutMs: 10_000
      },
      {
        client: client as unknown as HostingerClient,
        generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
        sleep: vi.fn().mockResolvedValue(undefined),
        db: { insertVpsSshKey: dbInsert }
      }
    );

    expect(result.hostingerBillingSubscriptionId).toBeNull();
  });


  it("uses Hostinger subscription_id from the purchase response when present", async () => {
    const client = makeClientStub({
      purchaseVirtualMachine: vi.fn().mockResolvedValue({
        order_id: "o1",
        virtual_machines: [{ id: 42, state: "initial", subscription_id: "billing-direct" }]
      }),
      getVirtualMachine: vi.fn().mockResolvedValueOnce({
        id: 42,
        state: "running",
        ipv4: [{ id: 1, address: "1.2.3.4" }]
      }),
      listBillingSubscriptions: vi.fn()
    });
    const dbInsert = vi.fn().mockResolvedValue({
      id: "row-uuid",
      business_id: "biz-1",
      hostinger_vps_id: "42",
      hostinger_public_key_id: 9,
      public_key: fakeKeypair.publicKey,
      private_key_pem: fakeKeypair.privateKeyPem,
      fingerprint_sha256: fakeKeypair.fingerprintSha256,
      ssh_username: "root",
      created_at: "2026-01-01T00:00:00Z",
      rotated_at: null
    });

    const result = await provisionVpsForBusiness(
      {
        businessId: "biz-1",
        tier: "starter",
        pollIntervalMs: 1,
        readyTimeoutMs: 10_000
      },
      {
        client: client as unknown as HostingerClient,
        generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
        sleep: vi.fn().mockResolvedValue(undefined),
        db: { insertVpsSshKey: dbInsert }
      }
    );

    expect(result.hostingerBillingSubscriptionId).toBe("billing-direct");
    expect(client.listBillingSubscriptions).not.toHaveBeenCalled();
  });

  it("uses the standard-tier price-item id when tier=standard", async () => {
    const client = makeClientStub({
      getVirtualMachine: vi.fn().mockResolvedValueOnce({
        id: 42,
        state: "running",
        ipv4: [{ id: 1, address: "1.2.3.4" }]
      })
    });
    const dbInsert = vi.fn().mockResolvedValue({
      id: "r",
      business_id: "b",
      hostinger_vps_id: "42",
      hostinger_public_key_id: 9,
      public_key: "",
      private_key_pem: "",
      fingerprint_sha256: "",
      ssh_username: "root",
      created_at: "",
      rotated_at: null
    });

    await provisionVpsForBusiness(
      {
        businessId: "biz-1",
        tier: "standard",
        pollIntervalMs: 1
      },
      {
        client: client as unknown as HostingerClient,
        generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
        sleep: vi.fn(),
        db: { insertVpsSshKey: dbInsert }
      }
    );

    // No PIS content was passed → no attach API call → no
    // `post_install_script_id` on the setup payload. The PIS-attach path
    // (with its own happy-path + 403-fallback assertions) is covered by
    // the dedicated tests further down.
    expect(client.purchaseVirtualMachine.mock.calls[0][0].setup.post_install_script_id).toBeUndefined();
    expect(client.purchaseVirtualMachine.mock.calls[0][0].item_id).toBe(
      DEFAULT_TIER_PRICE_ITEM.standard
    );
  });

  it("buys the vps_size-pinned SKU when the pin differs from the tier default (standard on kvm2)", async () => {
    const client = makeClientStub({
      getVirtualMachine: vi.fn().mockResolvedValueOnce({
        id: 42,
        state: "running",
        ipv4: [{ id: 1, address: "1.2.3.4" }]
      })
    });
    const dbInsert = vi.fn().mockResolvedValue({
      id: "row",
      business_id: "biz-1",
      hostinger_vps_id: "42",
      hostinger_public_key_id: 9,
      public_key: "",
      private_key_pem: "",
      fingerprint_sha256: "",
      ssh_username: "root",
      created_at: "",
      rotated_at: null
    });

    await provisionVpsForBusiness(
      {
        businessId: "biz-1",
        tier: "standard",
        vpsSize: "kvm2",
        pollIntervalMs: 1
      },
      {
        client: client as unknown as HostingerClient,
        generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
        sleep: vi.fn(),
        db: { insertVpsSshKey: dbInsert }
      }
    );

    expect(client.purchaseVirtualMachine.mock.calls[0][0].item_id).toBe(
      VPS_SIZE_PRICE_ITEM.kvm2
    );
    // The tier-keyed map is now derived from the size-keyed one; pin the
    // linkage so a future edit can't silently fork the two.
    expect(DEFAULT_TIER_PRICE_ITEM.starter).toBe(VPS_SIZE_PRICE_ITEM.kvm1);
    expect(DEFAULT_TIER_PRICE_ITEM.standard).toBe(VPS_SIZE_PRICE_ITEM.kvm8);
  });

  it("attaches a Hostinger post-install script when content is provided (happy path)", async () => {
    const client = makeClientStub({
      createPostInstallScript: vi
        .fn()
        .mockResolvedValue({ id: 9001, name: "newcoworker-biz-1-abc", content: "" }),
      getVirtualMachine: vi.fn().mockResolvedValueOnce({
        id: 42,
        state: "running",
        ipv4: [{ id: 1, address: "1.2.3.4" }]
      })
    });
    const dbInsert = vi.fn().mockResolvedValue({
      id: "row",
      business_id: "biz-1",
      hostinger_vps_id: "42",
      hostinger_public_key_id: 9,
      public_key: fakeKeypair.publicKey,
      private_key_pem: fakeKeypair.privateKeyPem,
      fingerprint_sha256: fakeKeypair.fingerprintSha256,
      ssh_username: "root",
      created_at: "",
      rotated_at: null
    });
    const phases: string[] = [];

    const result = await provisionVpsForBusiness(
      {
        businessId: "biz-1",
        tier: "starter",
        postInstallScript: "#!/bin/bash\necho hi",
        postInstallScriptName: "custom-pis-name",
        pollIntervalMs: 1
      },
      {
        client: client as unknown as HostingerClient,
        generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
        sleep: vi.fn(),
        db: { insertVpsSshKey: dbInsert },
        onProgress: (p) => phases.push(p)
      }
    );

    expect(client.createPostInstallScript).toHaveBeenCalledWith(
      "custom-pis-name",
      "#!/bin/bash\necho hi"
    );
    expect(client.purchaseVirtualMachine.mock.calls[0][0].setup.post_install_script_id).toBe(9001);
    expect(result.postInstallScriptId).toBe(9001);
    expect(phases).toContain("post_install_script_registered");
  });

  it("falls back gracefully when post-install-script attach hits 403 (chicken-and-egg on fresh accounts)", async () => {
    const pisStub = vi
      .fn()
      .mockRejectedValueOnce(
        new FakeHostingerApiError("/api/vps/v1/post-install-scripts", 403, {
          message: "[VPS:2000] Unauthorized"
        })
      );
    const client = makeClientStub({
      createPostInstallScript: pisStub,
      getVirtualMachine: vi.fn().mockResolvedValueOnce({
        id: 42,
        state: "running",
        ipv4: [{ id: 1, address: "1.2.3.4" }]
      })
    });
    const dbInsert = vi.fn().mockResolvedValue({
      id: "row",
      business_id: "biz-1",
      hostinger_vps_id: "42",
      hostinger_public_key_id: 9,
      public_key: fakeKeypair.publicKey,
      private_key_pem: fakeKeypair.privateKeyPem,
      fingerprint_sha256: fakeKeypair.fingerprintSha256,
      ssh_username: "root",
      created_at: "",
      rotated_at: null
    });
    const phases: string[] = [];

    const result = await provisionVpsForBusiness(
      {
        businessId: "biz-1",
        tier: "starter",
        postInstallScript: "#!/bin/bash\necho hi",
        pollIntervalMs: 1
      },
      {
        client: client as unknown as HostingerClient,
        generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
        sleep: vi.fn(),
        db: { insertVpsSshKey: dbInsert },
        onProgress: (p) => phases.push(p)
      }
    );

    // 403 is swallowed → setup payload omits post_install_script_id and
    // result.postInstallScriptId is null. The orchestrator's SSH-bootstrap
    // pass is what bootstraps the host on this path.
    expect(pisStub).toHaveBeenCalledTimes(1);
    expect(client.purchaseVirtualMachine.mock.calls[0][0].setup.post_install_script_id).toBeUndefined();
    expect(result.postInstallScriptId).toBeNull();
    expect(phases).not.toContain("post_install_script_registered");
    // Provisioning still completed end-to-end.
    expect(phases).toContain("ssh_key_persisted");
  });

  it("re-throws non-403 errors from createPostInstallScript", async () => {
    const pisStub = vi
      .fn()
      .mockRejectedValueOnce(
        new FakeHostingerApiError("/api/vps/v1/post-install-scripts", 500, {
          message: "Internal Server Error"
        })
      );
    const client = makeClientStub({ createPostInstallScript: pisStub });
    await expect(
      provisionVpsForBusiness(
        {
          businessId: "biz-500",
          tier: "starter",
          postInstallScript: "#!/bin/bash\n",
          pollIntervalMs: 1
        },
        {
          client: client as unknown as HostingerClient,
          generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
          sleep: vi.fn(),
          db: {
            insertVpsSshKey: vi.fn().mockResolvedValue({
              id: "x",
              business_id: "",
              hostinger_vps_id: "",
              hostinger_public_key_id: 0,
              public_key: "",
              private_key_pem: "",
              fingerprint_sha256: "",
              ssh_username: "root",
              created_at: "",
              rotated_at: null
            })
          }
        }
      )
    ).rejects.toThrow(/HTTP 500/);
    // Purchase MUST NOT have happened — non-recoverable Hostinger errors
    // abort before we charge the customer's card.
    expect(client.purchaseVirtualMachine).not.toHaveBeenCalled();
  });

  it("re-throws when createPostInstallScript throws a HostingerApiError with a non-numeric status", async () => {
    // Branch coverage for `errStatus`: we only swallow 403 when the error's
    // `.status` is the *number* 403. A malformed HostingerApiError that
    // surfaces `.status: "403"` (string) — which can happen if a future
    // refactor of the client serialises it via JSON round-trip — must NOT
    // hit the 403 fast-path. Instead we re-throw, fail before the purchase,
    // and surface the underlying issue in the orchestrator's `failed` row.
    class StringStatusHostingerError extends Error {
      readonly endpoint = "/api/vps/v1/post-install-scripts";
      readonly status = "403" as unknown as number; /* DELIBERATELY wrong shape */
      readonly body = { message: "bad shape" };
      constructor() {
        super("Hostinger API HTTP <stringly-typed>");
        this.name = "HostingerApiError";
      }
    }
    const pisStub = vi.fn().mockRejectedValueOnce(new StringStatusHostingerError());
    const client = makeClientStub({ createPostInstallScript: pisStub });
    await expect(
      provisionVpsForBusiness(
        {
          businessId: "biz-stringly-status",
          tier: "starter",
          postInstallScript: "#!/bin/bash\n",
          pollIntervalMs: 1
        },
        {
          client: client as unknown as HostingerClient,
          generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
          sleep: vi.fn()
        }
      )
    ).rejects.toThrow(/<stringly-typed>/);
    // Stringly-typed status doesn't match the 403 swallow branch → purchase
    // never happens.
    expect(client.purchaseVirtualMachine).not.toHaveBeenCalled();
  });

  it("re-throws non-HostingerApiError errors from createPostInstallScript", async () => {
    // Defense-in-depth: a network-layer Error (not a HostingerApiError) has
    // no `.status`, so the 403 fast-path can't apply. The provisioner
    // should treat it as fatal and bail before charging the card.
    const pisStub = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET"));
    const client = makeClientStub({ createPostInstallScript: pisStub });
    await expect(
      provisionVpsForBusiness(
        {
          businessId: "biz-econn",
          tier: "starter",
          postInstallScript: "#!/bin/bash\n",
          pollIntervalMs: 1
        },
        {
          client: client as unknown as HostingerClient,
          generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
          sleep: vi.fn()
        }
      )
    ).rejects.toThrow(/ECONNRESET/);
    expect(client.purchaseVirtualMachine).not.toHaveBeenCalled();
  });

  it("uses a default timestamped script name when postInstallScriptName is omitted", async () => {
    const pisStub = vi
      .fn()
      .mockResolvedValue({ id: 9002, name: "auto", content: "" });
    const client = makeClientStub({
      createPostInstallScript: pisStub,
      getVirtualMachine: vi.fn().mockResolvedValueOnce({
        id: 42,
        state: "running",
        ipv4: [{ id: 1, address: "1.2.3.4" }]
      })
    });
    const dbInsert = vi.fn().mockResolvedValue({
      id: "r",
      business_id: "b",
      hostinger_vps_id: "42",
      hostinger_public_key_id: 9,
      public_key: "",
      private_key_pem: "",
      fingerprint_sha256: "",
      ssh_username: "root",
      created_at: "",
      rotated_at: null
    });

    await provisionVpsForBusiness(
      {
        businessId: "biz-default-name",
        tier: "starter",
        postInstallScript: "#!/bin/bash\n",
        pollIntervalMs: 1
      },
      {
        client: client as unknown as HostingerClient,
        generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
        sleep: vi.fn(),
        db: { insertVpsSshKey: dbInsert }
      }
    );

    expect(pisStub).toHaveBeenCalledWith(
      expect.stringMatching(/^newcoworker-biz-default-name-/),
      "#!/bin/bash\n"
    );
  });

  it("includes payment_method_id and coupons in the purchase when provided", async () => {
    const client = makeClientStub({
      getVirtualMachine: vi.fn().mockResolvedValueOnce({
        id: 42,
        state: "running",
        ipv4: [{ id: 1, address: "1.2.3.4" }]
      })
    });
    const dbInsert = vi.fn().mockResolvedValue({
      id: "r",
      business_id: "b",
      hostinger_vps_id: "42",
      hostinger_public_key_id: 9,
      public_key: "",
      private_key_pem: "",
      fingerprint_sha256: "",
      ssh_username: "root",
      created_at: "",
      rotated_at: null
    });

    await provisionVpsForBusiness(
      {
        businessId: "biz-1",
        tier: "starter",
        paymentMethodId: 42333536,
        coupons: ["WELCOME5"],
        pollIntervalMs: 1
      },
      {
        client: client as unknown as HostingerClient,
        generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
        sleep: vi.fn(),
        db: { insertVpsSshKey: dbInsert }
      }
    );

    const req = client.purchaseVirtualMachine.mock.calls[0][0];
    expect(req.payment_method_id).toBe(42333536);
    expect(req.coupons).toEqual(["WELCOME5"]);
  });

  it("bails with a clear error when purchase returns no virtual_machines", async () => {
    const client = makeClientStub({
      purchaseVirtualMachine: vi
        .fn()
        .mockResolvedValue({ order_id: "o1", virtual_machines: [] })
    });
    await expect(
      provisionVpsForBusiness(
        {
          businessId: "biz-1",
          tier: "starter",
          pollIntervalMs: 1
        },
        {
          client: client as unknown as HostingerClient,
          generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
          sleep: vi.fn()
        }
      )
    ).rejects.toThrow(/no virtual_machines/);
  });

  it("bails when getVirtualMachine eventually reports state=error", async () => {
    const client = makeClientStub({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValueOnce({ id: 42, state: "installing", ipv4: [] })
        .mockResolvedValueOnce({ id: 42, state: "error", ipv4: [] })
    });
    await expect(
      provisionVpsForBusiness(
        {
          businessId: "biz-1",
          tier: "starter",
          pollIntervalMs: 1
        },
        {
          client: client as unknown as HostingerClient,
          generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
          sleep: vi.fn()
        }
      )
    ).rejects.toThrow(/state=error/);
  });

  // Regression: the poll loop previously only checked state=error, so a VPS
  // that landed in `stopped` (billing decline / manual hPanel stop) or
  // `suspended` (account review) during provisioning would be polled for
  // the full readyTimeout (default 15 min) before failing. Both are
  // terminal from the orchestrator's perspective and must fail fast.
  it.each(["stopped", "suspended"] as const)(
    "bails when getVirtualMachine reports terminal state=%s",
    async (terminalState) => {
      const client = makeClientStub({
        getVirtualMachine: vi
          .fn()
          .mockResolvedValueOnce({ id: 42, state: "installing", ipv4: [] })
          .mockResolvedValueOnce({ id: 42, state: terminalState, ipv4: [] })
      });
      const sleep = vi.fn();
      await expect(
        provisionVpsForBusiness(
          {
            businessId: "biz-1",
            tier: "starter",
            pollIntervalMs: 1,
            // Deliberately very long — the test asserts we bail on the
            // terminal state *before* burning this window.
            readyTimeoutMs: 15 * 60 * 1000
          },
          {
            client: client as unknown as HostingerClient,
            generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
            sleep
          }
        )
      ).rejects.toThrow(new RegExp(`state=${terminalState}`));
      // Two polls: installing → terminal. We must NOT have kept polling.
      expect(client.getVirtualMachine).toHaveBeenCalledTimes(2);
    }
  );

  it("bails on timeout when VPS never reports running", async () => {
    const client = makeClientStub({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValue({ id: 42, state: "installing", ipv4: [] })
    });
    await expect(
      provisionVpsForBusiness(
        {
          businessId: "biz-1",
          tier: "starter",
          pollIntervalMs: 1,
          readyTimeoutMs: 5
        },
        {
          client: client as unknown as HostingerClient,
          generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
          sleep: vi.fn().mockResolvedValue(undefined)
        }
      )
    ).rejects.toThrow(/not running after 5ms/);
  });

  it("bails when VPS is running but has no public IPv4", async () => {
    const client = makeClientStub({
      getVirtualMachine: vi
        .fn()
        // Running but no IPv4 → falls through the ready check (`firstIpv4` is
        // falsy) and eventually times out. We give a tight timeout so the
        // test finishes fast.
        .mockResolvedValue({ id: 42, state: "running", ipv4: [] })
    });
    await expect(
      provisionVpsForBusiness(
        {
          businessId: "biz-1",
          tier: "starter",
          pollIntervalMs: 1,
          readyTimeoutMs: 5
        },
        {
          client: client as unknown as HostingerClient,
          generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
          sleep: vi.fn().mockResolvedValue(undefined)
        }
      )
    ).rejects.toThrow(/not running/);
  });

  it("continues (logs + emits no monarx_installed) when Monarx install throws", async () => {
    const client = makeClientStub({
      getVirtualMachine: vi.fn().mockResolvedValueOnce({
        id: 42,
        state: "running",
        ipv4: [{ id: 1, address: "1.2.3.4" }]
      }),
      installMonarx: vi.fn().mockRejectedValue(new Error("monarx unavailable"))
    });
    const dbInsert = vi.fn().mockResolvedValue({
      id: "row",
      business_id: "b",
      hostinger_vps_id: "42",
      hostinger_public_key_id: 9,
      public_key: "",
      private_key_pem: "",
      fingerprint_sha256: "",
      ssh_username: "root",
      created_at: "",
      rotated_at: null
    });
    const phases: string[] = [];

    const res = await provisionVpsForBusiness(
      {
        businessId: "biz-1",
        tier: "starter",
        pollIntervalMs: 1
      },
      {
        client: client as unknown as HostingerClient,
        generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
        sleep: vi.fn(),
        db: { insertVpsSshKey: dbInsert },
        onProgress: (p) => phases.push(p)
      }
    );

    expect(res.virtualMachineId).toBe(42);
    expect(phases).not.toContain("monarx_installed");
    expect(phases).toContain("ssh_key_persisted");
  });

  it("uses custom templateId/dataCenterId/hostname/itemId overrides", async () => {
    const client = makeClientStub({
      getVirtualMachine: vi.fn().mockResolvedValueOnce({
        id: 99,
        state: "running",
        ipv4: [{ id: 1, address: "9.9.9.9" }]
      }),
      purchaseVirtualMachine: vi.fn().mockResolvedValue({
        order_id: "o2",
        virtual_machines: [{ id: 99, state: "initial" }]
      })
    });
    const dbInsert = vi.fn().mockResolvedValue({
      id: "row",
      business_id: "b",
      hostinger_vps_id: "99",
      hostinger_public_key_id: 9,
      public_key: "",
      private_key_pem: "",
      fingerprint_sha256: "",
      ssh_username: "root",
      created_at: "",
      rotated_at: null
    });

    await provisionVpsForBusiness(
      {
        businessId: "custom-biz",
        tier: "starter",
        itemId: "custom-price",
        templateId: 7,
        dataCenterId: 29,
        hostname: "custom-host",
        pollIntervalMs: 1
      },
      {
        client: client as unknown as HostingerClient,
        generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
        sleep: vi.fn(),
        db: { insertVpsSshKey: dbInsert }
      }
    );

    const req = client.purchaseVirtualMachine.mock.calls[0][0];
    expect(req.item_id).toBe("custom-price");
    expect(req.setup.template_id).toBe(7);
    expect(req.setup.data_center_id).toBe(29);
    expect(req.setup.hostname).toBe("custom-host");
  });

  it("accepts pollIntervalMs default when omitted (uses injected sleep)", async () => {
    const client = makeClientStub({
      purchaseVirtualMachine: vi.fn().mockResolvedValue({
        order_id: "o",
        virtual_machines: [{ id: 66, state: "initial" }]
      }),
      getVirtualMachine: vi.fn().mockResolvedValueOnce({
        id: 66,
        state: "running",
        ipv4: [{ id: 1, address: "8.8.8.8" }]
      })
    });
    const dbInsert = vi.fn().mockResolvedValue({
      id: "r",
      business_id: "b",
      hostinger_vps_id: "66",
      hostinger_public_key_id: 9,
      public_key: "",
      private_key_pem: "",
      fingerprint_sha256: "",
      ssh_username: "root",
      created_at: "",
      rotated_at: null
    });
    const res = await provisionVpsForBusiness(
      {
        businessId: "biz-default-poll",
        tier: "starter",
      },
      {
        client: client as unknown as HostingerClient,
        generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
        sleep: vi.fn().mockResolvedValue(undefined),
        db: { insertVpsSshKey: dbInsert }
      }
    );
    expect(res.virtualMachineId).toBe(66);
  });

  it("defaults hostname to 'nc-unknown.newcoworker.com' when businessId has no valid chars", async () => {
    const client = makeClientStub({
      getVirtualMachine: vi.fn().mockResolvedValueOnce({
        id: 1,
        state: "running",
        ipv4: [{ id: 1, address: "1.1.1.1" }]
      })
    });
    const dbInsert = vi.fn().mockResolvedValue({
      id: "r",
      business_id: "",
      hostinger_vps_id: "1",
      hostinger_public_key_id: 9,
      public_key: "",
      private_key_pem: "",
      fingerprint_sha256: "",
      ssh_username: "root",
      created_at: "",
      rotated_at: null
    });
    await provisionVpsForBusiness(
      {
        businessId: "!!!",
        tier: "starter",
        pollIntervalMs: 1
      },
      {
        client: client as unknown as HostingerClient,
        generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
        sleep: vi.fn(),
        db: { insertVpsSshKey: dbInsert }
      }
    );
    expect(client.purchaseVirtualMachine.mock.calls[0][0].setup.hostname).toBe(
      "nc-unknown.newcoworker.com"
    );
  });
});

describe("buildDefaultPostInstallScript", () => {
  it("stays under Hostinger's 48KB limit", () => {
    const s = buildDefaultPostInstallScript();
    expect(s.length).toBeLessThan(48 * 1024);
  });

  it("uses default repo URL + ref + tier when no options are passed", () => {
    const s = buildDefaultPostInstallScript();
    expect(s).toContain("https://github.com/brianlane/newCoworker.git");
    expect(s).toContain("REPO_REF='main'");
    // Default tier is "standard" (KVM 8 safe pick) — the bootstrap loader
    // emits `TIER='standard' VPS_SIZE='kvm8' bash …`. Must be single-quoted
    // so the values are delivered to bootstrap.sh exactly as-is even if the
    // loader is later sourced from a context that mangles env propagation.
    expect(s).toContain("TIER='standard' VPS_SIZE='kvm8'");
  });

  it("accepts custom repo URL, ref, and tier (vpsSize follows the tier default)", () => {
    const s = buildDefaultPostInstallScript({
      repoUrl: "https://github.com/other/repo.git",
      repoRef: "release",
      tier: "starter"
    });
    expect(s).toContain("REPO_URL='https://github.com/other/repo.git'");
    expect(s).toContain("REPO_REF='release'");
    expect(s).toContain("TIER='starter' VPS_SIZE='kvm1'");
  });

  it("emits an explicit vpsSize pin independently of tier (standard-on-kvm2)", () => {
    const s = buildDefaultPostInstallScript({ tier: "standard", vpsSize: "kvm2" });
    expect(s).toContain("TIER='standard' VPS_SIZE='kvm2'");
  });

  it("resolves a null vpsSize to the tier default", () => {
    const s = buildDefaultPostInstallScript({ tier: "starter", vpsSize: null });
    expect(s).toContain("TIER='starter' VPS_SIZE='kvm1'");
  });

  it("rejects empty or overly long repoRef values", () => {
    // The length guard is a simple sanity check, not a security boundary
    // (the regex already blocks metachars), but we cover both endpoints so
    // future edits can't silently drop the bounds.
    expect(() => buildDefaultPostInstallScript({ repoRef: "" })).toThrow(
      /must be 1-255 chars/
    );
    expect(() =>
      buildDefaultPostInstallScript({ repoRef: "a".repeat(256) })
    ).toThrow(/must be 1-255 chars/);
  });

  it("rejects repoRef values that would enable shell command injection", () => {
    // Bash `$(...)` command substitution inside a double-quoted string was
    // the original vulnerability this guard prevents. Even though the emitter
    // now uses single quotes, we validate up-front so a regression in the
    // emitter can't silently re-open the hole.
    expect(() =>
      buildDefaultPostInstallScript({ repoRef: "main$(rm -rf /)" })
    ).toThrow(/disallowed characters/);
    expect(() =>
      buildDefaultPostInstallScript({ repoRef: "`id`" })
    ).toThrow(/disallowed characters/);
    expect(() =>
      buildDefaultPostInstallScript({ repoRef: "main; echo pwned" })
    ).toThrow(/disallowed characters/);
    expect(() =>
      buildDefaultPostInstallScript({ repoRef: "-foo" })
    ).toThrow(/must not start with/);
  });

  it("rejects repoUrl values that are not http(s) or contain shell metachars", () => {
    expect(() =>
      buildDefaultPostInstallScript({ repoUrl: "file:///etc/passwd" })
    ).toThrow(/must be http/);
    expect(() =>
      buildDefaultPostInstallScript({ repoUrl: "not a url" })
    ).toThrow(/invalid repoUrl/);
    expect(() =>
      buildDefaultPostInstallScript({ repoUrl: "https://evil.com/$(id).git" })
    ).toThrow(/disallowed characters/);
  });

  it("embeds an authorized_keys write when authorizedSshPublicKey is passed (Hostinger drops public_key_ids)", () => {
    // Hostinger's standalone setup/recreate/attach endpoints all silently
    // drop `public_key_ids` on some VMs (VM 1798267 KVM2 experiment,
    // VM 1806097 KVM1 Phase E smoke — recreate reported success twice, key
    // never landed). The PIS-embedded write is the deterministic attach path
    // the adopt flow depends on.
    const pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICxxHX3XEbCUn0ZjOJKqqPWw test-comment";
    const s = buildDefaultPostInstallScript({ authorizedSshPublicKey: pub });
    expect(s).toContain("mkdir -p /root/.ssh && chmod 700 /root/.ssh");
    expect(s).toContain(`echo '${pub}' >> /root/.ssh/authorized_keys`);
    expect(s).toContain("chmod 600 /root/.ssh/authorized_keys");
    // The write must land BEFORE the first apt invocation so SSH access
    // never depends on the (slow, failure-prone) package phase.
    expect(s.indexOf("/root/.ssh/authorized_keys")).toBeLessThan(s.indexOf("apt-get"));
    // Idempotence: re-running the script must not duplicate the key line.
    expect(s).toContain(`grep -qF '${pub}' /root/.ssh/authorized_keys`);
  });

  it("omits the authorized_keys block by default and for empty values", () => {
    expect(buildDefaultPostInstallScript()).not.toContain("authorized_keys");
    expect(
      buildDefaultPostInstallScript({ authorizedSshPublicKey: null })
    ).not.toContain("authorized_keys");
    expect(
      buildDefaultPostInstallScript({ authorizedSshPublicKey: "   " })
    ).not.toContain("authorized_keys");
  });

  it("rejects authorizedSshPublicKey values that are not single-line OpenSSH public keys", () => {
    expect(() =>
      buildDefaultPostInstallScript({
        authorizedSshPublicKey: "ssh-ed25519 AAAA\nssh-ed25519 BBBB"
      })
    ).toThrow(/single line/);
    expect(() =>
      buildDefaultPostInstallScript({
        authorizedSshPublicKey: "-----BEGIN OPENSSH PRIVATE KEY----- xxxx"
      })
    ).toThrow(/not a valid OpenSSH public key/);
    expect(() =>
      buildDefaultPostInstallScript({ authorizedSshPublicKey: "garbage" })
    ).toThrow(/not a valid OpenSSH public key/);
  });

  it("rejects unknown tier values (only starter|standard allowed)", () => {
    expect(() =>
      // @ts-expect-error -- intentionally invalid input, runtime guard catches.
      buildDefaultPostInstallScript({ tier: "enterprise" })
    ).toThrow(/tier must be 'starter' or 'standard'/);
    expect(() =>
      // @ts-expect-error -- intentionally invalid input, runtime guard catches.
      buildDefaultPostInstallScript({ tier: "" })
    ).toThrow(/tier must be 'starter' or 'standard'/);
  });

  it("includes the critical elements: repo staging, deploy script install, full bootstrap delegation", () => {
    const s = buildDefaultPostInstallScript();
    // The slim loader stages /opt/newcoworker-repo (so the orchestrator's
    // VOICE_BRIDGE_SRC rsync source exists) and installs deploy-client.sh
    // BEFORE delegating to the full bootstrap. Then it exec's the full
    // bootstrap with the tier env so heavy work (Docker, Ollama, Rowboat,
    // cloudflared) lives in the tracked repo file rather than this
    // 48KB-bounded inline script.
    expect(s).toContain("/opt/newcoworker-repo");
    expect(s).toContain("/opt/deploy-client.sh");
    expect(s).toContain("/vps/scripts/bootstrap.sh");
    expect(s).toContain("post_install start");
    expect(s).toContain("post_install complete");
  });

  it("uses apt lock-timeout for race protection but does NOT call cloud-init wait (Codex P1 + Bugbot High)", () => {
    // The slim loader runs in TWO places that race the dpkg lock:
    //   1. As Hostinger's first-boot PIS (cloud-init runcmd phase).
    //   2. As the orchestrator's SSH-bootstrap fallback / verify pass.
    // When PIS attaches AND the orchestrator's SSH pass fires while
    // cloud-init's runcmd is still running, both apt-get invocations
    // fight for /var/lib/dpkg/lock-frontend. Under `set -euo pipefail`
    // the loser exits non-zero and aborts provisioning.
    //
    // FIX: defence-in-depth via `-o DPkg::Lock::Timeout=300` on every
    // apt invocation so the loser of the race retries-with-backoff for
    // up to 5 minutes instead of bailing immediately.
    //
    // ANTI-FIX: we DELIBERATELY do NOT include `cloud-init status
    // --wait` in this script's body. On the PIS path, the script IS
    // executed by cloud-init's runcmd; calling `cloud-init status
    // --wait` from inside runcmd self-deadlocks (cloud-init can't
    // signal `done` until runcmd returns, but runcmd is waiting on
    // this wait → infinite hang). The orchestrator's SSH path gates
    // first-boot completion in `buildBootstrapSshCommand` BEFORE this
    // script runs, so a wait here is also redundant on that path.
    // This test pins both invariants together so a future regression
    // that re-adds the wait fails loudly instead of intermittently
    // hanging Hostinger PIS provisions.
    const s = buildDefaultPostInstallScript();
    // Strip shell comments before searching for the executable command:
    // the rationale for NOT calling cloud-init wait is documented in
    // the script header itself, so a naïve `includes()` would match
    // the comment text. We care about the actual command line.
    const codeOnly = s
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(codeOnly).not.toMatch(/(^|\s|;)cloud-init\s+status\s+--wait/);
    expect(s).toContain("DPkg::Lock::Timeout=300");
    // And both apt invocations (update + install) must use the timeout
    // option — a regression that drops it from one would silently
    // re-introduce the race.
    expect(s.match(/apt-get -y -o DPkg::Lock::Timeout=300 update/)).not.toBeNull();
    expect(s.match(/apt-get -y -o DPkg::Lock::Timeout=300 install/)).not.toBeNull();
    // DPkg::Lock::Timeout does NOT cover apt-get update's lists lock on the
    // template's apt (verified empirically Jul 2026 during Amy's cutover:
    // update bailed instantly while Hostinger's maintenance `apt` held
    // /var/lib/apt/lists/lock). Both apt invocations must therefore be
    // preceded by the explicit wait_for_apt lock-drain.
    expect(s).toContain("wait_for_apt() {");
    expect(s).toContain("fuser /var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend");
    expect(s.match(/wait_for_apt\napt-get -y -o DPkg::Lock::Timeout=300 update/)).not.toBeNull();
    expect(s.match(/wait_for_apt\napt-get -y -o DPkg::Lock::Timeout=300 install/)).not.toBeNull();
  });
});

describe("resolvePriceItemId", () => {
  const catalog = [
    {
      id: "plan-a",
      name: "A",
      category: "VPS",
      prices: [
        { id: "p-a-m", name: "monthly", currency: "USD", price: 1, period: 1, period_unit: "month" },
        { id: "p-a-y", name: "yearly", currency: "USD", price: 10, period: 1, period_unit: "year" }
      ]
    }
  ];

  it("returns monthly price id by default", () => {
    expect(resolvePriceItemId(catalog, "plan-a")).toBe("p-a-m");
  });

  it("returns yearly price id when specified", () => {
    expect(resolvePriceItemId(catalog, "plan-a", "year")).toBe("p-a-y");
  });

  it("returns null when plan is not found", () => {
    expect(resolvePriceItemId(catalog, "nope")).toBeNull();
  });

  it("returns null when the requested period is missing", () => {
    const thin = [{ id: "p", name: "p", category: "VPS", prices: [] }];
    expect(resolvePriceItemId(thin, "p")).toBeNull();
  });
});
