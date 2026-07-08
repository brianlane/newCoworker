import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { DEFAULT_OVH_BASE_URL, OvhApiError, OvhClient } from "@/lib/ovh/client";

const BASE = "https://ovh.test/1.0";

type Captured = { url: string; init: RequestInit };

/**
 * fetch stub: first /auth/time call returns a fixed server clock; every
 * other call is answered from the `routes` map (method+path → response).
 */
function makeFetch(opts: {
  serverTime?: number;
  routes?: Record<string, { status?: number; body?: unknown; text?: string }>;
  captured?: Captured[];
}) {
  const serverTime = opts.serverTime ?? 1_800_000_000;
  return vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.endsWith("/auth/time")) {
      return new Response(String(serverTime), { status: 200 });
    }
    opts.captured?.push({ url: u, init: init ?? {} });
    const path = u.replace(BASE, "");
    const key = `${init?.method ?? "GET"} ${path}`;
    const route = opts.routes?.[key];
    if (!route) {
      return new Response(JSON.stringify({ message: `no route for ${key}` }), { status: 404 });
    }
    const status = route.status ?? 200;
    // Response() throws on a non-null body for 204/205/304.
    if (status === 204) return new Response(null, { status });
    const text = route.text ?? JSON.stringify(route.body ?? null);
    return new Response(text, { status });
  }) as unknown as typeof fetch;
}

function makeClient(fetchImpl: typeof fetch, nowMs = 1_800_000_123_000) {
  return new OvhClient({
    baseUrl: BASE,
    applicationKey: "APPKEY",
    applicationSecret: "APPSECRET",
    consumerKey: "CONSUMER",
    fetchImpl,
    now: () => nowMs
  });
}

describe("OvhClient request signing", () => {
  it("signs requests with the documented $1$sha1 scheme using the server clock delta", async () => {
    const captured: Captured[] = [];
    // Local clock: 1_800_000_123 s; server clock: 1_800_000_000 s → delta -123.
    const fetchImpl = makeFetch({
      serverTime: 1_800_000_000,
      captured,
      routes: { "GET /vps": { body: ["vps-abc.vps.ovh.ca"] } }
    });
    const client = makeClient(fetchImpl);

    await client.listVps();

    const call = captured[0];
    const headers = call.init.headers as Record<string, string>;
    expect(headers["X-Ovh-Application"]).toBe("APPKEY");
    expect(headers["X-Ovh-Consumer"]).toBe("CONSUMER");
    // localSec (1_800_000_123) + delta (-123) = server clock.
    expect(headers["X-Ovh-Timestamp"]).toBe("1800000000");
    const expected =
      "$1$" +
      createHash("sha1")
        .update(["APPSECRET", "CONSUMER", "GET", `${BASE}/vps`, "", "1800000000"].join("+"))
        .digest("hex");
    expect(headers["X-Ovh-Signature"]).toBe(expected);
    // GET carries no body and no content-type.
    expect(call.init.body).toBeUndefined();
  });

  it("includes the JSON body in the signature for writes and caches the clock delta", async () => {
    const captured: Captured[] = [];
    const fetchImpl = makeFetch({
      serverTime: 1_800_000_000,
      captured,
      routes: {
        "POST /order/cart": { body: { cartId: "cart-1" } },
        "GET /vps": { body: [] }
      }
    });
    const client = makeClient(fetchImpl);

    await client.createCart("CA");
    await client.listVps();

    const post = captured[0];
    const body = JSON.stringify({ ovhSubsidiary: "CA" });
    const headers = post.init.headers as Record<string, string>;
    const expected =
      "$1$" +
      createHash("sha1")
        .update(["APPSECRET", "CONSUMER", "POST", `${BASE}/order/cart`, body, "1800000000"].join("+"))
        .digest("hex");
    expect(headers["X-Ovh-Signature"]).toBe(expected);
    expect(post.init.body).toBe(body);
    expect(headers["Content-Type"]).toBe("application/json");

    // /auth/time fetched exactly once across both requests (delta cached).
    const timeCalls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => String(c[0]).endsWith("/auth/time")
    );
    expect(timeCalls).toHaveLength(1);
  });

  it("maps /auth/time aborts and network errors to OvhApiError (bounded clock fetch)", async () => {
    const hangingClock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/auth/time")) {
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          });
        });
      }
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    const timingOut = new OvhClient({
      baseUrl: BASE,
      applicationKey: "APPKEY",
      applicationSecret: "APPSECRET",
      consumerKey: "CONSUMER",
      fetchImpl: hangingClock,
      now: () => 1_800_000_123_000,
      timeoutMs: 10
    });
    await expect(timingOut.listVps()).rejects.toThrow(/auth\/time timed out after 10ms/);

    const flakyClock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/auth/time")) throw new Error("dns failure");
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(makeClient(flakyClock).listVps()).rejects.toThrow(
      /auth\/time network error: dns failure/
    );
  });

  it("throws OvhApiError when /auth/time fails or returns garbage", async () => {
    const failing = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/auth/time")) return new Response("", { status: 500 });
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(makeClient(failing).listVps()).rejects.toThrow(/auth\/time → HTTP 500/);

    const garbage = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/auth/time")) return new Response("not-a-clock", { status: 200 });
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(makeClient(garbage).listVps()).rejects.toThrow(/non-numeric clock/);
  });
});

