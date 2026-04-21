import { describe, expect, it, vi } from "vitest";
import { HostingerClient, HostingerApiError } from "@/lib/hostinger/client";

type FetchImpl = typeof fetch;

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function errResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

type MockCalls = Array<[string, RequestInit | undefined]>;
function calls(mock: ReturnType<typeof vi.fn>): MockCalls {
  return mock.mock.calls as unknown as MockCalls;
}
function makeClient(fetchMock: ReturnType<typeof vi.fn>, timeoutMs?: number): HostingerClient {
  return new HostingerClient({
    baseUrl: "https://dev.hostinger",
    token: "test-token",
    fetchImpl: fetchMock as unknown as FetchImpl,
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {})
  });
}

describe("HostingerClient (real API)", () => {
  it("sets the Authorization bearer header on every request", async () => {
    const fetchMock = vi.fn(async () => ok([]));
    const client = makeClient(fetchMock);
    await client.listCatalog("VPS");
    const call = calls(fetchMock)[0];
    expect(call[0]).toBe("https://dev.hostinger/api/billing/v1/catalog?category=VPS");
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers.Accept).toBe("application/json");
  });

  it("returns the array body for list endpoints", async () => {
    const fetchMock = vi.fn(async () => ok([{ id: "p1", name: "KVM 2", category: "VPS", prices: [] }]));
    const client = makeClient(fetchMock);
    const items = await client.listCatalog();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("p1");
  });

  it("unwraps `{ data: ... }` single-resource envelopes", async () => {
    const fetchMock = vi.fn(async () =>
      ok({ data: { id: 42, name: "my-key", key: "ssh-ed25519 AAAA test" } })
    );
    const client = makeClient(fetchMock);
    const res = await client.createPublicKey("my-key", "ssh-ed25519 AAAA test");
    expect(res).toEqual({ id: 42, name: "my-key", key: "ssh-ed25519 AAAA test" });
  });

  it("unwraps paginated `{ data: [...], meta: {...} }` list responses", async () => {
    const fetchMock = vi.fn(async () =>
      ok({
        data: [{ id: 1, name: "k1", key: "ssh-ed25519 AAA" }],
        meta: { current_page: 1, last_page: 1, total: 1 }
      })
    );
    const client = makeClient(fetchMock);
    const list = await client.listPublicKeys();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(1);
  });

  it("throws HostingerApiError with message from body.message on 4xx", async () => {
    const fetchMock = vi.fn(async () => errResponse({ message: "Invalid item_id" }, 422));
    const client = makeClient(fetchMock);
    await expect(
      client.purchaseVirtualMachine({
        item_id: "bad",
        setup: { data_center_id: 17, template_id: 1121 }
      })
    ).rejects.toThrow(/Invalid item_id/);
  });

  it("HostingerApiError carries status, endpoint, and body", async () => {
    const fetchMock = vi.fn(async () =>
      errResponse({ errors: { setup: ["required"] } }, 422)
    );
    const client = makeClient(fetchMock);
    try {
      await client.getVirtualMachine(99);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(HostingerApiError);
      const err = e as HostingerApiError;
      expect(err.status).toBe(422);
      expect(err.endpoint).toBe("/api/vps/v1/virtual-machines/99");
      expect(err.body).toEqual({ errors: { setup: ["required"] } });
    }
  });

  it("handles 5xx with non-JSON body by wrapping raw text", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" }
        })
    );
    const client = makeClient(fetchMock);
    try {
      await client.listDataCenters();
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as HostingerApiError;
      expect(err.status).toBe(502);
      expect(err.body).toEqual({ raw: "<html>502 Bad Gateway</html>" });
    }
  });

  it("handles 204 No Content for DELETE without parsing the body", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const client = makeClient(fetchMock);
    await expect(client.deletePublicKey(7)).resolves.toBeUndefined();
    expect(calls(fetchMock)[0][0]).toBe("https://dev.hostinger/api/vps/v1/public-keys/7");
    expect((calls(fetchMock)[0][1] as RequestInit).method).toBe("DELETE");
  });

  it("wraps a network error in HostingerApiError with status=0", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const client = makeClient(fetchMock);
    try {
      await client.listDataCenters();
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as HostingerApiError;
      expect(err.status).toBe(0);
      expect(err.message).toMatch(/network error/);
    }
  });

  it("aborts and throws a timeout HostingerApiError when the fetch takes too long", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      await new Promise<void>((_resolve, reject) => {
        const sig = init?.signal;
        sig?.addEventListener("abort", () => {
          const abortErr = Object.assign(new Error("The operation was aborted"), {
            name: "AbortError"
          });
          reject(abortErr);
        });
      });
      return ok({});
    });
    const client = makeClient(fetchMock, 10);
    try {
      await client.listDataCenters();
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as HostingerApiError;
      expect(err.status).toBe(0);
      expect(err.message).toMatch(/timed out/);
    }
  });

  it("serialises the request body as JSON and sets Content-Type", async () => {
    const fetchMock = vi.fn(async () =>
      ok({ id: 7, name: "test", content: "#!/bin/bash" })
    );
    const client = makeClient(fetchMock);
    await client.createPostInstallScript("test", "#!/bin/bash\necho hi");
    const init = calls(fetchMock)[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ name: "test", content: "#!/bin/bash\necho hi" }));
  });

  it("rejects post-install scripts over the 48KB byte limit", async () => {
    const fetchMock = vi.fn(async () => ok({}));
    const client = makeClient(fetchMock);
    const oversize = "a".repeat(48 * 1024 + 1);
    await expect(client.createPostInstallScript("too-big", oversize)).rejects.toThrow(/48KB limit/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects updates to post-install scripts over the 48KB byte limit", async () => {
    const fetchMock = vi.fn(async () => ok({}));
    const client = makeClient(fetchMock);
    const oversize = "a".repeat(48 * 1024 + 1);
    await expect(client.updatePostInstallScript(1, "too-big", oversize)).rejects.toThrow(/48KB limit/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("purchaseVirtualMachine posts the full payload to /api/vps/v1/virtual-machines", async () => {
    const fetchMock = vi.fn(async () =>
      ok({ order_id: "o1", virtual_machines: [{ id: 123, state: "initial" }] })
    );
    const client = makeClient(fetchMock);
    await client.purchaseVirtualMachine({
      item_id: "hostingercom-vps-kvm2-usd-1m",
      payment_method_id: 42333536,
      setup: {
        data_center_id: 17,
        template_id: 1121,
        public_key_ids: [9],
        post_install_script_id: 11
      }
    });
    const url = calls(fetchMock)[0][0];
    const init = calls(fetchMock)[0][1] as RequestInit;
    expect(url).toBe("https://dev.hostinger/api/vps/v1/virtual-machines");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.item_id).toBe("hostingercom-vps-kvm2-usd-1m");
    expect(body.payment_method_id).toBe(42333536);
    expect(body.setup.public_key_ids).toEqual([9]);
  });

  it("pagination helpers hit the right endpoints", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok([{ id: 101, name: "n", content: "" }]))
      .mockResolvedValueOnce(ok({ data: [{ id: 9, name: "k1", key: "ssh-ed25519 AAA" }] }));
    const client = makeClient(fetchMock);
    await client.listPostInstallScripts(2);
    await client.listPublicKeys(3);
    expect(calls(fetchMock)[0][0]).toBe(
      "https://dev.hostinger/api/vps/v1/post-install-scripts?page=2"
    );
    expect(calls(fetchMock)[1][0]).toBe("https://dev.hostinger/api/vps/v1/public-keys?page=3");
  });

  it("monarx + docker convenience wrappers hit the right paths", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ id: 1, name: "install_monarx", state: "initiated" }))
      .mockResolvedValueOnce(ok({ id: 2, name: "docker_compose_up", state: "initiated" }))
      .mockResolvedValueOnce(ok({ id: 3, name: "docker_compose_restart", state: "initiated" }))
      .mockResolvedValueOnce(ok({ id: 4, name: "docker_compose_down", state: "initiated" }));
    const client = makeClient(fetchMock);
    await client.installMonarx(10);
    await client.createDockerProject(10, { content: "version: '3'" });
    await client.restartDockerProject(10, "my/project");
    await client.deleteDockerProject(10, "my/project");
    expect(calls(fetchMock)[0][0]).toBe(
      "https://dev.hostinger/api/vps/v1/virtual-machines/10/monarx"
    );
    expect(calls(fetchMock)[1][0]).toBe(
      "https://dev.hostinger/api/vps/v1/virtual-machines/10/docker"
    );
    expect(calls(fetchMock)[2][0]).toBe(
      "https://dev.hostinger/api/vps/v1/virtual-machines/10/docker/my%2Fproject/restart"
    );
    expect(calls(fetchMock)[3][0]).toBe(
      "https://dev.hostinger/api/vps/v1/virtual-machines/10/docker/my%2Fproject/down"
    );
  });

  it("returns [] for non-array catalog responses (defensive)", async () => {
    const fetchMock = vi.fn(async () => ok({ not: "an array" }));
    const client = makeClient(fetchMock);
    await expect(client.listCatalog()).resolves.toEqual([]);
  });

  it("returns [] for payment-methods + data-centers + templates + VM list defensive branches", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({}))
      .mockResolvedValueOnce(ok({}))
      .mockResolvedValueOnce(ok({}))
      .mockResolvedValueOnce(ok({}))
      .mockResolvedValueOnce(ok({}));
    const client = makeClient(fetchMock);
    await expect(client.listPaymentMethods()).resolves.toEqual([]);
    await expect(client.listDataCenters()).resolves.toEqual([]);
    await expect(client.listTemplates()).resolves.toEqual([]);
    await expect(client.listVirtualMachines()).resolves.toEqual([]);
    await expect(client.listDockerProjects(5)).resolves.toEqual([]);
  });

  it("normalizeList returns [] for objects that are neither array nor paginated envelope", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ unexpected: true }))
      .mockResolvedValueOnce(ok({ unexpected: true }));
    const client = makeClient(fetchMock);
    await expect(client.listPublicKeys()).resolves.toEqual([]);
    await expect(client.listPostInstallScripts()).resolves.toEqual([]);
  });

  it("error message falls back when body has no message but has errors object", async () => {
    const fetchMock = vi.fn(async () =>
      errResponse({ errors: { field: ["bad"] } }, 400)
    );
    const client = makeClient(fetchMock);
    await expect(client.listCatalog()).rejects.toThrow(/"field":\["bad"\]/);
  });

  it("error message falls back to `HTTP <status>` when body is empty", async () => {
    const fetchMock = vi.fn(
      async () => new Response("", { status: 500 })
    );
    const client = makeClient(fetchMock);
    await expect(client.listCatalog()).rejects.toThrow(/HTTP 500/);
  });

  it("attachPublicKey posts to the correct VM scoped path", async () => {
    const fetchMock = vi.fn(async () =>
      ok({ id: 1, name: "attach_public_key", state: "initiated" })
    );
    const client = makeClient(fetchMock);
    await client.attachPublicKey(55, [1, 2]);
    expect(calls(fetchMock)[0][0]).toBe(
      "https://dev.hostinger/api/vps/v1/public-keys/attach/55"
    );
    expect(JSON.parse((calls(fetchMock)[0][1] as RequestInit).body as string)).toEqual({
      ids: [1, 2]
    });
  });

  it("setup/recreate/restart/stop/start/listActions/getAction/getMonarxMetrics/uninstallMonarx/updatePostInstallScript/deletePostInstallScript wrappers", async () => {
    const fetchMock = vi.fn(async () => ok({ id: 1, name: "action", state: "initiated" }));
    const client = makeClient(fetchMock);
    await client.setupVirtualMachine(1, { data_center_id: 17, template_id: 1121 });
    await client.recreateVirtualMachine(1, { data_center_id: 17, template_id: 1121 });
    await client.restartVirtualMachine(1);
    await client.stopVirtualMachine(1);
    await client.startVirtualMachine(1);
    await client.listActions(1, 2);
    await client.getAction(1, 55);
    await client.uninstallMonarx(1);
    await client.getMonarxMetrics(1);
    await client.updatePostInstallScript(5, "n", "echo hi");
    await client.deletePostInstallScript(5);

    const urls = calls(fetchMock).map((c) => c[0]);
    expect(urls).toEqual([
      "https://dev.hostinger/api/vps/v1/virtual-machines/1/setup",
      "https://dev.hostinger/api/vps/v1/virtual-machines/1/recreate",
      "https://dev.hostinger/api/vps/v1/virtual-machines/1/restart",
      "https://dev.hostinger/api/vps/v1/virtual-machines/1/stop",
      "https://dev.hostinger/api/vps/v1/virtual-machines/1/start",
      "https://dev.hostinger/api/vps/v1/virtual-machines/1/actions?page=2",
      "https://dev.hostinger/api/vps/v1/virtual-machines/1/actions/55",
      "https://dev.hostinger/api/vps/v1/virtual-machines/1/monarx",
      "https://dev.hostinger/api/vps/v1/virtual-machines/1/monarx",
      "https://dev.hostinger/api/vps/v1/post-install-scripts/5",
      "https://dev.hostinger/api/vps/v1/post-install-scripts/5"
    ]);
  });

  it("strips trailing slash from baseUrl", () => {
    const client = new HostingerClient({ baseUrl: "https://x/", token: "t" });
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe("https://x");
  });

  it("uses default baseUrl when not provided", () => {
    const client = new HostingerClient({ token: "t" });
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe(
      "https://developers.hostinger.com"
    );
  });
});
