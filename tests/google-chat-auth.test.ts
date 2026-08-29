import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSign, generateKeyPairSync, createPublicKey } from "node:crypto";

/**
 * Google Chat inbound authentication.
 *
 * This is the only thing between the public internet and "a message from
 * your team", so the tests below are written as attacks rather than as
 * happy paths. Every one of them is a token that is valid in some respect
 * and must still be refused.
 *
 * The mechanics are shared with Teams and are tested exhaustively in
 * tests/teams-auth.test.ts. What is proved HERE is the part that is Google
 * Chat and that a shared test cannot reach: this provider's issuer, its
 * directly-served key set (no OpenID discovery document, unlike Microsoft),
 * and the audience being our Chat app's own configured audience.
 *
 * The tokens are signed with a real RSA key pair and verified through the
 * real `node:crypto` path; only the key fetch is stubbed. A test that
 * mocked the verification itself would prove nothing.
 */

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { verifyGoogleChatToken } from "@/lib/google-chat/auth";
// The shared reset, not a per-channel wrapper: one cache holds every
// provider, so clearing it is one function and a Google-Chat-shaped alias
// for it would be an export with no production caller.
import { resetWebhookJwksStateForTests as resetGoogleChatJwksStateForTests } from "@/lib/webhook-auth/jwks";

const AUDIENCE = "123456789012";
const ISSUER = "chat@system.gserviceaccount.com";
const NOW = Date.parse("2026-08-29T12:00:00Z");

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwkFor(key: ReturnType<typeof createPublicKey>, kid: string) {
  return { ...(key.export({ format: "jwk" }) as object), kid, use: "sig", alg: "RS256" };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

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

const goodPayload = { iss: ISSUER, aud: AUDIENCE, exp: Math.floor(NOW / 1000) + 600 };

const verify = (token: string, now = NOW) =>
  verifyGoogleChatToken(`Bearer ${token}`, { audience: AUDIENCE, now });

/** Serve a key set, which is how production gets one. */
function serveKeys(keys: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys }))));
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetGoogleChatJwksStateForTests();
  serveKeys([jwkFor(publicKey, "key-1")]);
});

afterEach(() => resetGoogleChatJwksStateForTests());

describe("a token that should be accepted", () => {
  it("verifies signature, issuer, audience and expiry", async () => {
    expect(await verify(sign(goodPayload))).toEqual({ ok: true, audience: AUDIENCE });
  });

  it("uses the real clock when the caller supplies none", async () => {
    const live = { ...goodPayload, exp: Math.floor(Date.now() / 1000) + 600 };
    expect(
      await verifyGoogleChatToken(`Bearer ${sign(live)}`, { audience: AUDIENCE })
    ).toMatchObject({ ok: true });
  });

  it("fetches the key set DIRECTLY, with no discovery document", async () => {
    // The one structural difference from Teams. Google publishes the Chat
    // service account's keys at a fixed URL; Microsoft names its key
    // endpoint inside an OpenID metadata document. One fetch, not two.
    resetGoogleChatJwksStateForTests();
    const fetchMock = vi.fn(async (url: string) => {
      void url;
      return new Response(JSON.stringify({ keys: [jwkFor(publicKey, "key-1")] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await verify(sign(goodPayload))).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `https://www.googleapis.com/service_accounts/v1/jwk/${ISSUER}`
    );

    // Second verification inside the TTL must not go back to the network.
    expect(await verify(sign(goodPayload))).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("tokens that are valid in some respect and must still be refused", () => {
  it("refuses one signed by a key that is not in the set", async () => {
    expect(await verify(sign(goodPayload, { key: other.privateKey }))).toEqual({
      ok: false,
      reason: "bad_signature"
    });
  });

  it("refuses a VALID token addressed to a different Chat app", async () => {
    // The audience check. Every Chat app in the world receives tokens from
    // this same issuer signed by these same keys, so without it any of them
    // could be replayed at our webhook.
    expect(await verify(sign({ ...goodPayload, aud: "999888777666" }))).toEqual({
      ok: false,
      reason: "unexpected_audience"
    });
  });

  it("refuses a token from another Google service account", async () => {
    // Google signs for a great many issuers. Only Chat's own may speak here.
    expect(
      await verify(sign({ ...goodPayload, iss: "someone-else@system.gserviceaccount.com" }))
    ).toEqual({ ok: false, reason: "unexpected_issuer" });
  });

  it("refuses an expired token, allowing only a small clock skew", async () => {
    expect(await verify(sign({ ...goodPayload, exp: Math.floor(NOW / 1000) - 600 }))).toEqual({
      ok: false,
      reason: "expired"
    });
    expect(
      await verify(sign({ ...goodPayload, exp: Math.floor(NOW / 1000) - 60 }))
    ).toMatchObject({ ok: true });
  });

  it("refuses alg:none, the classic bypass", async () => {
    expect(await verify(sign(goodPayload, { alg: "none" }))).toEqual({
      ok: false,
      reason: "unexpected_alg"
    });
  });

  it("refuses a kid we do not have, once the refresh has been spent", async () => {
    expect(await verify(sign(goodPayload, { kid: "key-99" }))).toEqual({
      ok: false,
      reason: "unknown_key"
    });
  });

  it.each([
    ["no header at all", null],
    ["the wrong scheme", "Basic abcdef"],
    ["Bearer with nothing after it", "Bearer "]
  ])("refuses %s", async (_label, header) => {
    expect(
      await verifyGoogleChatToken(header, { audience: AUDIENCE, now: NOW })
    ).toMatchObject({ ok: false, reason: "malformed_header" });
  });
});

describe("configuration", () => {
  it("falls back to the configured audience when the caller names none", async () => {
    process.env.GOOGLE_CHAT_AUDIENCE = AUDIENCE;
    try {
      expect(
        await verifyGoogleChatToken(`Bearer ${sign(goodPayload)}`, { now: NOW })
      ).toMatchObject({ ok: true });
    } finally {
      delete process.env.GOOGLE_CHAT_AUDIENCE;
    }
  });

  it.each([
    ["explicitly empty", { audience: "", now: NOW }],
    // Neither argument nor environment: the fallback that decides what
    // happens on a misconfigured deployment.
    ["absent from both the call and the environment", { now: NOW }]
  ])("refuses everything when our audience is %s", async (_label, opts) => {
    // Fails CLOSED, and with a reason that names THIS channel's missing
    // variable rather than the shared one, because an operator reading the
    // log needs to know which env var to go and set.
    const saved = process.env.GOOGLE_CHAT_AUDIENCE;
    delete process.env.GOOGLE_CHAT_AUDIENCE;
    try {
      expect(await verifyGoogleChatToken(`Bearer ${sign(goodPayload)}`, opts)).toEqual({
        ok: false,
        reason: "audience_unconfigured"
      });
    } finally {
      if (saved !== undefined) process.env.GOOGLE_CHAT_AUDIENCE = saved;
    }
  });

  it("reports a key-fetch failure as OURS, so Google redelivers", async () => {
    resetGoogleChatJwksStateForTests();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    expect(await verify(sign(goodPayload))).toEqual({ ok: false, reason: "jwks_unavailable" });
  });
});
