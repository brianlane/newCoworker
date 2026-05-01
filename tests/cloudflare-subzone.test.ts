import { describe, it, expect } from "vitest";
import {
  ensureChildZone,
  ensureNsDelegation,
  migrateTunnelCnamesToChildZone,
  ensureTunnelSubzone
} from "@/lib/cloudflare/subzone";

/**
 * Replays a queued list of [predicate, response] tuples against a fake
 * fetch. Mirrors the pattern in tests/cloudflare-tunnel.test.ts so a
 * future operator finding both files reads them as a matched pair.
 */
type Handler = {
  match: (url: string, init?: RequestInit) => boolean;
  body: unknown;
  status?: number;
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

const ACCOUNT = "acct-1";
const TOKEN = "test-token";
const PARENT_ZONE = "newcoworker.com";
const PARENT_ZONE_ID = "parent-zone-id";
const CHILD_ZONE = "tunnel.newcoworker.com";
const CHILD_ZONE_ID = "child-zone-id";
const NS_A = "alpha.ns.cloudflare.com";
const NS_B = "beta.ns.cloudflare.com";
const BASE = "https://api.cloudflare.com/client/v4";

describe("ensureChildZone", () => {
  it("creates the child zone when it doesn't exist and returns its NS", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones?name=${encodeURIComponent(CHILD_ZONE)}`),
        body: ok([])
      },
      {
        match: (u, i) => i?.method === "POST" && u === `${BASE}/zones`,
        body: ok({
          id: CHILD_ZONE_ID,
          name: CHILD_ZONE,
          name_servers: [NS_A, NS_B],
          status: "pending",
          account: { id: ACCOUNT }
        })
      }
    ]);
    const r = await ensureChildZone(
      { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
      CHILD_ZONE
    );
    expect(r.created).toBe(true);
    expect(r.zoneId).toBe(CHILD_ZONE_ID);
    expect(r.nameServers).toEqual([NS_A, NS_B]);
    // Pin the wire shape: `type: "full"` is required so Cloudflare assigns
    // its own NS records (i.e. delegation rather than CNAME setup), which
    // is what triggers free Universal SSL on the wildcard.
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { type: string }).type).toBe("full");
    expect((post?.body as { name: string }).name).toBe(CHILD_ZONE);
  });

  it("returns the existing zone (created=false) when it already exists in the same account", async () => {
    // Idempotency contract: re-running after a partial flow doesn't
    // re-POST and doesn't blow up on `1061 zone already exists`.
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones?name=${encodeURIComponent(CHILD_ZONE)}`),
        body: ok([
          {
            id: CHILD_ZONE_ID,
            name: CHILD_ZONE,
            name_servers: [NS_A, NS_B],
            status: "active"
          }
        ])
      }
    ]);
    const r = await ensureChildZone(
      { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
      CHILD_ZONE
    );
    expect(r.created).toBe(false);
    expect(r.zoneId).toBe(CHILD_ZONE_ID);
    expect(r.nameServers).toEqual([NS_A, NS_B]);
    expect(calls.find((c) => c.method === "POST")).toBeUndefined();
  });

  it("throws loudly when the existing zone has no nameservers yet (empty array)", async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones?name=${encodeURIComponent(CHILD_ZONE)}`),
        body: ok([{ id: CHILD_ZONE_ID, name: CHILD_ZONE, name_servers: [] }])
      }
    ]);
    await expect(
      ensureChildZone(
        { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
        CHILD_ZONE
      )
    ).rejects.toThrow(/has not been assigned nameservers yet/);
  });

  it("throws loudly when the existing zone is in pending state with name_servers absent (undefined)", async () => {
    // Realistic CF wire format: when a zone is in "pending"
    // (NS records not yet assigned), the API may return the zone
    // without a `name_servers` field at all. The `?? []` fallback
    // must catch this and route through the same error path as the
    // empty-array case — pins both branches of the `name_servers`
    // optional field handling.
    const { fetchImpl } = makeFetch([
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones?name=${encodeURIComponent(CHILD_ZONE)}`),
        body: ok([{ id: CHILD_ZONE_ID, name: CHILD_ZONE, status: "pending" }])
      }
    ]);
    await expect(
      ensureChildZone(
        { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
        CHILD_ZONE
      )
    ).rejects.toThrow(/has not been assigned nameservers yet/);
  });

  it("surfaces a CF error envelope as a thrown Error (token missing zone:edit scope)", async () => {
    // Realistic 403 from the actual probe: the operator's token didn't
    // have Account:Zone:Edit. Test makes sure the failure mode is loud
    // (Error throw with the CF error code in the message) rather than
    // silent.
    const { fetchImpl } = makeFetch([
      {
        match: (u) => u.startsWith(`${BASE}/zones?name=`),
        body: ok([])
      },
      {
        match: (u, i) => i?.method === "POST" && u === `${BASE}/zones`,
        body: fail(0, "Requires permission \"com.cloudflare.api.account.zone.create\" to create zones for the selected account"),
        status: 403
      }
    ]);
    await expect(
      ensureChildZone(
        { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
        CHILD_ZONE
      )
    ).rejects.toThrow(/zone\.create/);
  });

  it("falls back to global fetch when fetchImpl is omitted", async () => {
    // Pins the `config.fetchImpl ?? fetch` default so a future refactor
    // that forgets the fallback fails the suite. We monkey-patch the
    // global so the test stays hermetic.
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(ok([{ id: "z", name: CHILD_ZONE, name_servers: [NS_A, NS_B] }])), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })) as unknown as typeof fetch;
    try {
      const r = await ensureChildZone({ apiToken: TOKEN, accountId: ACCOUNT }, CHILD_ZONE);
      expect(r.zoneId).toBe("z");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("throws on non-JSON response (network shenanigans / Cloudflare 5xx HTML page)", async () => {
    const fetchImpl = (async () =>
      new Response("<html>upstream connect error</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" }
      })) as unknown as typeof fetch;
    await expect(
      ensureChildZone(
        { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
        CHILD_ZONE
      )
    ).rejects.toThrow(/non-JSON/);
  });
});

