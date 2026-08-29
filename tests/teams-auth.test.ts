import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSign, generateKeyPairSync, createPublicKey } from "node:crypto";

/**
 * Bot Framework inbound authentication.
 *
 * This is the only thing between the public internet and "a message from
 * your team", so the tests below are written as attacks rather than as
 * happy paths. Every one of them is a token that is valid in some respect
 * and must still be refused:
 *
 *   - correctly signed, but by the wrong key
 *   - correctly signed by the right key, for a DIFFERENT bot
 *   - correctly signed, from a different issuer
 *   - correctly signed, but expired
 *   - a header claiming `alg: none`, which is the classic bypass
 *
 * The tokens here are signed with a real RSA key pair and verified through
 * the real `node:crypto` path; only the JWKS fetch is stubbed. A test that
 * mocked the verification itself would prove nothing.
 */

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { verifyTeamsToken, resetTeamsJwksStateForTests } from "@/lib/teams/auth";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const NOW = Date.parse("2026-08-29T12:00:00Z");

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwkFor(key: ReturnType<typeof createPublicKey>, kid: string) {
  return { ...(key.export({ format: "jwk" }) as object), kid, use: "sig", alg: "RS256" };
}

const b64 = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64url");

function sign(
  payload: Record<string, unknown>,
  opts: { kid?: string; alg?: string; key?: typeof privateKey } = {}
) {
  const header = { alg: opts.alg ?? "RS256", kid: opts.kid ?? "key-1", typ: "JWT" };
  const signing = `${b64(header)}.${b64(payload)}`;
  if ((opts.alg ?? "RS256") === "none") return `${signing}.`;
  const signature = createSign("RSA-SHA256")
    .update(signing)
    .sign(opts.key ?? privateKey)
    .toString("base64url");
  return `${signing}.${signature}`;
}

const goodPayload = {
  iss: "https://api.botframework.com",
  aud: APP_ID,
  exp: Math.floor(NOW / 1000) + 600,
  tid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
};

const verify = (token: string, now = NOW) =>
  verifyTeamsToken(`Bearer ${token}`, { appId: APP_ID, now });

/** Serve a JWKS over the network, which is how production gets one. */
function serveKeys(keys: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("openidconfiguration")
        ? new Response(JSON.stringify({ jwks_uri: "https://login.botframework.com/keys" }))
        : new Response(JSON.stringify({ keys }))
    )
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetTeamsJwksStateForTests();
  serveKeys([jwkFor(publicKey, "key-1")]);
});

afterEach(() => resetTeamsJwksStateForTests());

