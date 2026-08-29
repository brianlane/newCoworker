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

describe("more than one audience, because Google will not say which it sends", () => {
  /**
   * Chat mints the audience from EITHER the Cloud project number OR the
   * endpoint URL, chosen by an "Authentication Audience" setting that does
   * not appear on the configuration page of an app built in the Workspace
   * add-on shape. There is no API that reports it and no way to read it off
   * before the first event lands, and guessing wrong rejects every event
   * with a 401 indistinguishable from a forged token.
   *
   * So both of OUR identifiers are accepted. These tests exist to prove
   * that this widened the set of identifiers rather than weakening the
   * check: an audience belonging to somebody else is still refused, and an
   * empty configuration still refuses everything.
   */
  const URL_AUDIENCE = "https://www.newcoworker.com/api/webhooks/google-chat";
  const BOTH = `${AUDIENCE},${URL_AUDIENCE}`;

  it.each([
    ["the project number", AUDIENCE],
    ["the endpoint URL", URL_AUDIENCE]
  ])("accepts a token whose audience is %s", async (_label, aud) => {
    expect(
      await verifyGoogleChatToken(`Bearer ${sign({ ...goodPayload, aud })}`, {
        audience: BOTH,
        now: NOW
      })
    ).toEqual({ ok: true, audience: aud });
  });

  it("still refuses an audience that is neither of ours", async () => {
    // The whole point of the check. Holding two of our own identifiers must
    // not become "accept any audience".
    expect(
      await verifyGoogleChatToken(`Bearer ${sign({ ...goodPayload, aud: "999888777666" })}`, {
        audience: BOTH,
        now: NOW
      })
    ).toEqual({ ok: false, reason: "unexpected_audience" });
  });

  it("refuses a URL that merely CONTAINS one of ours", async () => {
    // A prefix or suffix match here would accept an attacker-chosen host,
    // so the comparison stays whole-string.
    expect(
      await verifyGoogleChatToken(
        `Bearer ${sign({ ...goodPayload, aud: `${URL_AUDIENCE}.evil.test` })}`,
        { audience: BOTH, now: NOW }
      )
    ).toEqual({ ok: false, reason: "unexpected_audience" });
  });

  it("tolerates the spacing an operator actually types", async () => {
    expect(
      await verifyGoogleChatToken(`Bearer ${sign({ ...goodPayload, aud: URL_AUDIENCE })}`, {
        audience: ` ${AUDIENCE} ,  ${URL_AUDIENCE} `,
        now: NOW
      })
    ).toMatchObject({ ok: true });
  });

  it("fails CLOSED on a list that is nothing but separators", async () => {
    // ",  ," must never collapse into "match anything". This is the shape a
    // half-finished env var edit leaves behind.
    expect(
      await verifyGoogleChatToken(`Bearer ${sign(goodPayload)}`, {
        audience: " , ,, ",
        now: NOW
      })
    ).toEqual({ ok: false, reason: "audience_unconfigured" });
  });

  it("reads the list from the environment too", async () => {
    // The deployed shape: one variable holding both identifiers.
    process.env.GOOGLE_CHAT_AUDIENCE = BOTH;
    try {
      expect(
        await verifyGoogleChatToken(`Bearer ${sign({ ...goodPayload, aud: URL_AUDIENCE })}`, {
          now: NOW
        })
      ).toMatchObject({ ok: true, audience: URL_AUDIENCE });
    } finally {
      delete process.env.GOOGLE_CHAT_AUDIENCE;
    }
  });
});

