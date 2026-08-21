import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DATA_API_BASE_URL,
  __clearVoiceResidencyModeCache,
  voiceIsVpsReadMode,
  voiceReadMovedRowsOrNull
} from "../vps/voice-bridge/src/residency";
import { loadVoiceContactTimeline } from "../vps/voice-bridge/src/contact-context";

/**
 * The voice bridge is the one residency caller that never leaves the box:
 * it runs on the tenant's VPS and the datastore is on 127.0.0.1 there. These
 * pin the loopback default, the credential it presents, and that a failure
 * on a live call degrades rather than throws.
 */

const BIZ = "biz-1";
const CALLER = "+15199560528";

function modeDb(mode: string | null, error: { message: string } | null = null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: mode === null ? null : { data_residency_mode: mode }, error })
        })
      })
    })
  } as never;
}

const okFetch = (rows: unknown[]) =>
  vi.fn(async () => new Response(JSON.stringify({ ok: true, rows }), { status: 200 }));

const ENV_KEYS = ["DATA_API_TOKENS", "ROWBOAT_GATEWAY_TOKEN", "DATA_API_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  __clearVoiceResidencyModeCache();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __clearVoiceResidencyModeCache();
});

describe("voiceIsVpsReadMode", () => {
  it("is true only for vps, and caches", async () => {
    expect(await voiceIsVpsReadMode(modeDb("vps"), BIZ)).toBe(true);
    // Cached: a bridge handling several calls must not re-ask per call.
    expect(await voiceIsVpsReadMode(modeDb(null, { message: "would re-query" }), BIZ)).toBe(true);
  });

  it("treats dual and everything else as central", async () => {
    for (const mode of ["dual", "supabase", "nonsense", null]) {
      __clearVoiceResidencyModeCache();
      expect(await voiceIsVpsReadMode(modeDb(mode), BIZ)).toBe(false);
    }
  });

  it("fails toward central WITHOUT caching the guess", async () => {
    expect(await voiceIsVpsReadMode(modeDb(null, { message: "pg down" }), BIZ)).toBe(false);
    expect(await voiceIsVpsReadMode(modeDb("vps"), BIZ)).toBe(true);
  });

  it("fails toward central when the client throws", async () => {
    const boom = {
      from: () => {
        throw new Error("boom");
      }
    } as never;
    expect(await voiceIsVpsReadMode(boom, BIZ)).toBe(false);
  });
});