describe("a token that should be accepted", () => {
  it("uses the real clock when the caller supplies none", async () => {
    const live = { ...goodPayload, exp: Math.floor(Date.now() / 1000) + 600 };
    expect(
      await verifyTeamsToken(`Bearer ${sign(live)}`, { appId: APP_ID })
    ).toMatchObject({ ok: true });
  });

  it("verifies signature, issuer, audience and expiry, and reports the tenant", async () => {
    const out = await verify(sign(goodPayload));
    expect(out).toEqual({
      ok: true,
      claims: { tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", audience: APP_ID }
    });
  });

  it("reports a null tenant rather than inventing one", async () => {
    const { tid: _tid, ...noTenant } = goodPayload;
    const out = await verify(sign(noTenant));
    expect(out).toMatchObject({ ok: true, claims: { tenantId: null } });
  });
});

describe("tokens that are valid in some respect and must still be refused", () => {
  it("refuses one signed by a key that is not in the JWKS", async () => {
    const out = await verify(sign(goodPayload, { key: other.privateKey }));
    expect(out).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses one whose kid names a key we do not have", async () => {
    expect(await verify(sign(goodPayload, { kid: "key-99" }))).toEqual({
      ok: false,
      reason: "unknown_key"
    });
  });

  it("refuses a VALID token addressed to a different bot", async () => {
    // The audience check is what stops a token minted for somebody else's
    // Azure app being replayed into ours.
    const out = await verify(sign({ ...goodPayload, aud: "someone-elses-app-id" }));
    expect(out).toEqual({ ok: false, reason: "unexpected_audience" });
  });

  it("refuses a token from another Microsoft-signed issuer", async () => {
    const out = await verify(sign({ ...goodPayload, iss: "https://sts.windows.net/x/" }));
    expect(out).toEqual({ ok: false, reason: "unexpected_issuer" });
  });

  it("refuses an expired token, allowing only a small clock skew", async () => {
    const expired = { ...goodPayload, exp: Math.floor(NOW / 1000) - 600 };
    expect(await verify(sign(expired))).toEqual({ ok: false, reason: "expired" });

    // Just inside the skew window is still accepted.
    const justExpired = { ...goodPayload, exp: Math.floor(NOW / 1000) - 60 };
    expect(await verify(sign(justExpired))).toMatchObject({ ok: true });
  });

  it("refuses a token with no expiry at all", async () => {
    const { exp: _exp, ...noExp } = goodPayload;
    expect(await verify(sign(noExp))).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses alg:none, the classic bypass", async () => {
    // The algorithm is PINNED rather than read from the token. Trusting the
    // header's own choice is how `none` and HMAC-confusion attacks work.
    expect(await verify(sign(goodPayload, { alg: "none" }))).toEqual({
      ok: false,
      reason: "unexpected_alg"
    });
  });

  it("refuses an HS256 header even with an otherwise valid body", async () => {
    expect(await verify(sign(goodPayload, { alg: "HS256" }))).toEqual({
      ok: false,
      reason: "unexpected_alg"
    });
  });
});

describe("malformed input", () => {
  it.each([
    ["no header at all", null, "malformed_header"],
    ["a bare token with no scheme", "abc.def.ghi", "malformed_header"],
    ["the wrong scheme", "Basic abcdef", "malformed_header"],
    ["Bearer with nothing after it", "Bearer ", "malformed_header"]
  ])("refuses %s", async (_label, header, reason) => {
    expect(await verifyTeamsToken(header, { appId: APP_ID, now: NOW })).toEqual({
      ok: false,
      reason
    });
  });

  it("refuses a token that is not three parts", async () => {
    expect(await verify("only.two")).toEqual({ ok: false, reason: "malformed_token" });
  });

  it("refuses a token whose parts are not JSON", async () => {
    expect(await verify("bm90anNvbg.bm90anNvbg.sig")).toEqual({
      ok: false,
      reason: "unparseable_token"
    });
  });

  it("falls back to the configured app id when the caller names none", async () => {
    process.env.MICROSOFT_APP_ID = APP_ID;
    try {
      expect(await verifyTeamsToken(`Bearer ${sign(goodPayload)}`, { now: NOW })).toMatchObject({
        ok: true
      });
    } finally {
      delete process.env.MICROSOFT_APP_ID;
    }
  });

  it("refuses a token whose audience claim is missing entirely", async () => {
    const { aud: _aud, ...noAud } = goodPayload;
    expect(await verify(sign(noAud))).toEqual({ ok: false, reason: "unexpected_audience" });
  });

  it("refuses a key that is in the set but is not usable RSA material", async () => {
    // A malformed JWK makes createPublicKey throw; that is a bad signature
    // as far as the caller is concerned, not a 500.
    // No modulus or exponent at all: createPublicKey throws, and that is a
    // bad signature from the caller's point of view, not a 500.
    resetTeamsJwksStateForTests();
    serveKeys([{ kid: "key-1", kty: "RSA" }]);
    expect(await verify(sign(goodPayload))).toEqual({ ok: false, reason: "bad_signature" });
  });

  it.each([
    ["explicitly empty", { appId: "", now: NOW }],
    // Neither argument nor environment: the `?? ""` fallback, which is the
    // one that decides what happens on a misconfigured deployment.
    ["absent from both the call and the environment", { now: NOW }]
  ])("refuses everything when our own app id is %s", async (_label, opts) => {
    // Fails CLOSED. An empty expected audience must never mean "match any".
    const saved = process.env.MICROSOFT_APP_ID;
    delete process.env.MICROSOFT_APP_ID;
    try {
      expect(await verifyTeamsToken(`Bearer ${sign(goodPayload)}`, opts)).toEqual({
        ok: false,
        reason: "app_id_unconfigured"
      });
    } finally {
      if (saved !== undefined) process.env.MICROSOFT_APP_ID = saved;
    }
  });
});

describe("fetching the signing keys", () => {
  it("fetches the JWKS through the OpenID metadata document, then caches it", async () => {
    resetTeamsJwksStateForTests();
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("openidconfiguration")
        ? new Response(JSON.stringify({ jwks_uri: "https://login.botframework.com/keys" }))
        : new Response(JSON.stringify({ keys: [jwkFor(publicKey, "key-1")] }))
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await verify(sign(goodPayload))).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Second verification inside the TTL must not go back to the network.
    expect(await verify(sign(goodPayload))).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-fetches ONCE when a kid is not in the cached set, then accepts", async () => {
    /**
     * A key rotation must not take the channel dark for a day.
     *
     * The cache holds Microsoft's keys for 24 hours. When they rotate,
     * every activity arrives signed by a kid that is not in it. Answering
     * 401 makes Bot Framework stop retrying, so those messages are not
     * delayed, they are LOST, and the tenant sees a coworker that simply
     * stopped replying until the cache happened to expire.
     */
    resetTeamsJwksStateForTests();
    let served = [jwkFor(publicKey, "key-1")];
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("openidconfiguration")
        ? new Response(JSON.stringify({ jwks_uri: "https://login.botframework.com/keys" }))
        : new Response(JSON.stringify({ keys: served }))
    );
    vi.stubGlobal("fetch", fetchMock);

    // Warm the cache on the old key.
    expect(await verify(sign(goodPayload))).toMatchObject({ ok: true });
    const afterWarm = fetchMock.mock.calls.length;

    // Microsoft rotates. Same token shape, a kid we have never seen.
    served = [jwkFor(other.publicKey, "key-2")];
    expect(
      await verify(sign(goodPayload, { kid: "key-2", key: other.privateKey }))
    ).toMatchObject({ ok: true });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterWarm);
  });

  it("spends ONE refresh on a flood of forged kids, not one each", async () => {
    /**
     * The other half of the same behaviour, and the reason the refresh is
     * throttled rather than merely allowed.
     *
     * Our Microsoft app id is public, so anyone can mint a syntactically
     * valid token with the right issuer, audience and expiry. If an unknown
     * kid always bought a fetch, varying the kid would turn our webhook
     * into an amplifier against Microsoft's own key endpoint, one request
     * in, one fetch out, forever.
     */
    resetTeamsJwksStateForTests();
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("openidconfiguration")
        ? new Response(JSON.stringify({ jwks_uri: "https://login.botframework.com/keys" }))
        : new Response(JSON.stringify({ keys: [jwkFor(publicKey, "key-1")] }))
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await verify(sign(goodPayload))).toMatchObject({ ok: true });
    const afterWarm = fetchMock.mock.calls.length;

    for (let i = 0; i < 25; i++) {
      expect(await verify(sign(goodPayload, { kid: `forged-${i}` }))).toEqual({
        ok: false,
        reason: "unknown_key"
      });
    }
    // Two calls total across all 25: the metadata document and the key set,
    // once. Not fifty.
    expect(fetchMock.mock.calls.length - afterWarm).toBe(2);
  });

  it("lets the next rotation through once the cooldown has passed", async () => {
    // The throttle must not become the outage it was added to prevent. A
    // rotation that lands just after somebody sent a forged kid still
    // recovers within the cooldown, not at the 24-hour cache expiry.
    resetTeamsJwksStateForTests();
    let served = [jwkFor(publicKey, "key-1")];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("openidconfiguration")
          ? new Response(JSON.stringify({ jwks_uri: "https://login.botframework.com/keys" }))
          : new Response(JSON.stringify({ keys: served }))
      )
    );
    expect(await verify(sign(goodPayload))).toMatchObject({ ok: true });
    // Somebody spends the window on garbage.
    expect(await verify(sign(goodPayload, { kid: "forged" }))).toMatchObject({ ok: false });

    served = [jwkFor(other.publicKey, "key-2")];
    const rotated = { ...goodPayload, exp: Math.floor(NOW / 1000) + 3600 };
    const token = sign(rotated, { kid: "key-2", key: other.privateKey });

    // Inside the window the real rotation is still refused, which is the
    // price of the throttle and is stated here so it cannot be a surprise.
    expect(await verify(token)).toEqual({ ok: false, reason: "unknown_key" });
    // Past it, recovery. Six minutes, against a 5 minute cooldown.
    expect(await verify(token, NOW + 6 * 60 * 1000)).toMatchObject({ ok: true });
  });

  it("reports the refresh failing as OURS, so Microsoft redelivers", async () => {
    // A 401 here would look like a rejected activity and never come back.
    resetTeamsJwksStateForTests();
    let healthy = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!healthy) return new Response("nope", { status: 503 });
        return url.includes("openidconfiguration")
          ? new Response(JSON.stringify({ jwks_uri: "https://login.botframework.com/keys" }))
          : new Response(JSON.stringify({ keys: [jwkFor(publicKey, "key-1")] }));
      })
    );
    expect(await verify(sign(goodPayload))).toMatchObject({ ok: true });
    healthy = false;
    expect(await verify(sign(goodPayload, { kid: "key-99" }))).toEqual({
      ok: false,
      reason: "jwks_unavailable"
    });
  });

  it("does not hammer a key endpoint that is DOWN, either", async () => {
    // Why the cooldown stamp is taken before the attempt rather than after
    // a success. Stamped on success only, a failing endpoint is retried on
    // every request, which is the worst moment to add load to it.
    resetTeamsJwksStateForTests();
    let healthy = true;
    const fetchMock = vi.fn(async (url: string) => {
      if (!healthy) return new Response("nope", { status: 503 });
      return url.includes("openidconfiguration")
        ? new Response(JSON.stringify({ jwks_uri: "https://login.botframework.com/keys" }))
        : new Response(JSON.stringify({ keys: [jwkFor(publicKey, "key-1")] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await verify(sign(goodPayload))).toMatchObject({ ok: true });
    healthy = false;
    const afterWarm = fetchMock.mock.calls.length;
    for (let i = 0; i < 20; i++) {
      // And every one of them is reported as OURS, not as a bad token. See
      // the dedicated test below for why that distinction is the whole
      // difference between a delayed message and a lost one.
      expect(await verify(sign(goodPayload, { kid: `forged-${i}` }))).toEqual({
        ok: false,
        reason: "jwks_unavailable"
      });
    }
    // One attempt at the metadata document, which failed. Not twenty.
    expect(fetchMock.mock.calls.length - afterWarm).toBe(1);
  });

  it("keeps reporting a FAILED refresh as ours for the rest of the window", async () => {
    /**
     * The throttle must not convert an outage into lost messages.
     *
     * Once a forced refresh has failed, we do not know whether the next
     * unknown kid is a real rotation or garbage, and the two answers are
     * not equally safe. `unknown_key` becomes a 401, which makes Bot
     * Framework stop retrying and DROPS the activity. `jwks_unavailable`
     * becomes a 500, and it comes back once Microsoft recovers.
     *
     * So a rotation that lands during a key-endpoint outage costs a
     * redelivery rather than a message.
     */
    resetTeamsJwksStateForTests();
    let healthy = true;
    let served = [jwkFor(publicKey, "key-1")];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!healthy) return new Response("nope", { status: 503 });
        return url.includes("openidconfiguration")
          ? new Response(JSON.stringify({ jwks_uri: "https://login.botframework.com/keys" }))
          : new Response(JSON.stringify({ keys: served }));
      })
    );
    expect(await verify(sign(goodPayload))).toMatchObject({ ok: true });

    // Microsoft rotates and its key endpoint is down at the same moment.
    healthy = false;
    served = [jwkFor(other.publicKey, "key-2")];
    const rotated = sign(
      { ...goodPayload, exp: Math.floor(NOW / 1000) + 7200 },
      { kid: "key-2", key: other.privateKey }
    );
    expect(await verify(rotated)).toEqual({ ok: false, reason: "jwks_unavailable" });
    // Throttled, so no second fetch, and still reported as ours rather
    // than as a bad token.
    expect(await verify(rotated, NOW + 60_000)).toEqual({
      ok: false,
      reason: "jwks_unavailable"
    });

    // Microsoft recovers, and the next window picks the new key up.
    healthy = true;
    expect(await verify(rotated, NOW + 6 * 60 * 1000)).toMatchObject({ ok: true });
  });

  it("survives the refresh throwing something that is not an Error", async () => {
    resetTeamsJwksStateForTests();
    let healthy = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!healthy) throw "network gone";
        return url.includes("openidconfiguration")
          ? new Response(JSON.stringify({ jwks_uri: "https://login.botframework.com/keys" }))
          : new Response(JSON.stringify({ keys: [jwkFor(publicKey, "key-1")] }));
      })
    );
    expect(await verify(sign(goodPayload))).toMatchObject({ ok: true });
    healthy = false;
    expect(await verify(sign(goodPayload, { kid: "key-99" }))).toEqual({
      ok: false,
      reason: "jwks_unavailable"
    });
  });

  it.each([
    [
      "the metadata document is down",
      vi.fn(async () => new Response("nope", { status: 503 }))
    ],
    [
      "the metadata names no jwks_uri",
      vi.fn(async () => new Response(JSON.stringify({})))
    ],
    [
      "the key endpoint is down",
      vi.fn(async (url: string) =>
        url.includes("openidconfiguration")
          ? new Response(JSON.stringify({ jwks_uri: "https://login.botframework.com/keys" }))
          : new Response("nope", { status: 500 })
      )
    ],
    [
      "the key endpoint returns no keys array at all",
      vi.fn(async (url: string) =>
        url.includes("openidconfiguration")
          ? new Response(JSON.stringify({ jwks_uri: "https://login.botframework.com/keys" }))
          : new Response(JSON.stringify({}))
      )
    ],
    [
      "the fetch throws something that is not an Error",
      vi.fn(async () => {
        throw "network gone";
      })
    ],
    [
      "the key set is empty",
      vi.fn(async (url: string) =>
        url.includes("openidconfiguration")
          ? new Response(JSON.stringify({ jwks_uri: "https://login.botframework.com/keys" }))
          : new Response(JSON.stringify({ keys: [] }))
      )
    ]
  ])("reports a DISTINCT reason when %s", async (_label, fetchMock) => {
    // Distinct because it is OUR failure, not the caller's: the route
    // answers 500 so Microsoft redelivers, where a 401 would look like a
    // rejected activity and never come back.
    resetTeamsJwksStateForTests();
    vi.stubGlobal("fetch", fetchMock as never);
    expect(await verify(sign(goodPayload))).toEqual({ ok: false, reason: "jwks_unavailable" });
  });
});
