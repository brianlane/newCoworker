import { afterEach, describe, expect, it, vi } from "vitest";

import {
  edgeResidencyDataBaseUrl,
  EdgeResidencyReadError,
  __clearEdgeResidencyModeCache,
  edgeConfirmedGatewayToken,
  edgeIsVpsReadMode,
  edgeReadMovedRows,
  edgeReadMovedRowsOrNull,
  edgeResidencyMode
} from "../supabase/functions/_shared/residency";

const BIZ = "biz-1";

/** Structural stub for the `businesses` mode lookup. */
function modeDb(result: { data: unknown; error: { message: string } | null } | (() => never)) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (typeof result === "function") result();
            return result as { data: unknown; error: { message: string } | null };
          }
        })
      })
    })
  } as never;
}

/** Structural stub for the `vps_gateway_tokens` lookup. */
function tokenDb(result: { data: unknown; error: { message: string } | null } | (() => never)) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            not: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => {
                    if (typeof result === "function") result();
                    return result as { data: unknown; error: { message: string } | null };
                  }
                })
              })
            })
          }),
          maybeSingle: async () => ({ data: null, error: null })
        })
      })
    })
  } as never;
}

const okFetch = (rows: unknown[]) =>
  vi.fn(async () => new Response(JSON.stringify({ ok: true, rows }), { status: 200 }));

afterEach(() => {
  __clearEdgeResidencyModeCache();
  delete (globalThis as { Deno?: unknown }).Deno;
});

describe("edge base URL", () => {
  it("reads env through Deno when running on the edge", async () => {
    // Same runtime-agnostic shape gateway_token.ts uses. Under Vitest the
    // Node branch runs, so the Deno branch needs the global stubbed or it is
    // shipped never having been executed once.
    (globalThis as { Deno?: unknown }).Deno = {
      env: { get: (n: string) => (n === "CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX" ? "edge.test" : undefined) }
    };
    expect(edgeResidencyDataBaseUrl(BIZ)).toBe("https://data-biz-1.edge.test");
  });

  it("falls through a blank env var instead of building a trailing-dot host", () => {
    (globalThis as { Deno?: unknown }).Deno = {
      env: { get: (n: string) => (n === "CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX" ? "  " : undefined) }
    };
    expect(edgeResidencyDataBaseUrl(BIZ)).toBe("https://data-biz-1.newcoworker.com");
  });
});

describe("edge residency mode", () => {
  it("reads the mode and caches it per isolate", async () => {
    const db = modeDb({ data: { data_residency_mode: "vps" }, error: null });
    expect(await edgeResidencyMode(db, BIZ)).toBe("vps");
    expect(await edgeIsVpsReadMode(db, BIZ)).toBe(true);
    // Second call is served from the cache: a worker draining several jobs
    // must not pay a businesses lookup per job.
    const exploding = modeDb(() => {
      throw new Error("must not re-query within the TTL");
    });
    expect(await edgeResidencyMode(exploding, BIZ)).toBe("vps");
  });

  it("normalizes unknown and absent modes to supabase", async () => {
    for (const raw of ["", "nonsense", undefined, null]) {
      __clearEdgeResidencyModeCache();
      const db = modeDb({ data: { data_residency_mode: raw }, error: null });
      expect(await edgeResidencyMode(db, BIZ)).toBe("supabase");
    }
    __clearEdgeResidencyModeCache();
    expect(await edgeResidencyMode(modeDb({ data: null, error: null }), BIZ)).toBe("supabase");
  });

  it("fails toward central WITHOUT caching the guess", async () => {
    // Mode resolution breaking must not take the inbound path down, but the
    // next job should re-ask rather than inherit a 30s-old fallback.
    const broken = modeDb({ data: null, error: { message: "pg down" } });
    expect(await edgeResidencyMode(broken, BIZ)).toBe("supabase");
    const healthy = modeDb({ data: { data_residency_mode: "vps" }, error: null });
    expect(await edgeResidencyMode(healthy, BIZ)).toBe("vps");
  });

  it("fails toward central when the client throws outright", async () => {
    expect(
      await edgeResidencyMode(
        modeDb(() => {
          throw new Error("boom");
        }),
        BIZ
      )
    ).toBe("supabase");
  });
});

describe("edge gateway token", () => {
  it("returns the confirmed token", async () => {
    expect(await edgeConfirmedGatewayToken(tokenDb({ data: { token: "t1" }, error: null }), BIZ)).toBe(
      "t1"
    );
  });

  it("returns null rather than a shared env fallback", async () => {
    // The box validates per-tenant tokens only, so the shared Rowboat secret
    // would earn a 401 that reads as "box down" instead of "wrong credential".
    process.env.ROWBOAT_VPS_CHAT_BEARER = "shared-secret";
    for (const r of [
      { data: null, error: null },
      { data: { token: "" }, error: null },
      { data: null, error: { message: "pg down" } }
    ]) {
      expect(await edgeConfirmedGatewayToken(tokenDb(r), BIZ)).toBeNull();
    }
    expect(
      await edgeConfirmedGatewayToken(
        tokenDb(() => {
          throw new Error("boom");
        }),
        BIZ
      )
    ).toBeNull();
    delete process.env.ROWBOAT_VPS_CHAT_BEARER;
  });
});