describe("OvhClient endpoints", () => {
  it("drives the full order-cart purchase flow", async () => {
    const captured: Captured[] = [];
    const fetchImpl = makeFetch({
      captured,
      routes: {
        "POST /order/cart": { body: { cartId: "cart-1" } },
        "POST /order/cart/cart-1/assign": { status: 200, text: "" },
        "POST /order/cart/cart-1/vps": { body: { itemId: 77 } },
        "POST /order/cart/cart-1/item/77/configuration": { body: { id: 1 } },
        "POST /order/cart/cart-1/checkout": { body: { orderId: 9001 } }
      }
    });
    const client = makeClient(fetchImpl);

    const cart = await client.createCart();
    await client.assignCart(cart.cartId);
    const item = await client.addVpsToCart(cart.cartId, {
      planCode: "vps-le-8-32-320",
      duration: "P1M",
      pricingMode: "default"
    });
    await client.configureCartItem(cart.cartId, item.itemId, "vps_datacenter", "bhs");
    const order = await client.checkoutCart(cart.cartId);

    expect(order.orderId).toBe(9001);
    const bodies = captured.map((c) => (typeof c.init.body === "string" ? c.init.body : ""));
    expect(bodies[2]).toContain('"planCode":"vps-le-8-32-320"');
    expect(bodies[2]).toContain('"quantity":1');
    expect(bodies[3]).toContain('"label":"vps_datacenter"');
    expect(bodies[4]).toContain('"autoPayWithPreferredPaymentMethod":true');
    expect(bodies[4]).toContain('"waiveRetractationPeriod":true');
  });

  it("checkout options are overridable", async () => {
    const captured: Captured[] = [];
    const fetchImpl = makeFetch({
      captured,
      routes: { "POST /order/cart/c/checkout": { body: { orderId: 1 } } }
    });
    await makeClient(fetchImpl).checkoutCart("c", {
      autoPayWithPreferredPaymentMethod: false,
      waiveRetractationPeriod: false
    });
    expect(captured[0].init.body).toContain('"autoPayWithPreferredPaymentMethod":false');
  });

  it("reads vps state, ips, images (id → detail), tasks, and the public catalog", async () => {
    const fetchImpl = makeFetch({
      routes: {
        "GET /order/catalog/public/vps?ovhSubsidiary=CA": { body: { plans: [] } },
        "GET /vps/vps-a": { body: { name: "vps-a", state: "running" } },
        "GET /vps/vps-a/ips": { body: ["203.0.113.9", "2607:5300::1"] },
        "GET /vps/vps-a/images/available": { body: ["img-1"] },
        "GET /vps/vps-a/images/available/img-1": { body: { id: "img-1", name: "Ubuntu 24.04" } },
        "GET /vps/vps-a/tasks": { body: [5] },
        "GET /vps/vps-a/tasks/5": { body: { id: 5, state: "done" } }
      }
    });
    const client = makeClient(fetchImpl);

    expect(await client.getPublicVpsCatalog()).toEqual({ plans: [] });
    expect((await client.getVps("vps-a")).state).toBe("running");
    expect(await client.getVpsIps("vps-a")).toContain("203.0.113.9");
    expect(await client.getAvailableImages("vps-a")).toEqual([
      { id: "img-1", name: "Ubuntu 24.04" }
    ]);
    expect(await client.getVpsTasks("vps-a")).toEqual([5]);
    expect((await client.getVpsTask("vps-a", 5)).state).toBe("done");
  });

  it("rebuilds with the SSH key embedded and defaults doNotSendPassword", async () => {
    const captured: Captured[] = [];
    const fetchImpl = makeFetch({
      captured,
      routes: { "POST /vps/vps-a/rebuild": { body: { id: 42 } } }
    });
    const task = await makeClient(fetchImpl).rebuildVps("vps-a", {
      imageId: "img-1",
      publicSshKey: "ssh-ed25519 AAAA key"
    });
    expect(task.id).toBe(42);
    expect(captured[0].init.body).toContain('"publicSshKey":"ssh-ed25519 AAAA key"');
    expect(captured[0].init.body).toContain('"doNotSendPassword":true');
  });

  it("lifecycle: serviceInfos, delete-at-expiration flip, terminate + confirm", async () => {
    const captured: Captured[] = [];
    const fetchImpl = makeFetch({
      captured,
      routes: {
        "GET /vps/vps-a/serviceInfos": {
          body: { serviceId: 11, renew: { automatic: true, deleteAtExpiration: false } }
        },
        "PUT /vps/vps-a/serviceInfos": { status: 200, text: "" },
        "POST /vps/vps-a/terminate": { status: 200, text: "" },
        "POST /vps/vps-a/confirmTermination": { status: 200, text: "" }
      }
    });
    const client = makeClient(fetchImpl);

    expect((await client.getServiceInfos("vps-a")).serviceId).toBe(11);
    await client.setDeleteAtExpiration("vps-a", true);
    const put = captured.find((c) => c.init.method === "PUT");
    expect(put?.init.body).toContain('"deleteAtExpiration":true');
    expect(put?.init.body).toContain('"automatic":false');

    await client.terminateVps("vps-a");
    await client.confirmTermination("vps-a", "tok-123");
    const confirm = captured[captured.length - 1];
    expect(confirm.init.body).toContain('"token":"tok-123"');
    expect(confirm.init.body).toContain('"reason":"OTHER"');
  });

  it("re-enabling renewal restores auto-renew even after an earlier lapse flip", async () => {
    const captured: Captured[] = [];
    const fetchImpl = makeFetch({
      captured,
      routes: {
        "GET /vps/vps-a/serviceInfos": {
          // Stored state after a cancel flip: auto-renew OFF. Re-enabling
          // must NOT inherit it — the intent is "keep the box alive".
          body: { serviceId: 11, renew: { automatic: false, deleteAtExpiration: true } }
        },
        "PUT /vps/vps-a/serviceInfos": { status: 200, text: "" }
      }
    });
    await makeClient(fetchImpl).setDeleteAtExpiration("vps-a", false);
    const put = captured.find((c) => c.init.method === "PUT");
    expect(put?.init.body).toContain('"automatic":true');
    expect(put?.init.body).toContain('"deleteAtExpiration":false');
  });

  it("tolerates a serviceInfos response with no renew block at all", async () => {
    const captured: Captured[] = [];
    const fetchImpl = makeFetch({
      captured,
      routes: {
        "GET /vps/vps-a/serviceInfos": { body: { serviceId: 11 } },
        "PUT /vps/vps-a/serviceInfos": { status: 200, text: "" }
      }
    });
    await makeClient(fetchImpl).setDeleteAtExpiration("vps-a", true);
    const put = captured.find((c) => c.init.method === "PUT");
    expect(put?.init.body).toContain('"automatic":false');
    expect(put?.init.body).toContain('"deleteAtExpiration":true');
  });
});

