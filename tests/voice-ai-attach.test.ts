import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachAiStream,
  resolveBridgeTarget,
  type VoiceAiAttachDeps
} from "../supabase/functions/_shared/voice_ai_attach";

/**
 * The two halves of attaching the Gemini bridge to an answered leg, shared by
 * the AI takeover (telnyx-voice-call-end) and AI-first answering
 * (telnyx-voice-inbound). Every resolveBridgeTarget guard is a FAIL-CLOSED
 * decision: returning a target when the bridge is unreachable would connect a
 * live person to silence, so each one is pinned here.
 */

const BUSINESS = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const DID = "+16023131823";

type Row = Record<string, unknown> | null;

/** Structural Supabase stand-in: one canned row per table, plus insert capture. */
function fakeDb(rows: { routes?: Row; settings?: Row }, insertError?: { message: string }) {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: table === "telnyx_voice_routes" ? (rows.routes ?? null) : (rows.settings ?? null),
                error: null
              })
          })
        }),
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          return Promise.resolve({ error: insertError ?? null });
        }
      };
    }
  };
  return { db: db as unknown as VoiceAiAttachDeps["supabase"], inserted };
}

const freshHeartbeat = () => new Date().toISOString();

function deps(
  rows: { routes?: Row; settings?: Row },
  overrides: Partial<VoiceAiAttachDeps> = {},
  insertError?: { message: string }
): { deps: VoiceAiAttachDeps; inserted: Array<Record<string, unknown>> } {
  const { db, inserted } = fakeDb(rows, insertError);
  return {
    deps: {
      supabase: db,
      apiKey: "telnyx-key",
      streamSecret: "signing-secret",
      defaultBridgeOrigin: "https://fallback.example",
      ...overrides
    },
    inserted
  };
}

const envGet = vi.fn<(key: string) => string | undefined>();

beforeEach(() => {
  envGet.mockReset();
  envGet.mockReturnValue(undefined);
  vi.stubGlobal("Deno", { env: { get: envGet } });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveBridgeTarget", () => {
  it("prefers the route's origin and path over the tenant's and the env fallback", async () => {
    const { deps: d } = deps({
      routes: { media_wss_origin: "https://route.example", media_path: "voice/custom" },
      settings: {
        bridge_last_heartbeat_at: freshHeartbeat(),
        bridge_media_wss_origin: "https://tenant.example",
        bridge_media_path: "/tenant"
      }
    });
    expect(await resolveBridgeTarget(d, BUSINESS, DID)).toEqual({
      origin: "https://route.example",
      // A path without a leading slash is normalized to one.
      path: "/voice/custom",
      translatorArmed: false
    });
  });

  it("falls back to the tenant's origin, then to the env default", async () => {
    const withTenant = deps({
      routes: null,
      settings: {
        bridge_last_heartbeat_at: freshHeartbeat(),
        bridge_media_wss_origin: "https://tenant.example"
      }
    });
    expect((await resolveBridgeTarget(withTenant.deps, BUSINESS, DID))?.origin).toBe(
      "https://tenant.example"
    );
    const envOnly = deps({
      routes: null,
      settings: { bridge_last_heartbeat_at: freshHeartbeat() }
    });
    const target = await resolveBridgeTarget(envOnly.deps, BUSINESS, DID);
    expect(target?.origin).toBe("https://fallback.example");
    // And the default media path when neither side configured one.
    expect(target?.path).toBe("/voice/stream");
  });

  it("reports translator mode so the stream can be armed for both legs", async () => {
    const { deps: d } = deps({
      settings: { bridge_last_heartbeat_at: freshHeartbeat(), translator_mode_enabled: true }
    });
    expect((await resolveBridgeTarget(d, BUSINESS, DID))?.translatorArmed).toBe(true);
  });

  it("returns null when AI streaming is switched off by the kill switch", async () => {
    for (const off of ["false", "0", "no", "FALSE"]) {
      envGet.mockImplementation((k) => (k === "VOICE_AI_STREAM_ENABLED" ? off : undefined));
      const { deps: d } = deps({ settings: { bridge_last_heartbeat_at: freshHeartbeat() } });
      expect(await resolveBridgeTarget(d, BUSINESS, DID)).toBeNull();
    }
    // Any other value (or absence) leaves streaming enabled.
    envGet.mockImplementation((k) => (k === "VOICE_AI_STREAM_ENABLED" ? "true" : undefined));
    const { deps: on } = deps({ settings: { bridge_last_heartbeat_at: freshHeartbeat() } });
    expect(await resolveBridgeTarget(on, BUSINESS, DID)).not.toBeNull();
  });

  it("returns null without the stream signing secret, before any DTMF is sent", async () => {
    // A missing secret mints an unsigned URL: streaming_start still returns 200
    // but the bridge rejects the socket, leaving a connected person in silence.
    const { deps: d } = deps(
      { settings: { bridge_last_heartbeat_at: freshHeartbeat() } },
      { streamSecret: "" }
    );
    expect(await resolveBridgeTarget(d, BUSINESS, DID)).toBeNull();
  });

  it("returns null when the bridge heartbeat is stale or missing", async () => {
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    for (const beat of [stale, null, undefined]) {
      const { deps: d } = deps({ settings: { bridge_last_heartbeat_at: beat } });
      expect(await resolveBridgeTarget(d, BUSINESS, DID)).toBeNull();
    }
    // No settings row at all reads as no heartbeat.
    const { deps: none } = deps({ settings: null });
    expect(await resolveBridgeTarget(none, BUSINESS, DID)).toBeNull();
  });

  it("honors a configured heartbeat TTL and ignores an absurd one", async () => {
    const beat = new Date(Date.now() - 200_000).toISOString();
    envGet.mockImplementation((k) => (k === "BRIDGE_HEARTBEAT_TTL_SEC" ? "600" : undefined));
    const generous = deps({ settings: { bridge_last_heartbeat_at: beat } });
    expect(await resolveBridgeTarget(generous.deps, BUSINESS, DID)).not.toBeNull();
    // Below the 60s floor (or unparseable) falls back to the 150s default, which
    // this heartbeat is older than.
    for (const ttl of ["5", "nonsense"]) {
      envGet.mockImplementation((k) => (k === "BRIDGE_HEARTBEAT_TTL_SEC" ? ttl : undefined));
      const strict = deps({ settings: { bridge_last_heartbeat_at: beat } });
      expect(await resolveBridgeTarget(strict.deps, BUSINESS, DID)).toBeNull();
    }
  });

  it("returns null when no origin is configured anywhere", async () => {
    const { deps: d } = deps(
      { settings: { bridge_last_heartbeat_at: freshHeartbeat() } },
      { defaultBridgeOrigin: "" }
    );
    expect(await resolveBridgeTarget(d, BUSINESS, DID)).toBeNull();
  });

  it("normalizes a blank or trailing-slash media path", async () => {
    for (const [configured, expected] of [
      ["   ", "/voice/stream"],
      ["/custom/", "/custom"],
      ["/ok", "/ok"]
    ] as const) {
      const { deps: d } = deps({
        settings: { bridge_last_heartbeat_at: freshHeartbeat(), bridge_media_path: configured }
      });
      expect((await resolveBridgeTarget(d, BUSINESS, DID))?.path).toBe(expected);
    }
  });
});

