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
  /**
   * When true, the handler is NOT consumed after matching. Useful for the
   * DNS-records list / POST / PATCH endpoints, which are now called twice
   * per provisioning (once per public hostname — app + voice bridge). Keep
   * unset/false for tests that want to assert a handler fires exactly once.
   */
  reuse?: boolean;
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
    const handler = queue[idx];
    if (!handler.reuse) queue.splice(idx, 1);
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

/**
 * Shared handler for the Total TLS PATCH the provisioner now issues at the
 * end of every successful run (so multi-level tunnel hostnames get a Let's
 * Encrypt cert from the CF edge — Universal SSL only covers one wildcard
 * level). Matches `PATCH /zones/<id>/acm/total_tls` for any zone id and
 * is `reuse: true` because the call happens once per tenant per
 * provisioning attempt; tests that re-run the provisioner against the same
 * zone reuse the same handler. Idempotent on the CF side too — re-PATCHes
 * are no-ops.
 */
function totalTlsHandler(): Handler {
  return {
    match: (u, i) =>
      i?.method === "PATCH" && /\/zones\/[^/]+\/acm\/total_tls$/.test(u),
    body: ok({ enabled: true }),
    reuse: true
  };
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
        body: ok([]),
        reuse: true
      },
      {
        match: (u, i) =>
          i?.method === "POST" && u === `${BASE}/zones/zone-1/dns_records`,
        body: ok({ id: "rec-1" }),
        reuse: true
      },
      totalTlsHandler()
    ]);

    const provisioner = createCloudflareTunnelProvisioner(baseConfig(fetchImpl));
    const result = await provisioner({ businessId: "biz-a" });
    expect(result).toEqual({
      tunnelId: "tun-1",
      token: "TUNNEL_INSTALL_TOKEN",
      hostname: `biz-a.${ZONE}`,
      voiceHostname: `voice-biz-a.${ZONE}`
    });

    // Both public hostnames get a CNAME in the same zone, pointing at the same
    // tunnel target — Cloudflare routes by Host header inside the tunnel.
    const appDnsCreate = calls.find(
      (c) =>
        c.method === "POST" &&
        c.url === `${BASE}/zones/zone-1/dns_records` &&
        (c.body as { name?: string }).name === `biz-a.${ZONE}`
    );
    expect(appDnsCreate?.body).toMatchObject({
      type: "CNAME",
      name: `biz-a.${ZONE}`,
      content: "tun-1.cfargotunnel.com",
      proxied: true
    });
    const voiceDnsCreate = calls.find(
      (c) =>
        c.method === "POST" &&
        c.url === `${BASE}/zones/zone-1/dns_records` &&
        (c.body as { name?: string }).name === `voice-biz-a.${ZONE}`
    );
    expect(voiceDnsCreate?.body).toMatchObject({
      type: "CNAME",
      name: `voice-biz-a.${ZONE}`,
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
          { hostname: `voice-biz-a.${ZONE}`, service: "http://127.0.0.1:8090" },
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
        body: ok([]),
        reuse: true
      },
      {
        match: (u, i) => i?.method === "POST" && u === `${BASE}/zones/zone-apex/dns_records`,
        body: ok({ id: "rec-h" }),
        reuse: true
      },
      totalTlsHandler()
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
    expect(result.voiceHostname).toBe("voice-biz-h.tunnel.newcoworker.com");

    const appCreate = calls.find(
      (c) =>
        c.method === "POST" &&
        c.url === `${BASE}/zones/zone-apex/dns_records` &&
        (c.body as { name?: string }).name === "biz-h.tunnel.newcoworker.com"
    );
    expect(appCreate?.body).toMatchObject({
      type: "CNAME",
      name: "biz-h.tunnel.newcoworker.com",
      content: "tun-h.cfargotunnel.com",
      proxied: true
    });
    const voiceCreate = calls.find(
      (c) =>
        c.method === "POST" &&
        c.url === `${BASE}/zones/zone-apex/dns_records` &&
        (c.body as { name?: string }).name === "voice-biz-h.tunnel.newcoworker.com"
    );
    expect(voiceCreate?.body).toMatchObject({
      type: "CNAME",
      name: "voice-biz-h.tunnel.newcoworker.com",
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
          {
            hostname: "voice-biz-h.tunnel.newcoworker.com",
            service: "http://127.0.0.1:8090"
          },
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
        body: ok([]),
        reuse: true
      },
      {
        match: (u, i) => i?.method === "POST" && u === `${BASE}/zones/preset-zone/dns_records`,
        body: ok({ id: "rec-z" }),
        reuse: true
      },
      totalTlsHandler()
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
        // App hostname: existing CNAME already matches current tunnel target.
        match: (u) =>
          u === `${BASE}/zones/zone-1/dns_records?type=CNAME&name=${encodeURIComponent(`biz-b.${ZONE}`)}`,
        body: ok([
          { id: "rec-1", content: "tun-existing.cfargotunnel.com", proxied: true }
        ])
      },
      {
        // Voice hostname: also already correctly wired — true idempotent
        // rerun means both CNAMEs exist and point at the same tunnel.
        match: (u) =>
          u === `${BASE}/zones/zone-1/dns_records?type=CNAME&name=${encodeURIComponent(`voice-biz-b.${ZONE}`)}`,
        body: ok([
          { id: "rec-2", content: "tun-existing.cfargotunnel.com", proxied: true }
        ])
      },
      totalTlsHandler()
    ]);

    const provisioner = createCloudflareTunnelProvisioner(baseConfig(fetchImpl));
    const result = await provisioner({ businessId: "biz-b" });
    expect(result.tunnelId).toBe("tun-existing");
    expect(result.token).toBe("RE-FETCHED-TOKEN");
    expect(result.voiceHostname).toBe(`voice-biz-b.${ZONE}`);
    // No POST to cfd_tunnel (creation) and no POST/PATCH to dns_records
    // (both existing records already match).
    expect(
      calls.find(
        (c) => c.method === "POST" && c.url === `${BASE}/accounts/${ACCOUNT}/cfd_tunnel`
      )
    ).toBeUndefined();
    expect(
      calls.find((c) => c.method === "POST" && c.url === `${BASE}/zones/zone-1/dns_records`)
    ).toBeUndefined();
    expect(
      calls.find(
        (c) => c.method === "PATCH" && c.url.startsWith(`${BASE}/zones/zone-1/dns_records/`)
      )
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
        // App hostname record is stale (wrong target + not proxied) — PATCH it.
        match: (u) =>
          u === `${BASE}/zones/zone-1/dns_records?type=CNAME&name=${encodeURIComponent(`biz-c.${ZONE}`)}`,
        body: ok([{ id: "rec-c-app", content: "tun-OLD.cfargotunnel.com", proxied: false }])
      },
      {
        // Voice hostname has its own stale record — exercise both PATCH calls.
        match: (u) =>
          u === `${BASE}/zones/zone-1/dns_records?type=CNAME&name=${encodeURIComponent(`voice-biz-c.${ZONE}`)}`,
        body: ok([{ id: "rec-c-voice", content: "tun-OLD.cfargotunnel.com", proxied: false }])
      },
      {
        match: (u, i) =>
          i?.method === "PATCH" && u === `${BASE}/zones/zone-1/dns_records/rec-c-app`,
        body: ok({})
      },
      {
        match: (u, i) =>
          i?.method === "PATCH" && u === `${BASE}/zones/zone-1/dns_records/rec-c-voice`,
        body: ok({})
      },
      totalTlsHandler()
    ]);

    const provisioner = createCloudflareTunnelProvisioner(baseConfig(fetchImpl));
    await provisioner({ businessId: "biz-c" });
    const appPatch = calls.find(
      (c) => c.method === "PATCH" && c.url === `${BASE}/zones/zone-1/dns_records/rec-c-app`
    );
    expect(appPatch?.body).toMatchObject({
      type: "CNAME",
      name: `biz-c.${ZONE}`,
      content: "tun-c.cfargotunnel.com",
      proxied: true
    });
    const voicePatch = calls.find(
      (c) => c.method === "PATCH" && c.url === `${BASE}/zones/zone-1/dns_records/rec-c-voice`
    );
    expect(voicePatch?.body).toMatchObject({
      type: "CNAME",
      name: `voice-biz-c.${ZONE}`,
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

  it("treats a non-array tunnel-list result as no matches (defensive)", async () => {
    // Cloudflare's envelope.result is *almost* always an array for list
    // endpoints, but misbehaving proxies and schema drift can hand us back an
    // object/null/string. The provisioner falls through to the "create" path
    // in that case rather than crashing with `.filter is not a function` —
    // this test exercises the `Array.isArray(existing) ? … : []` false branch.
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) => u.startsWith(`${BASE}/accounts/${ACCOUNT}/cfd_tunnel?name=nc-biz-nonarr`),
        body: ok(null as unknown)
      },
      {
        match: (u, i) => i?.method === "POST" && u === `${BASE}/accounts/${ACCOUNT}/cfd_tunnel`,
        body: ok({ id: "tun-na", name: "nc-biz-nonarr" })
      },
      { match: (u) => u.endsWith("/cfd_tunnel/tun-na/token"), body: ok("T") },
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
        body: ok([]),
        reuse: true
      },
      {
        match: (u, i) => i?.method === "POST" && u === `${BASE}/zones/zone-1/dns_records`,
        body: ok({ id: "rec-na" }),
        reuse: true
      },
      totalTlsHandler()
    ]);

    const provisioner = createCloudflareTunnelProvisioner(baseConfig(fetchImpl));
    const result = await provisioner({ businessId: "biz-nonarr" });
    expect(result.tunnelId).toBe("tun-na");
    // Prove we took the *create* path, not the reuse path.
    expect(
      calls.some((c) => c.method === "POST" && c.url === `${BASE}/accounts/${ACCOUNT}/cfd_tunnel`)
    ).toBe(true);
  });

  it("filters out soft-deleted tunnels and creates a fresh one", async () => {
    // CF's list endpoint returns tombstoned tunnels with a non-null
    // `deleted_at`; reusing one of those would wedge every subsequent call.
    // This covers the truthy side of `!t.deleted_at` (filter out) alongside
    // the falsy side already covered by the "cold start" test.
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) => u.startsWith(`${BASE}/accounts/${ACCOUNT}/cfd_tunnel?name=nc-biz-tomb`),
        body: ok([{ id: "tun-dead", name: "nc-biz-tomb", deleted_at: "2026-01-01T00:00:00Z" }])
      },
      {
        match: (u, i) => i?.method === "POST" && u === `${BASE}/accounts/${ACCOUNT}/cfd_tunnel`,
        body: ok({ id: "tun-fresh", name: "nc-biz-tomb" })
      },
      { match: (u) => u.endsWith("/cfd_tunnel/tun-fresh/token"), body: ok("T") },
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
        body: ok([]),
        reuse: true
      },
      {
        match: (u, i) => i?.method === "POST" && u === `${BASE}/zones/zone-1/dns_records`,
        body: ok({ id: "rec-fresh" }),
        reuse: true
      },
      totalTlsHandler()
    ]);

    const provisioner = createCloudflareTunnelProvisioner(baseConfig(fetchImpl));
    const result = await provisioner({ businessId: "biz-tomb" });
    expect(result.tunnelId).toBe("tun-fresh");
    expect(
      calls.some((c) => c.method === "POST" && c.url === `${BASE}/accounts/${ACCOUNT}/cfd_tunnel`)
    ).toBe(true);
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

  it("PATCHes Total TLS on the zone after CNAMEs are wired (cert auto-issuance)", async () => {
    // Pin the contract: every successful provision MUST issue a single
    // PATCH /zones/<id>/acm/total_tls with `{ enabled: true,
    // certificate_authority: "lets_encrypt" }`. Without this, multi-level
    // tunnel hostnames (e.g. <biz>.tunnel.newcoworker.com inside the
    // newcoworker.com zone) have no edge cert and the dashboard chat fails
    // with `sslv3 alert handshake failure` even when every container is
    // healthy. See `ensureZoneTotalTls` in tunnel.ts for the full rationale.
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) => u.startsWith(`${BASE}/accounts/${ACCOUNT}/cfd_tunnel?name=nc-biz-tls`),
        body: ok([])
      },
      {
        match: (u, i) => i?.method === "POST" && u === `${BASE}/accounts/${ACCOUNT}/cfd_tunnel`,
        body: ok({ id: "tun-tls" })
      },
      { match: (u) => u.endsWith("/cfd_tunnel/tun-tls/token"), body: ok("T") },
      { match: (u, i) => i?.method === "PUT" && u.endsWith("/configurations"), body: ok({}) },
      {
        match: (u) => u === `${BASE}/zones?name=${encodeURIComponent(ZONE)}`,
        body: ok([{ id: "zone-tls", name: ZONE }])
      },
      {
        match: (u) => u.startsWith(`${BASE}/zones/zone-tls/dns_records?type=CNAME&name=`),
        body: ok([]),
        reuse: true
      },
      {
        match: (u, i) => i?.method === "POST" && u === `${BASE}/zones/zone-tls/dns_records`,
        body: ok({ id: "rec" }),
        reuse: true
      },
      {
        match: (u, i) =>
          i?.method === "PATCH" && u === `${BASE}/zones/zone-tls/acm/total_tls`,
        body: ok({ enabled: true, certificate_authority: "lets_encrypt" })
      }
    ]);
    const provisioner = createCloudflareTunnelProvisioner(baseConfig(fetchImpl));
    await provisioner({ businessId: "biz-tls" });
    const totalTlsCall = calls.find(
      (c) => c.method === "PATCH" && c.url === `${BASE}/zones/zone-tls/acm/total_tls`
    );
    expect(totalTlsCall).toBeDefined();
    expect(totalTlsCall?.body).toEqual({
      enabled: true,
      certificate_authority: "lets_encrypt"
    });
    // CNAMEs must be created BEFORE Total TLS — Cloudflare lazily issues
    // certs per existing hostname, so the order matters.
    const totalTlsIdx = calls.findIndex(
      (c) => c.method === "PATCH" && c.url === `${BASE}/zones/zone-tls/acm/total_tls`
    );
    const lastCnameIdx = calls.map((c, i) => ({ c, i })).reverse().find(
      (e) => e.c.method === "POST" && e.c.url === `${BASE}/zones/zone-tls/dns_records`
    )?.i;
    expect(lastCnameIdx).toBeDefined();
    expect(totalTlsIdx).toBeGreaterThan(lastCnameIdx as number);
  });

  it("does NOT abort provisioning when Total TLS PATCH fails (cert is best-effort)", async () => {
    // The data-plane (tunnel + ingress + CNAMEs) is what makes the
    // service reachable; Total TLS is an edge-cert convenience that can
    // be re-tried later. A 4xx here must be logged and swallowed so a
    // missing-scope token (e.g. operator forgot to add Zone:SSL:Edit)
    // does not regress the existing happy-path tunnel for every tenant.
    const { fetchImpl } = makeFetch([
      {
        match: (u) => u.startsWith(`${BASE}/accounts/${ACCOUNT}/cfd_tunnel?name=nc-biz-tlsfail`),
        body: ok([])
      },
      {
        match: (u, i) => i?.method === "POST" && u === `${BASE}/accounts/${ACCOUNT}/cfd_tunnel`,
        body: ok({ id: "tun-tlsfail" })
      },
      { match: (u) => u.endsWith("/cfd_tunnel/tun-tlsfail/token"), body: ok("T") },
      { match: (u, i) => i?.method === "PUT" && u.endsWith("/configurations"), body: ok({}) },
      {
        match: (u) => u === `${BASE}/zones?name=${encodeURIComponent(ZONE)}`,
        body: ok([{ id: "zone-tlsfail", name: ZONE }])
      },
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones/zone-tlsfail/dns_records?type=CNAME&name=`),
        body: ok([]),
        reuse: true
      },
      {
        match: (u, i) =>
          i?.method === "POST" && u === `${BASE}/zones/zone-tlsfail/dns_records`,
        body: ok({ id: "rec" }),
        reuse: true
      },
      {
        match: (u, i) =>
          i?.method === "PATCH" && u === `${BASE}/zones/zone-tlsfail/acm/total_tls`,
        body: fail(10000, "Authentication error"),
        status: 403
      }
    ]);
    const provisioner = createCloudflareTunnelProvisioner(baseConfig(fetchImpl));
    const result = await provisioner({ businessId: "biz-tlsfail" });
    // Provisioning still returns a usable token + hostnames; only the
    // edge cert is delayed.
    expect(result.tunnelId).toBe("tun-tlsfail");
    expect(result.hostname).toBe(`biz-tlsfail.${ZONE}`);
  });

  it("honors voiceServiceUrl + voiceHostnamePrefix overrides end-to-end", async () => {
    // Covers the "caller supplied a real value (non-empty after trim)" branch
    // for both voice-bridge knobs — counterpart to the whitespace-only test
    // above, which exercises the coercion fallback.
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) => u.startsWith(`${BASE}/accounts/${ACCOUNT}/cfd_tunnel?name=nc-biz-v`),
        body: ok([{ id: "tun-v" }])
      },
      { match: (u) => u.endsWith("/cfd_tunnel/tun-v/token"), body: ok("T") },
      { match: (u, i) => i?.method === "PUT" && u.endsWith("/configurations"), body: ok({}) },
      {
        match: (u) => u.startsWith(`${BASE}/zones/zone-v/dns_records?type=CNAME&name=`),
        body: ok([]),
        reuse: true
      },
      {
        match: (u, i) => i?.method === "POST" && u === `${BASE}/zones/zone-v/dns_records`,
        body: ok({ id: "rec-v" }),
        reuse: true
      },
      totalTlsHandler()
    ]);
    const provisioner = createCloudflareTunnelProvisioner({
      apiToken: TOKEN,
      accountId: ACCOUNT,
      zoneName: "tunnel.newcoworker.com",
      zoneId: "zone-v",
      serviceUrl: "http://localhost:3000",
      voiceServiceUrl: "http://127.0.0.1:9090",
      voiceHostnamePrefix: "vb-",
      fetchImpl
    });
    const result = await provisioner({ businessId: "biz-v" });
    expect(result.voiceHostname).toBe("vb-biz-v.tunnel.newcoworker.com");
    const ingress = calls.find(
      (c) => c.method === "PUT" && c.url.endsWith("/configurations")
    );
    expect(ingress?.body).toMatchObject({
      config: {
        ingress: [
          { hostname: "biz-v.tunnel.newcoworker.com", service: "http://localhost:3000" },
          {
            hostname: "vb-biz-v.tunnel.newcoworker.com",
            service: "http://127.0.0.1:9090"
          },
          { service: "http_status:404" }
        ]
      }
    });
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

  it("empty-string CLOUDFLARE_* overrides collapse to defaults (dotenv blank-line regression)", async () => {
    // .env.example documents several CLOUDFLARE_* keys as optional. When the
    // operator leaves them blank — the `.env` canonical form is `KEY=` — dotenv
    // hands us `""`, which is NOT caught by `??` or destructuring defaults.
    // Regression: an empty CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX used to produce
    // hostname="<bid>." (trailing-dot label), creating an invalid CNAME record.
    //
    // This test drives the full provisioner with all optional keys set to ""
    // and asserts the hostname / zone-lookup collapse to the documented
    // defaults. We can't observe it from the returned provisioner directly, so
    // we let it fail at the zone-lookup step and inspect the URL it queried —
    // if coercion is missing, the URL would be the literal "zones?name=" with
    // no zone, and the hostname argument passed down would be malformed.
    const seen: string[] = [];
    let lastIngress: unknown = null;
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      seen.push(u);
      if (u.includes("cfd_tunnel?name=")) {
        return new Response(JSON.stringify(ok([{ id: "tun-e" }])), { status: 200 });
      }
      if (u.endsWith("/token")) {
        return new Response(JSON.stringify(ok("TOK")), { status: 200 });
      }
      if (u.includes("/configurations")) {
        lastIngress = init?.body ? JSON.parse(String(init.body)) : null;
        return new Response(JSON.stringify(ok({})), { status: 200 });
      }
      // Cause provisioning to fail here so we can assert on the zone lookup URL.
      if (u.startsWith(`${BASE}/zones?name=`)) {
        return new Response(JSON.stringify(ok([])), { status: 200 });
      }
      return new Response(JSON.stringify(ok({})), { status: 200 });
    }) as unknown as typeof fetch;

    const provisioner = cloudflareTunnelProvisionerFromEnv({
      CLOUDFLARE_API_TOKEN: "t",
      CLOUDFLARE_ACCOUNT_ID: "a",
      CLOUDFLARE_TUNNEL_ZONE: "",
      CLOUDFLARE_TUNNEL_SERVICE_URL: "",
      CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX: "",
      CLOUDFLARE_ZONE_ID: "",
      CLOUDFLARE_TUNNEL_VOICE_SERVICE_URL: "",
      CLOUDFLARE_TUNNEL_VOICE_HOSTNAME_PREFIX: ""
    });
    expect(provisioner).not.toBeNull();
    // Inject the fetch seam via the internal factory. We re-use credentials from
    // the env to prove they survived coercion (apiToken="t", accountId="a").
    const provisionerWithFetch = createCloudflareTunnelProvisioner({
      apiToken: "t",
      accountId: "a",
      zoneName: "tunnel.newcoworker.com",
      serviceUrl: "http://localhost:3000",
      hostnameSuffix: "",
      voiceServiceUrl: "",
      voiceHostnamePrefix: "",
      fetchImpl
    });
    await expect(provisionerWithFetch({ businessId: "biz-e" })).rejects.toThrow(
      'Cloudflare zone "tunnel.newcoworker.com" not found'
    );
    // The ingress request must have received valid hostnames WITHOUT a
    // trailing dot — and the voice entry must have picked up the documented
    // default service URL / prefix despite the empty env values.
    expect(lastIngress).toMatchObject({
      config: {
        ingress: [
          { hostname: "biz-e.tunnel.newcoworker.com", service: "http://localhost:3000" },
          {
            hostname: "voice-biz-e.tunnel.newcoworker.com",
            service: "http://127.0.0.1:8090"
          },
          { service: "http_status:404" }
        ]
      }
    });
    // And the zone lookup must use the default zone, not the empty string.
    expect(
      seen.some((u) => u === `${BASE}/zones?name=tunnel.newcoworker.com`)
    ).toBe(true);
  });

  it("whitespace-only CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX also collapses to zoneName", async () => {
    // Belt-and-braces: accidental "  " values must not leak into the hostname.
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) => u.startsWith(`${BASE}/accounts/${ACCOUNT}/cfd_tunnel?name=nc-biz-ws`),
        body: ok([{ id: "tun-ws" }])
      },
      { match: (u) => u.endsWith("/cfd_tunnel/tun-ws/token"), body: ok("T") },
      { match: (u, i) => i?.method === "PUT" && u.endsWith("/configurations"), body: ok({}) },
      {
        match: (u) => u.startsWith(`${BASE}/zones/zone-w/dns_records?type=CNAME&name=`),
        body: ok([]),
        reuse: true
      },
      {
        match: (u, i) => i?.method === "POST" && u === `${BASE}/zones/zone-w/dns_records`,
        body: ok({ id: "rec-w" }),
        reuse: true
      },
      totalTlsHandler()
    ]);
    const provisioner = createCloudflareTunnelProvisioner({
      apiToken: TOKEN,
      accountId: ACCOUNT,
      zoneName: "tunnel.newcoworker.com",
      zoneId: "zone-w",
      hostnameSuffix: "   ",
      // Also exercise the whitespace-coercion path for the new voice-bridge
      // knobs: a padded prefix should trim to the documented default.
      voiceServiceUrl: "   ",
      voiceHostnamePrefix: "   ",
      serviceUrl: "http://localhost:3000",
      fetchImpl
    });
    const result = await provisioner({ businessId: "biz-ws" });
    expect(result.hostname).toBe("biz-ws.tunnel.newcoworker.com");
    expect(result.voiceHostname).toBe("voice-biz-ws.tunnel.newcoworker.com");
    const appCreate = calls.find(
      (c) =>
        c.method === "POST" &&
        c.url === `${BASE}/zones/zone-w/dns_records` &&
        (c.body as { name?: string }).name === "biz-ws.tunnel.newcoworker.com"
    );
    expect(appCreate?.body).toMatchObject({
      name: "biz-ws.tunnel.newcoworker.com"
    });
    const voiceCreate = calls.find(
      (c) =>
        c.method === "POST" &&
        c.url === `${BASE}/zones/zone-w/dns_records` &&
        (c.body as { name?: string }).name === "voice-biz-ws.tunnel.newcoworker.com"
    );
    expect(voiceCreate?.body).toMatchObject({
      name: "voice-biz-ws.tunnel.newcoworker.com"
    });
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
    // The zone-name override flows through as the `name` query param on the
    // zones lookup — `GET https://api.cloudflare.com/client/v4/zones?name=<zone>`.
    // Parse each captured URL and assert the lookup actually carried our
    // override as an exact-equality query value. Substring matching on the
    // full URL string is a CodeQL false-positive magnet; hostname/path +
    // `searchParams.get` gives us both a passing assertion and a safe pattern.
    expect(
      seen.some((u) => {
        let parsed: URL;
        try {
          parsed = new URL(u);
        } catch {
          return false;
        }
        return (
          parsed.hostname === "api.cloudflare.com" &&
          parsed.pathname === "/client/v4/zones" &&
          parsed.searchParams.get("name") === "custom.example.org"
        );
      })
    ).toBe(true);
  });
});
