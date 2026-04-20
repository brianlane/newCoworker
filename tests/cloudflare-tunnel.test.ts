import { describe, it, expect } from "vitest";
import {
  createCloudflareTunnelProvisioner,
  cloudflareTunnelProvisionerFromEnv
} from "@/lib/cloudflare/tunnel";

/**
 * Builds a `fetch` stub that replays a scripted queue of `[predicate, response]`
 * tuples. Each incoming request is matched against the first predicate whose
 * `method + path` criteria fit; if no predicate matches the test fails loudly.
 *
 * This keeps individual test bodies small while still asserting the exact CF
 * API calls the provisioner makes, in order.
 */
type Handler = {
  match: (url: string, init?: RequestInit) => boolean;
  body: unknown;
  status?: number;
};

function makeFetch(handlers: Handler[]): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; method: string; body: unknown }>;
} {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const queue = [...handlers];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const rawBody = init?.body;
    const parsedBody = typeof rawBody === "string" && rawBody.length > 0
      ? JSON.parse(rawBody)
      : undefined;
    calls.push({ url: urlStr, method, body: parsedBody });
    const idx = queue.findIndex((h) => h.match(urlStr, init));
    if (idx < 0) throw new Error(`unmatched fetch: ${method} ${urlStr}`);
    const [handler] = queue.splice(idx, 1);
    return new Response(JSON.stringify(handler.body), {
      status: handler.status ?? 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function ok<T>(result: T) {
  return { success: true, result };
}
function fail(code: number, message: string) {
  return { success: false, errors: [{ code, message }], result: null };
}

const BASE = "https://api.cloudflare.com/client/v4";
const ACCOUNT = "acct-1";
const ZONE = "tunnel.example.com";
const TOKEN = "test-token";

function baseConfig(fetchImpl: typeof fetch) {
  return {
    apiToken: TOKEN,
    accountId: ACCOUNT,
    zoneName: ZONE,
    serviceUrl: "http://localhost:3000",
    fetchImpl
  } as const;
}

describe("cloudflareTunnelProvisioner", () => {
  it("creates a tunnel + DNS when none exist (cold start)", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u, i) =>
          (i?.method ?? "GET") === "GET" &&
          u.startsWith(`${BASE}/accounts/${ACCOUNT}/cfd_tunnel?name=nc-biz-a`),
        body: ok([])
      },
      {
        match: (u, i) =>
          i?.method === "POST" && u === `${BASE}/accounts/${ACCOUNT}/cfd_tunnel`,
        body: ok({ id: "tun-1", name: "nc-biz-a" })
      },
      {
        match: (u) => u === `${BASE}/accounts/${ACCOUNT}/cfd_tunnel/tun-1/token`,
        body: ok("TUNNEL_INSTALL_TOKEN")
      },
      {
        match: (u, i) =>
          i?.method === "PUT" &&
          u === `${BASE}/accounts/${ACCOUNT}/cfd_tunnel/tun-1/configurations`,
        body: ok({})
      },
      {
        match: (u) => u === `${BASE}/zones?name=${encodeURIComponent(ZONE)}`,
        body: ok([{ id: "zone-1", name: ZONE }])
      },
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones/zone-1/dns_records?type=CNAME&name=`),
        body: ok([])
      },
      {
        match: (u, i) =>
          i?.method === "POST" && u === `${BASE}/zones/zone-1/dns_records`,
        body: ok({ id: "rec-1" })
      }
    ]);

    const provisioner = createCloudflareTunnelProvisioner(baseConfig(fetchImpl));
    const result = await provisioner({ businessId: "biz-a" });
    expect(result).toEqual({
      tunnelId: "tun-1",
      token: "TUNNEL_INSTALL_TOKEN",
      hostname: `biz-a.${ZONE}`
    });

    const dnsCreate = calls.find(
      (c) => c.method === "POST" && c.url === `${BASE}/zones/zone-1/dns_records`
    );
    expect(dnsCreate?.body).toMatchObject({
      type: "CNAME",
      name: `biz-a.${ZONE}`,
      content: "tun-1.cfargotunnel.com",
      proxied: true
    });

    const ingress = calls.find(
      (c) => c.method === "PUT" && c.url.endsWith("/configurations")
    );
    expect(ingress?.body).toMatchObject({
      config: {
        ingress: [
          { hostname: `biz-a.${ZONE}`, service: "http://localhost:3000" },
          { service: "http_status:404" }
        ]
      }
    });
  });

  it("hostnameSuffix decouples public hostname from CF zone (apex zone, deeper hostname)", async () => {
    // Real-world case: zone is "newcoworker.com" (apex on CF) but we want
    // hostnames at "<businessId>.tunnel.newcoworker.com".
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) => u.startsWith(`${BASE}/accounts/${ACCOUNT}/cfd_tunnel?name=nc-biz-h`),
        body: ok([])
      },
      {
        match: (u, i) => i?.method === "POST" && u.endsWith("/cfd_tunnel"),
        body: ok({ id: "tun-h" })
      },
      { match: (u) => u.endsWith("/cfd_tunnel/tun-h/token"), body: ok("T") },
      { match: (u, i) => i?.method === "PUT" && u.endsWith("/configurations"), body: ok({}) },
      {
        match: (u) => u.startsWith(`${BASE}/zones/zone-apex/dns_records?type=CNAME&name=`),
        body: ok([])
      },
      {
        match: (u, i) => i?.method === "POST" && u === `${BASE}/zones/zone-apex/dns_records`,
        body: ok({ id: "rec-h" })
      }
    ]);

    const provisioner = createCloudflareTunnelProvisioner({
      apiToken: TOKEN,
      accountId: ACCOUNT,
      zoneName: "newcoworker.com",
      zoneId: "zone-apex",
      hostnameSuffix: "tunnel.newcoworker.com",
      serviceUrl: "http://localhost:3000",
      fetchImpl
    });
    const result = await provisioner({ businessId: "biz-h" });
    expect(result.hostname).toBe("biz-h.tunnel.newcoworker.com");

    const dnsCreate = calls.find(
      (c) => c.method === "POST" && c.url === `${BASE}/zones/zone-apex/dns_records`
    );
    expect(dnsCreate?.body).toMatchObject({
      type: "CNAME",
      name: "biz-h.tunnel.newcoworker.com",
      content: "tun-h.cfargotunnel.com",
      proxied: true
    });

    const ingress = calls.find(
      (c) => c.method === "PUT" && c.url.endsWith("/configurations")
    );
    expect(ingress?.body).toMatchObject({
      config: {
        ingress: [
          { hostname: "biz-h.tunnel.newcoworker.com", service: "http://localhost:3000" },
          { service: "http_status:404" }
        ]
      }
    });
  });

  it("skips the zone lookup when zoneId is pre-configured", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) => u.startsWith(`${BASE}/accounts/${ACCOUNT}/cfd_tunnel?name=`),
        body: ok([])
      },
      { match: (u, i) => i?.method === "POST" && u.endsWith("/cfd_tunnel"), body: ok({ id: "tun-z" }) },
      { match: (u) => u.endsWith("/token"), body: ok("T") },
      { match: (u, i) => i?.method === "PUT" && u.endsWith("/configurations"), body: ok({}) },
      {
        match: (u) => u.startsWith(`${BASE}/zones/preset-zone/dns_records?type=CNAME&name=`),
        body: ok([])
      },
      {
        match: (u, i) => i?.method === "POST" && u === `${BASE}/zones/preset-zone/dns_records`,
        body: ok({ id: "rec-z" })
      }
    ]);
    const provisioner = createCloudflareTunnelProvisioner({
      ...baseConfig(fetchImpl),
      zoneId: "preset-zone"
    });
    await provisioner({ businessId: "biz-zone" });
    expect(calls.some((c) => c.url.startsWith(`${BASE}/zones?name=`))).toBe(false);
    expect(calls.some((c) => c.url.includes("/zones/preset-zone/dns_records"))).toBe(true);
  });

  it("reuses an existing tunnel by name (idempotent rerun)", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) => u.startsWith(`${BASE}/accounts/${ACCOUNT}/cfd_tunnel?name=nc-biz-b`),
        body: ok([{ id: "tun-existing", name: "nc-biz-b" }])
      },
      {
        match: (u) => u === `${BASE}/accounts/${ACCOUNT}/cfd_tunnel/tun-existing/token`,
        body: ok("RE-FETCHED-TOKEN")
      },
      {
        match: (u, i) =>
          i?.method === "PUT" &&
          u === `${BASE}/accounts/${ACCOUNT}/cfd_tunnel/tun-existing/configurations`,
        body: ok({})
      },
      {
        match: (u) => u === `${BASE}/zones?name=${encodeURIComponent(ZONE)}`,
        body: ok([{ id: "zone-1", name: ZONE }])
      },
      {
        match: (u) => u.startsWith(`${BASE}/zones/zone-1/dns_records?type=CNAME&name=`),
        body: ok([
          { id: "rec-1", content: "tun-existing.cfargotunnel.com", proxied: true }
        ])
      }
    ]);

    const provisioner = createCloudflareTunnelProvisioner(baseConfig(fetchImpl));
    const result = await provisioner({ businessId: "biz-b" });
    expect(result.tunnelId).toBe("tun-existing");
    expect(result.token).toBe("RE-FETCHED-TOKEN");
    // No POST to cfd_tunnel (creation) and no POST/PATCH to dns_records
    // (the existing record already matches).
    expect(
      calls.find(
        (c) => c.method === "POST" && c.url === `${BASE}/accounts/${ACCOUNT}/cfd_tunnel`
      )
    ).toBeUndefined();
    expect(
      calls.find((c) => c.method === "POST" && c.url === `${BASE}/zones/zone-1/dns_records`)
    ).toBeUndefined();
  });

  it("PATCHes the CNAME when it points at a stale tunnel", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) => u.startsWith(`${BASE}/accounts/${ACCOUNT}/cfd_tunnel?name=nc-biz-c`),
        body: ok([{ id: "tun-c", name: "nc-biz-c" }])
      },
      {
        match: (u) => u === `${BASE}/accounts/${ACCOUNT}/cfd_tunnel/tun-c/token`,
        body: ok("TOK")
      },
      {
        match: (u, i) => i?.method === "PUT" && u.endsWith("/configurations"),
        body: ok({})
      },
      {
        match: (u) => u === `${BASE}/zones?name=${encodeURIComponent(ZONE)}`,
        body: ok([{ id: "zone-1", name: ZONE }])
      },
      {
        match: (u) => u.startsWith(`${BASE}/zones/zone-1/dns_records?type=CNAME&name=`),
        body: ok([{ id: "rec-c", content: "tun-OLD.cfargotunnel.com", proxied: false }])
      },
      {
        match: (u, i) =>
          i?.method === "PATCH" && u === `${BASE}/zones/zone-1/dns_records/rec-c`,
        body: ok({})
      }
    ]);

    const provisioner = createCloudflareTunnelProvisioner(baseConfig(fetchImpl));
    await provisioner({ businessId: "biz-c" });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toMatchObject({
      type: "CNAME",
      name: `biz-c.${ZONE}`,
      content: "tun-c.cfargotunnel.com",
      proxied: true
    });
  });

  it("throws a clear error when the zone is not on Cloudflare", async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (u) => u.startsWith(`${BASE}/accounts/${ACCOUNT}/cfd_tunnel?name=`),
        body: ok([])
      },
      {
        match: (u, i) => i?.method === "POST" && u.endsWith("/cfd_tunnel"),
        body: ok({ id: "tun-z" })
      },
      { match: (u) => u.endsWith("/token"), body: ok("T") },
      { match: (u, i) => i?.method === "PUT" && u.endsWith("/configurations"), body: ok({}) },
      { match: (u) => u === `${BASE}/zones?name=${encodeURIComponent(ZONE)}`, body: ok([]) }
    ]);

    const provisioner = createCloudflareTunnelProvisioner(baseConfig(fetchImpl));
    await expect(provisioner({ businessId: "biz-z" })).rejects.toThrow(
      `Cloudflare zone "${ZONE}" not found`
    );
  });

  it("surfaces Cloudflare API errors verbatim", async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (u) => u.startsWith(`${BASE}/accounts/${ACCOUNT}/cfd_tunnel?name=`),
        body: fail(1000, "Invalid API Token"),
        status: 401
      }
    ]);

    const provisioner = createCloudflareTunnelProvisioner(baseConfig(fetchImpl));
    await expect(provisioner({ businessId: "biz-err" })).rejects.toThrow(
      "1000: Invalid API Token"
    );
  });

  it("rejects empty tunnel tokens so operators catch CF regressions", async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (u) => u.startsWith(`${BASE}/accounts/${ACCOUNT}/cfd_tunnel?name=`),
        body: ok([{ id: "tun-empty" }])
      },
      {
        match: (u) => u.endsWith("/cfd_tunnel/tun-empty/token"),
        body: ok("")
      }
    ]);
    const provisioner = createCloudflareTunnelProvisioner(baseConfig(fetchImpl));
    await expect(provisioner({ businessId: "biz-empty" })).rejects.toThrow(
      "empty tunnel token"
    );
  });

  it("requires businessId", async () => {
    const { fetchImpl } = makeFetch([]);
    const provisioner = createCloudflareTunnelProvisioner(baseConfig(fetchImpl));
    await expect(provisioner({ businessId: "" })).rejects.toThrow("businessId required");
  });

  it("validates config eagerly", () => {
    expect(() =>
      createCloudflareTunnelProvisioner({
        apiToken: "",
        accountId: "x",
        zoneName: "z",
        serviceUrl: "s"
      })
    ).toThrow("apiToken");
    expect(() =>
      createCloudflareTunnelProvisioner({
        apiToken: "t",
        accountId: "",
        zoneName: "z",
        serviceUrl: "s"
      })
    ).toThrow("accountId");
    expect(() =>
      createCloudflareTunnelProvisioner({
        apiToken: "t",
        accountId: "a",
        zoneName: "",
        serviceUrl: "s"
      })
    ).toThrow("zoneName");
    expect(() =>
      createCloudflareTunnelProvisioner({
        apiToken: "t",
        accountId: "a",
        zoneName: "z",
        serviceUrl: ""
      })
    ).toThrow("serviceUrl");
  });

  it("throws on non-JSON responses", async () => {
    const fetchImpl = (async () =>
      new Response("<html>500</html>", {
        status: 500,
        headers: { "Content-Type": "text/html" }
      })) as unknown as typeof fetch;
    const provisioner = createCloudflareTunnelProvisioner(baseConfig(fetchImpl));
    await expect(provisioner({ businessId: "biz-html" })).rejects.toThrow("non-JSON");
  });

  it("envelopeErrorMessage falls back to 'unknown error' on empty errors[]", async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (u) => u.startsWith(`${BASE}/accounts/${ACCOUNT}/cfd_tunnel?name=`),
        body: { success: false, errors: [], result: null }
      }
    ]);
    const provisioner = createCloudflareTunnelProvisioner(baseConfig(fetchImpl));
    await expect(provisioner({ businessId: "biz-empty-err" })).rejects.toThrow("unknown error");
  });
});

describe("cloudflareTunnelProvisionerFromEnv", () => {
  it("returns null when credentials are missing", () => {
    expect(cloudflareTunnelProvisionerFromEnv({})).toBeNull();
    expect(cloudflareTunnelProvisionerFromEnv({ CLOUDFLARE_API_TOKEN: "t" })).toBeNull();
    expect(cloudflareTunnelProvisionerFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a" })).toBeNull();
  });

  it("returns a usable provisioner when both are set, defaulting zone/service", () => {
    const provisioner = cloudflareTunnelProvisionerFromEnv({
      CLOUDFLARE_API_TOKEN: "t",
      CLOUDFLARE_ACCOUNT_ID: "a"
    });
    expect(provisioner).not.toBeNull();
    expect(typeof provisioner).toBe("function");
  });

  it("honors CLOUDFLARE_TUNNEL_ZONE / CLOUDFLARE_TUNNEL_SERVICE_URL overrides", async () => {
    // Capture the URL the provisioner queries for its first tunnel lookup — if
    // our overrides flow through, the downstream DNS zone lookup will include
    // the custom zone name. We short-circuit early by returning an empty list
    // for the tunnel lookup and a failing zone lookup, asserting on the latter.
    const seen: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      seen.push(u);
      if (u.includes("cfd_tunnel?name=")) {
        return new Response(JSON.stringify(ok([{ id: "tun-x" }])), { status: 200 });
      }
      if (u.endsWith("/token")) {
        return new Response(JSON.stringify(ok("TOK")), { status: 200 });
      }
      if (u.includes("/configurations")) {
        return new Response(JSON.stringify(ok({})), { status: 200 });
      }
      if (u.startsWith(`${BASE}/zones?name=`)) {
        return new Response(JSON.stringify(ok([])), { status: 200 });
      }
      return new Response(JSON.stringify(ok({})), { status: 200 });
    }) as unknown as typeof fetch;
    // We have to go through the factory + inject fetchImpl because from-env
    // doesn't expose its fetch seam.
    const provisioner = createCloudflareTunnelProvisioner({
      apiToken: "t",
      accountId: "a",
      zoneName: "custom.example.org",
      serviceUrl: "http://127.0.0.1:9999",
      fetchImpl
    });
    await expect(provisioner({ businessId: "biz-x" })).rejects.toThrow("custom.example.org");
    expect(seen.some((u) => u.includes("custom.example.org"))).toBe(true);
  });
});