describe("ensureNsDelegation", () => {
  it("creates two NS records in the parent zone when none exist", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) => u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records?per_page=100&search=tunnel`),
        body: ok([])
      },
      {
        match: (u, i) =>
          i?.method === "POST" &&
          u === `${BASE}/zones/${PARENT_ZONE_ID}/dns_records`,
        body: ok({ id: "ns1-rec" }),
        reuse: true
      }
    ]);
    const r = await ensureNsDelegation(
      { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
      PARENT_ZONE_ID,
      "tunnel",
      [NS_A, NS_B]
    );
    expect(r.nsCreated).toBe(2);
    expect(r.nsUpdated).toBe(0);
    expect(r.legacyDeleted).toBe(0);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.length).toBe(2);
    expect((posts[0].body as { type: string }).type).toBe("NS");
    expect((posts[0].body as { name: string }).name).toBe("tunnel");
  });

  it("deletes pre-existing A/CNAME records on the delegated label before adding NS", async () => {
    // Cloudflare rejects coexisting CNAME + NS on the same name. The
    // helper must delete legacy records first; this test pins that
    // ordering invariant — a regression that POSTs the NS before
    // DELETEing the CNAME would silently fail in production.
    const orderLog: string[] = [];
    const { fetchImpl } = makeFetch([
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records?per_page=100&search=tunnel`),
        body: ok([
          { id: "legacy-cname", type: "CNAME", name: "tunnel", content: "old-target.cfargotunnel.com" },
          { id: "legacy-a", type: "A", name: "tunnel", content: "1.2.3.4" }
        ])
      },
      {
        match: (u, i) => {
          if (i?.method === "DELETE" && u.includes("/dns_records/legacy-cname")) {
            orderLog.push("delete-cname");
            return true;
          }
          return false;
        },
        body: ok({ id: "legacy-cname" })
      },
      {
        match: (u, i) => {
          if (i?.method === "DELETE" && u.includes("/dns_records/legacy-a")) {
            orderLog.push("delete-a");
            return true;
          }
          return false;
        },
        body: ok({ id: "legacy-a" })
      },
      {
        match: (u, i) => {
          if (
            i?.method === "POST" &&
            u === `${BASE}/zones/${PARENT_ZONE_ID}/dns_records`
          ) {
            orderLog.push("post-ns");
            return true;
          }
          return false;
        },
        body: ok({ id: "ns-new" }),
        reuse: true
      }
    ]);
    const r = await ensureNsDelegation(
      { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
      PARENT_ZONE_ID,
      "tunnel",
      [NS_A, NS_B]
    );
    expect(r.legacyDeleted).toBe(2);
    expect(r.nsCreated).toBe(2);
    // Both deletes precede every POST.
    const firstPostIdx = orderLog.indexOf("post-ns");
    expect(orderLog.slice(0, firstPostIdx)).toEqual(["delete-cname", "delete-a"]);
  });

  it("PATCHes existing NS records that point at a stale nameserver (re-delegation)", async () => {
    // Operator scenario: the child zone got recreated in CF (new
    // assigned NS) and we're re-running delegation. Existing parent NS
    // records pointing at the OLD nameservers must be repointed
    // without leaving stale entries.
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records?per_page=100&search=tunnel`),
        body: ok([
          { id: "ns-old-1", type: "NS", name: "tunnel", content: "stale-1.ns.cloudflare.com" },
          { id: "ns-old-2", type: "NS", name: "tunnel", content: "stale-2.ns.cloudflare.com" }
        ])
      },
      {
        match: (u, i) =>
          i?.method === "PATCH" &&
          u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records/ns-old-`),
        body: ok({ id: "patched" }),
        reuse: true
      }
    ]);
    const r = await ensureNsDelegation(
      { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
      PARENT_ZONE_ID,
      "tunnel",
      [NS_A, NS_B]
    );
    expect(r.nsUpdated).toBe(2);
    expect(r.nsCreated).toBe(0);
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.length).toBe(2);
    const contents = patches.map((c) => (c.body as { content: string }).content);
    expect(contents.sort()).toEqual([NS_A, NS_B].sort());
  });

  it("is a no-op when both desired NS records already exist (true idempotency)", async () => {
    // Re-running after a successful delegation should produce zero
    // network mutations and zero log entries — the contract that lets
    // the orchestrator call this helper at the start of every provision
    // without worrying about duplicate work.
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records?per_page=100&search=tunnel`),
        body: ok([
          { id: "ns-1", type: "NS", name: "tunnel", content: NS_A },
          { id: "ns-2", type: "NS", name: "tunnel", content: NS_B }
        ])
      }
    ]);
    const r = await ensureNsDelegation(
      { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
      PARENT_ZONE_ID,
      "tunnel",
      [NS_A, NS_B]
    );
    expect(r.nsCreated).toBe(0);
    expect(r.nsUpdated).toBe(0);
    expect(r.legacyDeleted).toBe(0);
    const mutations = calls.filter((c) => c.method !== "GET");
    expect(mutations.length).toBe(0);
  });

  it("does NOT delete records under deeper labels (e.g. <biz>.tunnel) — those belong to the migrate step", async () => {
    // Guards the boundary between ensureNsDelegation (works on the
    // delegated label only) and migrateTunnelCnamesToChildZone (works
    // on `<*>.tunnel.*`). Mixing them would cause data loss for
    // tenants under the delegated label during the cutover.
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records?per_page=100&search=tunnel`),
        body: ok([
          // Tenant CNAME — must NOT be touched here.
          {
            id: "tenant-cname",
            type: "CNAME",
            name: "biz-1.tunnel.newcoworker.com",
            content: "abc.cfargotunnel.com"
          }
        ])
      },
      {
        match: (u, i) =>
          i?.method === "POST" && u === `${BASE}/zones/${PARENT_ZONE_ID}/dns_records`,
        body: ok({ id: "ns-new" }),
        reuse: true
      }
    ]);
    const r = await ensureNsDelegation(
      { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
      PARENT_ZONE_ID,
      "tunnel",
      [NS_A, NS_B]
    );
    expect(r.legacyDeleted).toBe(0);
    expect(calls.find((c) => c.method === "DELETE")).toBeUndefined();
  });

  it("REGRESSION: handles production wire format where CF returns FQDN names even with bare-label input", async () => {
    // The actual production scenario after fixing a silent-skip bug:
    // operator/aggregator passes the BARE label "tunnel", but
    // Cloudflare's API returns DNS records with `name` set to the
    // full FQDN ("tunnel.newcoworker.com" for the apex, plus existing
    // NS records also in FQDN form). This test pins the
    // bare-vs-FQDN normalisation contract — without it, legacy A
    // records at the apex never get deleted (CNAME/NS coexist
    // validation error) and existing NS records pointing at stale
    // nameservers never get repointed.
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records?per_page=100&search=tunnel`),
        body: ok([
          // Legacy A at apex, FQDN form — must be deleted.
          {
            id: "legacy-a-fqdn",
            type: "A",
            name: "tunnel.newcoworker.com",
            content: "9.9.9.9"
          },
          // Existing NS pointing at a stale nameserver, FQDN form —
          // must be PATCHed to NS_A.
          {
            id: "ns-stale-fqdn",
            type: "NS",
            name: "tunnel.newcoworker.com",
            content: "stale.ns.cloudflare.com"
          },
          // Tenant CNAME under a deeper label — must NOT be touched.
          {
            id: "tenant-cname",
            type: "CNAME",
            name: "biz-1.tunnel.newcoworker.com",
            content: "abc.cfargotunnel.com"
          }
        ])
      },
      {
        match: (u, i) =>
          i?.method === "DELETE" &&
          u.endsWith("/dns_records/legacy-a-fqdn"),
        body: ok({ id: "deleted" })
      },
      {
        match: (u, i) =>
          i?.method === "PATCH" &&
          u.endsWith("/dns_records/ns-stale-fqdn"),
        body: ok({ id: "patched" })
      },
      {
        match: (u, i) =>
          i?.method === "POST" &&
          u === `${BASE}/zones/${PARENT_ZONE_ID}/dns_records`,
        body: ok({ id: "ns-new" })
      }
    ]);
    const r = await ensureNsDelegation(
      { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
      PARENT_ZONE_ID,
      "tunnel",
      [NS_A, NS_B]
    );
    // Legacy A at the FQDN apex IS deleted (the silent-skip bug fix).
    expect(r.legacyDeleted).toBe(1);
    // Stale NS at FQDN apex IS repointed via PATCH.
    expect(r.nsUpdated).toBe(1);
    // The second NS slot didn't exist, so it's POSTed.
    expect(r.nsCreated).toBe(1);
    // The tenant CNAME under `biz-1.tunnel...` is never touched here.
    const tenantTouched = calls.find(
      (c) =>
        (c.method === "DELETE" || c.method === "PATCH") &&
        c.url.endsWith("/dns_records/tenant-cname")
    );
    expect(tenantTouched).toBeUndefined();
  });
});

describe("migrateTunnelCnamesToChildZone", () => {
  it("creates each tenant CNAME in the child zone, then deletes from parent", async () => {
    const events: string[] = [];
    const { fetchImpl } = makeFetch([
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records?per_page=100&type=CNAME&search=tunnel`),
        body: ok([
          {
            id: "rec-biz-1",
            type: "CNAME",
            name: "biz-1.tunnel.newcoworker.com",
            content: "tun-1.cfargotunnel.com",
            proxied: true
          },
          {
            id: "rec-voice-biz-1",
            type: "CNAME",
            name: "voice-biz-1.tunnel.newcoworker.com",
            content: "tun-1.cfargotunnel.com",
            proxied: true
          }
        ])
      },
      {
        match: (u) =>
          u.startsWith(
            `${BASE}/zones/${CHILD_ZONE_ID}/dns_records?type=CNAME&name=`
          ),
        body: ok([]),
        reuse: true
      },
      {
        match: (u, i) => {
          if (
            i?.method === "POST" &&
            u === `${BASE}/zones/${CHILD_ZONE_ID}/dns_records`
          ) {
            events.push("child-create");
            return true;
          }
          return false;
        },
        body: ok({ id: "child-rec" }),
        reuse: true
      },
      {
        match: (u, i) => {
          if (
            i?.method === "DELETE" &&
            u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records/`)
          ) {
            events.push("parent-delete");
            return true;
          }
          return false;
        },
        body: ok({ id: "deleted" }),
        reuse: true
      }
    ]);
    const r = await migrateTunnelCnamesToChildZone(
      { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
      PARENT_ZONE_ID,
      CHILD_ZONE_ID,
      "tunnel",
      PARENT_ZONE
    );
    expect(r.migrated).toBe(2);
    expect(r.alreadyInChild).toBe(0);
    expect(r.deletedFromParent).toBe(2);
    // Critical ordering invariant: every parent-DELETE must follow the
    // child-CREATE for the SAME hostname, otherwise we'd produce a
    // resolution gap during cutover.
    const firstChildCreate = events.indexOf("child-create");
    const firstParentDelete = events.indexOf("parent-delete");
    expect(firstChildCreate).toBeLessThan(firstParentDelete);
  });

  it("counts records already present in the child as alreadyInChild + still cleans up parent", async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records?per_page=100&type=CNAME&search=tunnel`),
        body: ok([
          {
            id: "rec-biz-1",
            type: "CNAME",
            name: "biz-1.tunnel.newcoworker.com",
            content: "tun-1.cfargotunnel.com",
            proxied: true
          }
        ])
      },
      {
        match: (u) =>
          u.startsWith(
            `${BASE}/zones/${CHILD_ZONE_ID}/dns_records?type=CNAME&name=`
          ),
        body: ok([
          {
            id: "child-existing",
            type: "CNAME",
            name: "biz-1.tunnel.newcoworker.com",
            content: "tun-1.cfargotunnel.com",
            proxied: true
          }
        ])
      },
      {
        match: (u, i) =>
          i?.method === "DELETE" &&
          u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records/rec-biz-1`),
        body: ok({ id: "deleted" })
      }
    ]);
    const r = await migrateTunnelCnamesToChildZone(
      { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
      PARENT_ZONE_ID,
      CHILD_ZONE_ID,
      "tunnel",
      PARENT_ZONE
    );
    expect(r.migrated).toBe(0);
    expect(r.alreadyInChild).toBe(1);
    expect(r.deletedFromParent).toBe(1);
  });

  it("ignores records that aren't actually under the delegated label (defence against CF search wildcarding)", async () => {
    // CF's `search` parameter is a substring match, so a record like
    // `tunnel.othersite.com` could come back. The helper filters with
    // an explicit suffix check; this test pins that behaviour.
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records?per_page=100&type=CNAME&search=tunnel`),
        body: ok([
          {
            id: "rec-tunnel-foo",
            type: "CNAME",
            name: "biz-1.tunnel.newcoworker.com",
            content: "tun-1.cfargotunnel.com"
          },
          {
            id: "rec-unrelated",
            type: "CNAME",
            // Substring match but NOT under the delegated label.
            name: "tunnel.someothersite.com",
            content: "ignore-me.example.com"
          },
          {
            id: "rec-apex",
            type: "CNAME",
            // Apex of the delegated label itself — not a tenant CNAME.
            name: "tunnel.newcoworker.com",
            content: "apex.cfargotunnel.com"
          }
        ])
      },
      {
        match: (u) =>
          u.startsWith(
            `${BASE}/zones/${CHILD_ZONE_ID}/dns_records?type=CNAME&name=`
          ),
        body: ok([])
      },
      {
        match: (u, i) =>
          i?.method === "POST" && u === `${BASE}/zones/${CHILD_ZONE_ID}/dns_records`,
        body: ok({ id: "child-rec" })
      },
      {
        match: (u, i) =>
          i?.method === "DELETE" &&
          u.endsWith("/dns_records/rec-tunnel-foo"),
        body: ok({ id: "deleted" })
      }
    ]);
    const r = await migrateTunnelCnamesToChildZone(
      { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
      PARENT_ZONE_ID,
      CHILD_ZONE_ID,
      "tunnel",
      PARENT_ZONE
    );
    expect(r.migrated).toBe(1);
    expect(r.deletedFromParent).toBe(1);
    // The unrelated and apex records must NOT be touched.
    expect(
      calls.find(
        (c) =>
          c.method === "DELETE" &&
          (c.url.endsWith("rec-unrelated") || c.url.endsWith("rec-apex"))
      )
    ).toBeUndefined();
  });

  it("falls back to proxied=true when CF returns proxied as undefined", async () => {
    // Pins the `rec.proxied ?? true` defaulting. CF's API has a
    // historical quirk where `proxied` is omitted on records created
    // via certain API versions.
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records?per_page=100&type=CNAME&search=tunnel`),
        body: ok([
          {
            id: "rec-proxied-undef",
            type: "CNAME",
            name: "biz-1.tunnel.newcoworker.com",
            content: "tun-1.cfargotunnel.com"
            // proxied intentionally omitted
          }
        ])
      },
      {
        match: (u) =>
          u.startsWith(
            `${BASE}/zones/${CHILD_ZONE_ID}/dns_records?type=CNAME&name=`
          ),
        body: ok([])
      },
      {
        match: (u, i) =>
          i?.method === "POST" &&
          u === `${BASE}/zones/${CHILD_ZONE_ID}/dns_records`,
        body: ok({ id: "child-rec" })
      },
      {
        match: (u, i) => i?.method === "DELETE",
        body: ok({ id: "deleted" })
      }
    ]);
    await migrateTunnelCnamesToChildZone(
      { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
      PARENT_ZONE_ID,
      CHILD_ZONE_ID,
      "tunnel",
      PARENT_ZONE
    );
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { proxied: boolean }).proxied).toBe(true);
  });

  it("survives a parent zone with zero matching records (empty migration)", async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records?per_page=100&type=CNAME&search=tunnel`),
        body: ok([])
      }
    ]);
    const r = await migrateTunnelCnamesToChildZone(
      { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
      PARENT_ZONE_ID,
      CHILD_ZONE_ID,
      "tunnel",
      PARENT_ZONE
    );
    expect(r).toEqual({ migrated: 0, alreadyInChild: 0, deletedFromParent: 0 });
  });
});

