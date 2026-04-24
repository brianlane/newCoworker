import { describe, expect, it, vi } from "vitest";
import {
  provisionVpsForBusiness,
  buildDefaultPostInstallScript,
  resolvePriceItemId,
  DEFAULT_TEMPLATE_ID,
  DEFAULT_US_DATA_CENTER_ID,
  DEFAULT_TIER_PRICE_ITEM
} from "@/lib/hostinger/provision";
import type { HostingerClient } from "@/lib/hostinger/client";

function makeClientStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    createPublicKey: vi.fn().mockResolvedValue({ id: 9, name: "k", key: "ssh-ed25519 AAA k" }),
    createPostInstallScript: vi.fn().mockResolvedValue({ id: 11, name: "s", content: "" }),
    purchaseVirtualMachine: vi.fn().mockResolvedValue({
      order_id: "o1",
      virtual_machines: [{ id: 42, state: "initial" }]
    }),
    getVirtualMachine: vi.fn(),
    installMonarx: vi.fn().mockResolvedValue({ id: 1, name: "a", state: "initiated" }),
    ...overrides
  };
}

const fakeKeypair = {
  publicKey: "ssh-ed25519 AAAA test-comment\n",
  privateKeyPem: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
  fingerprintSha256: "SHA256:abcdef"
};

describe("provisionVpsForBusiness", () => {
  it("runs the full happy path: keypair → upload → post-install → purchase → poll → monarx → persist", async () => {
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
        postInstallScript: "#!/bin/bash\necho hi",
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
      postInstallScriptId: 11,
      publicKeyId: 9,
      hostingerBillingSubscriptionId: null
    });
    expect(phases).toEqual([
      "keypair_generated",
      "public_key_uploaded",
      "post_install_registered",
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
    expect(purchaseArg.setup.post_install_script_id).toBe(11);
    expect(purchaseArg.setup.install_monarx).toBe(false);
    expect(purchaseArg.setup.hostname).toMatch(/^nc-/);
  });

  it("reuses postInstallScriptId when provided (no upload)", async () => {
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
        postInstallScript: "",
        postInstallScriptId: 77,
        pollIntervalMs: 1
      },
      {
        client: client as unknown as HostingerClient,
        generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
        sleep: vi.fn(),
        db: { insertVpsSshKey: dbInsert }
      }
    );

    expect(client.createPostInstallScript).not.toHaveBeenCalled();
    expect(client.purchaseVirtualMachine.mock.calls[0][0].setup.post_install_script_id).toBe(77);
    expect(client.purchaseVirtualMachine.mock.calls[0][0].item_id).toBe(
      DEFAULT_TIER_PRICE_ITEM.standard
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
        postInstallScript: "#!/bin/bash",
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
          postInstallScript: "",
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
          postInstallScript: "",
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
            postInstallScript: "",
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
          postInstallScript: "",
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
          postInstallScript: "",
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
        postInstallScript: "",
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
        postInstallScript: "",
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
        postInstallScript: "#!/bin/bash"
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

  it("defaults hostname to 'nc-unknown' when businessId has no valid chars", async () => {
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
        postInstallScript: "",
        pollIntervalMs: 1
      },
      {
        client: client as unknown as HostingerClient,
        generateKeypair: vi.fn().mockResolvedValue(fakeKeypair),
        sleep: vi.fn(),
        db: { insertVpsSshKey: dbInsert }
      }
    );
    expect(client.purchaseVirtualMachine.mock.calls[0][0].setup.hostname).toBe("nc-unknown");
  });
});

describe("buildDefaultPostInstallScript", () => {
  it("stays under Hostinger's 48KB limit", () => {
    const s = buildDefaultPostInstallScript();
    expect(s.length).toBeLessThan(48 * 1024);
  });

  it("uses default repo URL + ref when no options are passed", () => {
    const s = buildDefaultPostInstallScript();
    expect(s).toContain("https://github.com/brianlane/newCoworker.git");
    expect(s).toContain("REPO_REF='main'");
  });

  it("accepts custom repo URL and ref", () => {
    const s = buildDefaultPostInstallScript({
      repoUrl: "https://github.com/other/repo.git",
      repoRef: "release"
    });
    expect(s).toContain("REPO_URL='https://github.com/other/repo.git'");
    expect(s).toContain("REPO_REF='release'");
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

  it("includes the critical elements: SSH hardening, UFW, repo staging, deploy script install", () => {
    const s = buildDefaultPostInstallScript();
    expect(s).toContain("PasswordAuthentication no");
    expect(s).toContain("ufw --force enable");
    expect(s).toContain("/opt/newcoworker-repo");
    expect(s).toContain("/opt/deploy-client.sh");
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