describe("voiceReadMovedRowsOrNull", () => {
  it("reaches the box by Docker DNS, never 127.0.0.1", async () => {
    // Bugbot, PR #1578. The bridge is a CONTAINER: its 127.0.0.1 is itself,
    // and the data API publishes only on the HOST loopback for cloudflared.
    // host.docker.internal is no better, it lands on the docker-bridge IP
    // where nothing listens. That is the May 2026 outage in the bridge's own
    // compose header. Sibling containers must use the shared-network DNS
    // name, exactly as this service already reaches rowboat:3000.
    process.env.ROWBOAT_GATEWAY_TOKEN = "gw-1";
    const fetchImpl = okFetch([{ body: "hi" }]);
    const rows = await voiceReadMovedRowsOrNull(
      { table: "sms_outbound_log", columns: ["body"] },
      { fetchImpl: fetchImpl as never }
    );
    expect(rows).toEqual([{ body: "hi" }]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_DATA_API_BASE_URL}/v1/select`);
    expect(url).toBe("http://data-api:8091/v1/select");
    expect(url).not.toContain("127.0.0.1");
    expect(url).not.toContain("host.docker.internal");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer gw-1");
  });

  it("the data-api and the bridge actually share a network", () => {
    // The DNS name above only resolves if both containers are on
    // rowboat_default. Asserting the code without asserting the topology
    // would be a test that passes while production cannot connect.
    const dataApi = readFileSync(
      join(__dirname, "..", "vps", "data-api", "docker-compose.yml"),
      "utf8"
    );
    const bridge = readFileSync(
      join(__dirname, "..", "vps", "voice-bridge", "docker-compose.yml"),
      "utf8"
    );
    expect(dataApi).toContain("rowboat_default");
    expect(bridge).toContain("rowboat_default");
    // And the service name the DNS entry comes from.
    expect(dataApi).toContain("container_name: data-api");
    // Postgres must NOT be exposed on that shared network. Anchor on the
    // SERVICE definition (two-space indent), not the first mention: the
    // first is inside data-api's own depends_on, and slicing from there
    // captured data-api's networks and failed for the wrong reason.
    const pgStart = dataApi.indexOf("\n  residency-postgres:");
    expect(pgStart, "residency-postgres service block not found").toBeGreaterThan(-1);
    const pgBlock = dataApi.slice(pgStart, dataApi.indexOf("\nnetworks:"));
    expect(pgBlock).not.toContain("rowboat_default");
    expect(pgBlock, "postgres must never publish a host port").not.toContain("ports:");
  });

  it("falls through a BLANK DATA_API_TOKENS to the gateway token", async () => {
    // Bugbot, PR #1578. deploy-client.sh writes a literal `DATA_API_TOKENS=`
    // on every box where the var is unset, and "" is not nullish, so `??`
    // pinned the bearer to the empty string and never consulted the
    // fallback: every read returned null with no error. I introduced that
    // blank line in this same change, so the guard and the hole shipped
    // together.
    process.env.DATA_API_TOKENS = "";
    process.env.ROWBOAT_GATEWAY_TOKEN = "gw-1";
    const fetchImpl = okFetch([]);
    await voiceReadMovedRowsOrNull({ table: "sms_outbound_log" }, { fetchImpl: fetchImpl as never });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer gw-1");
  });

  it("falls through a whitespace-only value too", async () => {
    process.env.DATA_API_TOKENS = "   ";
    process.env.ROWBOAT_GATEWAY_TOKEN = "gw-1";
    const fetchImpl = okFetch([]);
    await voiceReadMovedRowsOrNull({ table: "sms_outbound_log" }, { fetchImpl: fetchImpl as never });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer gw-1");
  });

  it("prefers DATA_API_TOKENS when it is actually set", async () => {
    // deploy-client.sh: DATA_API_TOKENS=${DATA_API_TOKENS:-${ROWBOAT_GATEWAY_TOKEN}}
    process.env.DATA_API_TOKENS = "primary , secondary";
    process.env.ROWBOAT_GATEWAY_TOKEN = "gw-1";
    const fetchImpl = okFetch([]);
    await voiceReadMovedRowsOrNull({ table: "sms_outbound_log" }, { fetchImpl: fetchImpl as never });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer primary");
  });

  it("returns null, not [], with no token on the box", async () => {
    delete process.env.DATA_API_TOKENS;
    delete process.env.ROWBOAT_GATEWAY_TOKEN;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = okFetch([]);
    expect(
      await voiceReadMovedRowsOrNull({ table: "sms_outbound_log" }, { fetchImpl: fetchImpl as never })
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("returns null on ok:false, never an empty history", async () => {
    process.env.ROWBOAT_GATEWAY_TOKEN = "gw-1";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "internal", message: "pg down" }), {
          status: 200
        })
    );
    expect(
      await voiceReadMovedRowsOrNull({ table: "sms_outbound_log" }, { fetchImpl: fetchImpl as never })
    ).toBeNull();
    err.mockRestore();
  });

  it("returns null on a non-2xx and on a transport failure", async () => {
    process.env.ROWBOAT_GATEWAY_TOKEN = "gw-1";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await voiceReadMovedRowsOrNull(
        { table: "sms_outbound_log" },
        { fetchImpl: vi.fn(async () => new Response("no", { status: 500 })) as never }
      )
    ).toBeNull();
    expect(
      await voiceReadMovedRowsOrNull(
        { table: "sms_outbound_log" },
        {
          fetchImpl: vi.fn(async () => {
            throw new Error("ECONNREFUSED");
          }) as never
        }
      )
    ).toBeNull();
    err.mockRestore();
  });

  it("gives up quickly rather than holding a live call", async () => {
    process.env.ROWBOAT_GATEWAY_TOKEN = "gw-1";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const hang = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_r, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    expect(
      await voiceReadMovedRowsOrNull(
        { table: "sms_outbound_log" },
        { fetchImpl: hang as never, timeoutMs: 5 }
      )
    ).toBeNull();
    err.mockRestore();
  });
});

describe("the voice timeline on a residency tenant", () => {
  /** Answers central tables; refuses the two that are purged. */
  function centralOnlyDb(mode: string) {
    const seen: string[] = [];
    const build = (table: string): Record<string, unknown> => {
      seen.push(table);
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "is", "in", "or", "gte", "order", "limit"]) {
        b[m] = () => b;
      }
      b["maybeSingle"] = () =>
        Promise.resolve(
          table === "businesses"
            ? { data: { data_residency_mode: mode }, error: null }
            : { data: null, error: null }
        );
      b["then"] = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: [],
          error:
            table === "sms_outbound_log" || table === "voice_call_transcripts"
              ? { message: "central must not be read for a vps tenant" }
              : null
        }).then(resolve);
      return b;
    };
    return { db: { from: (t: string) => build(t) } as never, seen };
  }

  it("reads the caller's history from the box and never from central", async () => {
    process.env.ROWBOAT_GATEWAY_TOKEN = "gw-1";
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      const req = JSON.parse(init.body as string) as { table: string };
      const rows =
        req.table === "sms_outbound_log"
          ? [{ created_at: "2026-07-14T17:09:03Z", body: "When does your policy renew?" }]
          : [
              {
                started_at: "2026-07-14T16:00:00Z",
                created_at: "2026-07-14T16:00:00Z",
                direction: "inbound",
                summary: "Asked about renewal timing.",
                status: "completed"
              }
            ];
      return new Response(JSON.stringify({ ok: true, rows }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const { db, seen } = centralOnlyDb("vps");

    const text = await loadVoiceContactTimeline(db, BIZ, CALLER);

    expect(text).toContain("When does your policy renew?");
    expect(text).toContain("Asked about renewal timing.");
    const askedBox = fetchImpl.mock.calls.map(
      (c) => JSON.parse((c[1] as RequestInit).body as string).table
    );
    expect(askedBox).toEqual(["sms_outbound_log", "voice_call_transcripts"]);
    // Identity stays central; the purged tables never do.
    expect(seen).toContain("contacts");
    expect(seen).not.toContain("sms_outbound_log");
    expect(seen).not.toContain("voice_call_transcripts");
    vi.unstubAllGlobals();
  });

  it("a dead datastore costs the history, not the call", async () => {
    process.env.ROWBOAT_GATEWAY_TOKEN = "gw-1";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );
    const { db } = centralOnlyDb("vps");
    // Null timeline, not a thrown error: the receptionist greets the caller
    // with no history rather than the call failing.
    await expect(loadVoiceContactTimeline(db, BIZ, CALLER)).resolves.toBeNull();
    err.mockRestore();
    vi.unstubAllGlobals();
  });
});
