import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/vps-gateway-tokens", () => ({
  getActiveGatewayTokenForBusiness: vi.fn()
}));

import {
  DataApiClient,
  DataApiTransportError,
  residencyDataBaseUrl
} from "@/lib/residency/client";
import { getActiveGatewayTokenForBusiness } from "@/lib/db/vps-gateway-tokens";

const BIZ = "11111111-1111-4111-8111-111111111111";

function okFetch(payload: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" }
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("residencyDataBaseUrl", () => {
  it("prefers the hostname suffix, then the zone, then the default", () => {
    expect(
      residencyDataBaseUrl(BIZ, { CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX: "tunnel.x.com" })
    ).toBe(`https://data-${BIZ}.tunnel.x.com`);
    expect(residencyDataBaseUrl(BIZ, { CLOUDFLARE_TUNNEL_ZONE: "zone.io" })).toBe(
      `https://data-${BIZ}.zone.io`
    );
    expect(residencyDataBaseUrl(BIZ, {})).toBe(`https://data-${BIZ}.newcoworker.com`);
  });

  it("coerces blank env values like the tunnel provisioner does", () => {
    expect(
      residencyDataBaseUrl(BIZ, {
        CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX: "  ",
        CLOUDFLARE_TUNNEL_ZONE: ""
      })
    ).toBe(`https://data-${BIZ}.newcoworker.com`);
  });
});

describe("DataApiClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POSTs the contract shape with the explicit bearer", async () => {
    const { fetchImpl, calls } = okFetch({ ok: true, rows: [{ id: "r1" }] });
    const client = new DataApiClient(BIZ, {
      baseUrl: "http://127.0.0.1:8091",
      token: "tok-explicit",
      fetchImpl
    });
    const res = await client.select({ table: "contacts", limit: 1 });
    expect(res).toEqual({ ok: true, rows: [{ id: "r1" }] });
    expect(calls[0].url).toBe("http://127.0.0.1:8091/v1/select");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok-explicit"
    );
    expect(getActiveGatewayTokenForBusiness).not.toHaveBeenCalled();
  });

  it("resolves + caches the gateway token when none is supplied", async () => {
    vi.mocked(getActiveGatewayTokenForBusiness).mockResolvedValue("tok-db");
    const { fetchImpl, calls } = okFetch({ ok: true, rows: [] });
    const client = new DataApiClient(BIZ, { baseUrl: "http://x", fetchImpl });
    await client.insert({ table: "contacts", rows: [{ a: 1 }] });
    await client.update({ table: "contacts", set: { a: 2 }, filters: [{ column: "id", op: "eq", value: "1" }] });
    await client.delete({ table: "contacts", filters: [{ column: "id", op: "eq", value: "1" }] });
    expect(getActiveGatewayTokenForBusiness).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.url)).toEqual([
      "http://x/v1/insert",
      "http://x/v1/update",
      "http://x/v1/delete"
    ]);
  });

  it("throws a transport error when no gateway token exists", async () => {
    vi.mocked(getActiveGatewayTokenForBusiness).mockResolvedValue(null);
    const { fetchImpl } = okFetch({ ok: true, rows: [] });
    const client = new DataApiClient(BIZ, { baseUrl: "http://x", fetchImpl });
    await expect(client.select({ table: "contacts" })).rejects.toBeInstanceOf(
      DataApiTransportError
    );
  });

  it("throws a transport error on non-2xx (tunnel-mangled bodies)", async () => {
    const { fetchImpl } = okFetch({ nonsense: true }, 502);
    const client = new DataApiClient(BIZ, { baseUrl: "http://x", token: "t", fetchImpl });
    await expect(client.select({ table: "contacts" })).rejects.toThrow(/HTTP 502/);
  });

  it("wraps fetch rejections (down box) in DataApiTransportError", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new DataApiClient(BIZ, { baseUrl: "http://x", token: "t", fetchImpl });
    await expect(client.select({ table: "contacts" })).rejects.toThrow(/unreachable/);
  });

  it("passes through structured server-side failures without throwing", async () => {
    const { fetchImpl } = okFetch({ ok: false, error: "conflict", message: "dupe" });
    const client = new DataApiClient(BIZ, { baseUrl: "http://x", token: "t", fetchImpl });
    const res = await client.insert({ table: "contacts", rows: [{ a: 1 }] });
    expect(res).toEqual({ ok: false, error: "conflict", message: "dupe" });
  });

  it("defaults the base URL to the tenant tunnel hostname (post + health)", async () => {
    const { fetchImpl, calls } = okFetch({ ok: true, rows: [] });
    const client = new DataApiClient(BIZ, { token: "t", fetchImpl, timeoutMs: 5000 });
    await client.select({ table: "contacts" });
    await client.health();
    expect(calls[0].url).toContain(`https://data-${BIZ}.`);
    expect(calls[0].url).toContain("/v1/select");
    expect(calls[1].url).toContain("/v1/health");
  });

  it("stringifies non-Error fetch rejections (post + health)", async () => {
    const weirdFetch = (async () => {
      throw "socket exploded";
    }) as unknown as typeof fetch;
    const client = new DataApiClient(BIZ, { baseUrl: "http://x", token: "t", fetchImpl: weirdFetch });
    await expect(client.select({ table: "contacts" })).rejects.toThrow(/socket exploded/);
    await expect(client.health()).rejects.toThrow(/socket exploded/);
  });

  it("aborts a hung box at the timeout (post + health)", async () => {
    const hangingFetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const client = new DataApiClient(BIZ, {
      baseUrl: "http://x",
      token: "t",
      timeoutMs: 5,
      fetchImpl: hangingFetch
    });
    await expect(client.select({ table: "contacts" })).rejects.toThrow(/unreachable/);
    await expect(client.health()).rejects.toThrow(/unreachable/);
  });

  it("health: returns the body on 200 and wraps failures", async () => {
    const { fetchImpl, calls } = okFetch({ ok: true, schemaVersion: "v1" });
    const client = new DataApiClient(BIZ, { baseUrl: "http://x", token: "t", fetchImpl });
    expect(await client.health()).toEqual({ ok: true, schemaVersion: "v1" });
    expect(calls[0].url).toBe("http://x/v1/health");

    const bad = new DataApiClient(BIZ, {
      baseUrl: "http://x",
      token: "t",
      fetchImpl: okFetch({}, 530).fetchImpl
    });
    await expect(bad.health()).rejects.toThrow(/HTTP 530/);

    const down = new DataApiClient(BIZ, {
      baseUrl: "http://x",
      token: "t",
      fetchImpl: (async () => {
        throw new Error("boom");
      }) as unknown as typeof fetch
    });
    await expect(down.health()).rejects.toThrow(/unreachable/);
  });
});