describe("ensureTunnelSubzone (end-to-end aggregator)", () => {
  it("orchestrates create-zone → ensure-NS → migrate-CNAMEs and returns a combined summary", async () => {
    const { fetchImpl } = makeFetch([
      // Phase 1: child zone lookup → empty → POST /zones.
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones?name=${encodeURIComponent(CHILD_ZONE)}`),
        body: ok([])
      },
      {
        match: (u, i) => i?.method === "POST" && u === `${BASE}/zones`,
        body: ok({
          id: CHILD_ZONE_ID,
          name: CHILD_ZONE,
          name_servers: [NS_A, NS_B]
        })
      },
      // Phase 2: NS delegation lookup on parent → empty → POST × 2.
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records?per_page=100&search=tunnel`),
        body: ok([])
      },
      {
        match: (u, i) =>
          i?.method === "POST" &&
          u === `${BASE}/zones/${PARENT_ZONE_ID}/dns_records`,
        body: ok({ id: "ns-rec" }),
        reuse: true
      },
      // Phase 3: migrate CNAMEs → one parent CNAME, not in child yet.
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records?per_page=100&type=CNAME&search=tunnel`),
        body: ok([
          {
            id: "rec-biz-1",
            type: "CNAME",
            name: "biz-1.tunnel.newcoworker.com",
            content: "tun-1.cfargotunnel.com",
            proxied: true
          }
        ])
      },
      {
        match: (u) =>
          u.startsWith(
            `${BASE}/zones/${CHILD_ZONE_ID}/dns_records?type=CNAME&name=`
          ),
        body: ok([])
      },
      {
        match: (u, i) =>
          i?.method === "POST" &&
          u === `${BASE}/zones/${CHILD_ZONE_ID}/dns_records`,
        body: ok({ id: "child-rec" })
      },
      {
        match: (u, i) =>
          i?.method === "DELETE" &&
          u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records/`),
        body: ok({ id: "deleted" })
      }
    ]);
    const r = await ensureTunnelSubzone(
      { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
      {
        parentZoneName: PARENT_ZONE,
        parentZoneId: PARENT_ZONE_ID,
        delegatedLabel: "tunnel"
      }
    );
    expect(r.childZoneId).toBe(CHILD_ZONE_ID);
    expect(r.childZoneName).toBe(CHILD_ZONE);
    expect(r.nameServers).toEqual([NS_A, NS_B]);
    expect(r.childCreated).toBe(true);
    expect(r.delegationCreated).toBe(2);
    expect(r.delegationUpdated).toBe(0);
    expect(r.legacyDeletedFromParent).toBe(0);
    expect(r.cnamesMigrated).toBe(1);
    expect(r.cnamesAlreadyInChild).toBe(0);
    expect(r.cnamesDeletedFromParent).toBe(1);
  });

  it("is fully idempotent on a re-run after a previous successful provision", async () => {
    // Pin the contract that lets the orchestrator call this during
    // every provision: a re-run after success must mutate nothing.
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones?name=${encodeURIComponent(CHILD_ZONE)}`),
        body: ok([
          {
            id: CHILD_ZONE_ID,
            name: CHILD_ZONE,
            name_servers: [NS_A, NS_B]
          }
        ])
      },
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records?per_page=100&search=tunnel`),
        body: ok([
          { id: "ns-1", type: "NS", name: "tunnel", content: NS_A },
          { id: "ns-2", type: "NS", name: "tunnel", content: NS_B }
        ])
      },
      {
        match: (u) =>
          u.startsWith(`${BASE}/zones/${PARENT_ZONE_ID}/dns_records?per_page=100&type=CNAME&search=tunnel`),
        body: ok([])
      }
    ]);
    const r = await ensureTunnelSubzone(
      { apiToken: TOKEN, accountId: ACCOUNT, fetchImpl },
      {
        parentZoneName: PARENT_ZONE,
        parentZoneId: PARENT_ZONE_ID,
        delegatedLabel: "tunnel"
      }
    );
    expect(r.childCreated).toBe(false);
    expect(r.delegationCreated + r.delegationUpdated + r.legacyDeletedFromParent).toBe(0);
    expect(r.cnamesMigrated + r.cnamesDeletedFromParent).toBe(0);
    const mutations = calls.filter((c) => c.method !== "GET");
    expect(mutations.length).toBe(0);
  });
});