describe("the app-URL shape, where a valid signature does NOT prove Chat sent it", () => {
  /**
   * With the audience set to the app URL, Chat sends an OpenID Connect ID
   * token instead of a self-signed JWT: issuer `accounts.google.com`, signed
   * with Google's federated keys, not Chat's own.
   *
   * That issuer signs for every account Google hosts, and the audience of an
   * ID token is chosen by whoever requests one, so ANY service account can
   * have Google mint a correctly signed token whose `aud` is our webhook URL.
   * Signature plus audience is therefore not enough here, and the claim that
   * actually identifies Chat is `email`. The refusals below are the point of
   * this block; the acceptances only frame them.
   */
  const URL_AUDIENCE = "https://www.newcoworker.com/api/webhooks/google-chat";
  const BOTH = `${AUDIENCE},${URL_AUDIENCE}`;
  const OIDC_CERTS = "https://www.googleapis.com/oauth2/v3/certs";

  /** Chat's key at its own URL; a DIFFERENT key at Google's federated URL. */
  function serveBothKeySets() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new Response(
          JSON.stringify({
            keys:
              String(url) === OIDC_CERTS
                ? [jwkFor(other.publicKey, "oidc-1")]
                : [jwkFor(publicKey, "key-1")]
          })
        )
      )
    );
  }

  const idToken = (over: Record<string, unknown> = {}) =>
    sign(
      {
        iss: "https://accounts.google.com",
        aud: URL_AUDIENCE,
        exp: Math.floor(NOW / 1000) + 600,
        email: "chat@system.gserviceaccount.com",
        email_verified: true,
        ...over
      },
      { kid: "oidc-1", key: other.privateKey }
    );

  beforeEach(() => {
    resetGoogleChatJwksStateForTests();
    serveBothKeySets();
  });

  it("accepts a real Chat ID token", async () => {
    expect(
      await verifyGoogleChatToken(`Bearer ${idToken()}`, { audience: BOTH, now: NOW })
    ).toEqual({ ok: true, audience: URL_AUDIENCE });
  });

  it("accepts the issuer spelled without a scheme", async () => {
    // Google has used both spellings.
    expect(
      await verifyGoogleChatToken(`Bearer ${idToken({ iss: "accounts.google.com" })}`, {
        audience: BOTH,
        now: NOW
      })
    ).toMatchObject({ ok: true });
  });

  it("REFUSES a correctly signed Google token from anybody but Chat", async () => {
    // The forgery this pin exists to stop: real Google signature, real
    // issuer, our own URL as the audience, minted by a stranger's service
    // account. Only the email claim separates it from the real thing.
    expect(
      await verifyGoogleChatToken(
        `Bearer ${idToken({ email: "attacker@some-project.iam.gserviceaccount.com" })}`,
        { audience: BOTH, now: NOW }
      )
    ).toEqual({ ok: false, reason: "unexpected_chat_identity" });
  });

  it.each([
    ["email_verified is false", { email_verified: false }],
    ["email_verified is absent", { email_verified: undefined }],
    ["there is no email claim at all", { email: undefined }]
  ])("refuses when %s", async (_label, over) => {
    // An unverified email claim asserts nothing, so it cannot carry the
    // identity of the sender.
    expect(
      await verifyGoogleChatToken(`Bearer ${idToken(over)}`, { audience: BOTH, now: NOW })
    ).toEqual({ ok: false, reason: "unexpected_chat_identity" });
  });

  it.each([
    // Chat's kid is not in Google's federated set at all.
    ["a key id only Chat publishes", "key-1", "unknown_key"],
    // A kid that IS in the federated set, but the wrong private key behind
    // it: this is the one that has to reach the signature check and fail.
    ["a federated key id it was not signed with", "oidc-1", "bad_signature"]
  ])("refuses an ID token presenting %s", async (_label, kid, reason) => {
    // The two key sets are disjoint in production, so neither crossing may
    // verify.
    expect(
      await verifyGoogleChatToken(
        `Bearer ${sign(
          {
            iss: "https://accounts.google.com",
            aud: URL_AUDIENCE,
            exp: Math.floor(NOW / 1000) + 600,
            email: "chat@system.gserviceaccount.com",
            email_verified: true
          },
          { kid, key: privateKey }
        )}`,
        { audience: BOTH, now: NOW }
      )
    ).toEqual({ ok: false, reason });
  });

  it("does not spend a second key fetch on a failure both shapes share", async () => {
    // An expired token is expired either way. Only a mismatched ISSUER is
    // worth trying the other shape for.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ keys: [jwkFor(publicKey, "key-1")] })));
    resetGoogleChatJwksStateForTests();
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await verifyGoogleChatToken(
        `Bearer ${sign({ ...goodPayload, exp: Math.floor(NOW / 1000) - 600 })}`,
        { audience: BOTH, now: NOW }
      )
    ).toEqual({ ok: false, reason: "expired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