describe("OvhClient error handling", () => {
  it("wraps API errors with endpoint + status + message", async () => {
    const fetchImpl = makeFetch({
      routes: {
        "GET /vps/vps-x": { status: 403, body: { message: "This call has not been granted" } }
      }
    });
    const err = await makeClient(fetchImpl)
      .getVps("vps-x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OvhApiError);
    expect((err as OvhApiError).status).toBe(403);
    expect((err as OvhApiError).message).toContain("This call has not been granted");
  });

  it("tolerates non-JSON error bodies and message-less errors", async () => {
    const fetchImpl = makeFetch({
      routes: { "GET /vps/vps-x": { status: 502, text: "<html>bad gateway</html>" } }
    });
    const err = (await makeClient(fetchImpl)
      .getVps("vps-x")
      .catch((e: unknown) => e)) as OvhApiError;
    expect(err.status).toBe(502);
    expect(err.body).toEqual({ raw: "<html>bad gateway</html>" });
    expect(err.message).toContain("HTTP 502");
  });

  it("returns undefined for 204 responses", async () => {
    const fetchImpl = makeFetch({
      routes: { "POST /vps/vps-a/terminate": { status: 204, text: "" } }
    });
    await expect(makeClient(fetchImpl).terminateVps("vps-a")).resolves.toBeUndefined();
  });

  it("aborts and throws a timeout OvhApiError when the fetch takes too long", async () => {
    // Real (tiny) timeout so the setTimeout → ac.abort() arrow actually
    // fires; the mock only resolves on the abort signal.
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/auth/time")) return new Response("100", { status: 200 });
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        });
      });
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    const client = new OvhClient({
      baseUrl: BASE,
      applicationKey: "APPKEY",
      applicationSecret: "APPSECRET",
      consumerKey: "CONSUMER",
      fetchImpl,
      now: () => 1_800_000_123_000,
      timeoutMs: 10
    });
    const err = (await client.listVps().catch((e: unknown) => e)) as OvhApiError;
    expect(err).toBeInstanceOf(OvhApiError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/timed out after 10ms/);
  });

  it("maps timeouts and network errors to OvhApiError", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const timingOut = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/auth/time")) return new Response("100", { status: 200 });
      throw abortErr;
    }) as unknown as typeof fetch;
    await expect(makeClient(timingOut).listVps()).rejects.toThrow(/timed out after/);

    const flaky = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/auth/time")) return new Response("100", { status: 200 });
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    await expect(makeClient(flaky).listVps()).rejects.toThrow(/network error: socket hang up/);
  });

  it("errors without a message body still carry endpoint + status", async () => {
    const fetchImpl = makeFetch({
      routes: { "GET /vps/vps-x": { status: 500, text: "" } }
    });
    const err = (await makeClient(fetchImpl)
      .getVps("vps-x")
      .catch((e: unknown) => e)) as OvhApiError;
    expect(err).toBeInstanceOf(OvhApiError);
    expect(err.body).toBeNull();
    expect(err.message).toBe("OVH API /vps/vps-x HTTP 500");
  });

  it("defaults the base URL to the ovh-ca endpoint and the clock to Date.now", async () => {
    const fetchImpl = makeFetch({ routes: {} });
    const client = new OvhClient({
      applicationKey: "a",
      applicationSecret: "b",
      consumerKey: "c",
      fetchImpl
      // `now` deliberately omitted — the default Date.now clock is used for
      // the signature below.
    });
    expect(DEFAULT_OVH_BASE_URL).toContain("ca.api.ovh.com");
    // Private field access via cast — asserting the trailing-slash strip +
    // default in one place without exporting internals.
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe(DEFAULT_OVH_BASE_URL);
    // The mock has no routes for the default base URL, so the call 404s —
    // which is enough to drive the default clock through the signer.
    const err = (await client.listVps().catch((e: unknown) => e)) as OvhApiError;
    expect(err).toBeInstanceOf(OvhApiError);
    expect(err.status).toBe(404);
  });
});