describe("attachAiStream", () => {
  const target = { origin: "https://bridge.example", path: "/voice/stream" };

  it("signs a v2 stream URL, records its nonce, and starts the stream", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(JSON.stringify({ seen: String(init?.body ?? "") }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { deps: d, inserted } = deps({});
    const ok = await attachAiStream(d, {
      businessId: BUSINESS,
      callControlId: "v3:call-1",
      toE164: DID,
      fromE164: "+14159851909",
      ...target
    });
    expect(ok).toBe(true);
    // The nonce is single-use, so it has to be persisted before the bridge can
    // redeem it.
    expect(inserted).toHaveLength(1);
    expect(String(inserted[0].nonce)).toMatch(/^[0-9a-f]{32}$/);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"));
    const streamUrl = String(body.stream_url);
    // https becomes wss, and the signed payload rides the query string.
    expect(streamUrl.startsWith("wss://bridge.example/voice/stream?")).toBe(true);
    const qs = new URLSearchParams(streamUrl.split("?")[1]);
    expect(qs.get("v")).toBe("2");
    expect(qs.get("business_id")).toBe(BUSINESS);
    expect(qs.get("call_control_id")).toBe("v3:call-1");
    expect(qs.get("from_e164_info")).toBe("+14159851909");
    expect(qs.get("mac")).toBeTruthy();
    // Not a translator call, so the stream is not forked to both legs.
    expect(body.stream_bidirectional_target_legs).toBeUndefined();
  });

  it("arms both legs when translator mode is on", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(JSON.stringify({ seen: String(init?.body ?? "") }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { deps: d } = deps({});
    await attachAiStream(d, {
      businessId: BUSINESS,
      callControlId: "v3:call-2",
      toE164: DID,
      fromE164: "+14159851909",
      translatorArmed: true,
      ...target
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"));
    expect(body.stream_bidirectional_target_legs).toBe("both");
  });

  it("omits the caller hint when the number is withheld", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(JSON.stringify({ seen: String(init?.body ?? "") }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { deps: d } = deps({});
    await attachAiStream(d, {
      businessId: BUSINESS,
      callControlId: "v3:call-3",
      toE164: DID,
      fromE164: "",
      ...target
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"));
    expect(String(body.stream_url)).not.toContain("from_e164_info");
  });

  it("trims a trailing slash off the origin", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(JSON.stringify({ seen: String(init?.body ?? "") }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { deps: d } = deps({});
    await attachAiStream(d, {
      businessId: BUSINESS,
      callControlId: "v3:call-4",
      toE164: DID,
      fromE164: "+1",
      origin: "http://bridge.example/",
      path: "/voice/stream"
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"));
    // http downgrades to ws (dev origins), and there is no double slash.
    expect(String(body.stream_url).startsWith("ws://bridge.example/voice/stream?")).toBe(true);
  });

  it("returns false without calling Telnyx when the nonce cannot be stored", async () => {
    // An unstored nonce would be rejected at redemption, so the stream must not
    // be started at all.
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(JSON.stringify({ seen: String(init?.body ?? "") }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { deps: d } = deps({}, {}, { message: "duplicate key" });
    const ok = await attachAiStream(d, {
      businessId: BUSINESS,
      callControlId: "v3:call-5",
      toE164: DID,
      fromE164: "+1",
      ...target
    });
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false when Telnyx refuses the stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no such call", { status: 422 }))
    );
    const { deps: d } = deps({});
    const ok = await attachAiStream(d, {
      businessId: BUSINESS,
      callControlId: "v3:call-6",
      toE164: DID,
      fromE164: "+1",
      label: "ai-first",
      ...target
    });
    expect(ok).toBe(false);
  });
});