describe("edgeReadMovedRows", () => {
  it("posts the request with the tenant bearer and returns rows", async () => {
    const fetchImpl = okFetch([{ id: "c1" }]);
    const rows = await edgeReadMovedRows(
      tokenDb({ data: { token: "t1" }, error: null }),
      BIZ,
      { table: "contacts", columns: ["id"] },
      { fetchImpl: fetchImpl as never, baseUrl: "https://box.test" }
    );
    expect(rows).toEqual([{ id: "c1" }]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://box.test/v1/select");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer t1");
    expect(JSON.parse(init.body as string)).toEqual({ table: "contacts", columns: ["id"] });
  });

  it("throws when there is no confirmed token, naming the real cause", async () => {
    await expect(
      edgeReadMovedRows(tokenDb({ data: null, error: null }), BIZ, { table: "contacts" })
    ).rejects.toThrow(/no confirmed gateway token/);
  });

  it("throws on a structured ok:false, never an empty array", async () => {
    // The tunnel replaces origin 5xx bodies, so the data-api answers failures
    // with HTTP 200 + ok:false. Treating that as success would hand the
    // caller [] and read as "this customer has never written to us".
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "internal", message: "pg down" }), {
          status: 200
        })
    );
    await expect(
      edgeReadMovedRows(
        tokenDb({ data: { token: "t1" }, error: null }),
        BIZ,
        { table: "sms_outbound_log" },
        { fetchImpl: fetchImpl as never, baseUrl: "https://box.test" }
      )
    ).rejects.toThrow(/internal: pg down/);
  });

  it("throws on a non-2xx and on a transport failure", async () => {
    const http500 = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      edgeReadMovedRows(
        tokenDb({ data: { token: "t1" }, error: null }),
        BIZ,
        { table: "contacts" },
        { fetchImpl: http500 as never, baseUrl: "https://box.test" }
      )
    ).rejects.toThrow(/HTTP 500/);

    const dead = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const err = await edgeReadMovedRows(
      tokenDb({ data: { token: "t1" }, error: null }),
      BIZ,
      { table: "contacts" },
      { fetchImpl: dead as never, baseUrl: "https://box.test" }
    ).catch((e) => e);
    expect(err).toBeInstanceOf(EdgeResidencyReadError);
    expect((err as EdgeResidencyReadError).businessId).toBe(BIZ);
    expect((err as Error).message).toMatch(/ECONNREFUSED/);
  });

  it("derives the box URL from the business id when none is injected", async () => {
    const fetchImpl = okFetch([]);
    await edgeReadMovedRows(
      tokenDb({ data: { token: "t1" }, error: null }),
      BIZ,
      { table: "contacts" },
      { fetchImpl: fetchImpl as never }
    );
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://data-biz-1.newcoworker.com/v1/select"
    );
  });

  it("survives a non-Error throw without printing [object Object]", async () => {
    const weird = vi.fn(async () => {
      throw "just a string";
    });
    await expect(
      edgeReadMovedRows(
        tokenDb({ data: { token: "t1" }, error: null }),
        BIZ,
        { table: "contacts" },
        { fetchImpl: weird as never, baseUrl: "https://box.test" }
      )
    ).rejects.toThrow(/just a string/);
  });

  it("defaults a missing rows array to empty rather than undefined", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    expect(
      await edgeReadMovedRows(
        tokenDb({ data: { token: "t1" }, error: null }),
        BIZ,
        { table: "contacts" },
        { fetchImpl: fetchImpl as never, baseUrl: "https://box.test" }
      )
    ).toEqual([]);
  });

  it("aborts a hung box instead of wedging the worker", async () => {
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    await expect(
      edgeReadMovedRows(
        tokenDb({ data: { token: "t1" }, error: null }),
        BIZ,
        { table: "contacts" },
        { fetchImpl: hang as never, baseUrl: "https://box.test", timeoutMs: 5 }
      )
    ).rejects.toThrow(/aborted/);
  });
});

describe("edgeReadMovedRowsOrNull", () => {
  it("returns rows on success", async () => {
    expect(
      await edgeReadMovedRowsOrNull(
        tokenDb({ data: { token: "t1" }, error: null }),
        BIZ,
        { table: "notifications" },
        { fetchImpl: okFetch([{ id: "n1" }]) as never, baseUrl: "https://box.test" }
      )
    ).toEqual([{ id: "n1" }]);
  });

  it("returns NULL, not [], when the box is unreachable", async () => {
    // Null is distinguishable from "no rows", which is the whole point: a
    // suppression check can tell "I could not look" from "nothing matched".
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dead = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(
      await edgeReadMovedRowsOrNull(
        tokenDb({ data: { token: "t1" }, error: null }),
        BIZ,
        { table: "notifications" },
        { fetchImpl: dead as never, baseUrl: "https://box.test" }
      )
    ).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still logs readably when the underlying throw was not an Error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const weird = vi.fn(async () => {
      throw "just a string";
    });
    expect(
      await edgeReadMovedRowsOrNull(
        tokenDb({ data: { token: "t1" }, error: null }),
        BIZ,
        { table: "notifications" },
        { fetchImpl: weird as never, baseUrl: "https://box.test" }
      )
    ).toBeNull();
    expect(String(warn.mock.calls[0][1])).toContain("just a string");
    warn.mockRestore();
  });
});
