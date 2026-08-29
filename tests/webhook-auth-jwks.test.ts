import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSign, generateKeyPairSync, createPublicKey } from "node:crypto";

/**
 * The shared provider-signed webhook verifier.
 *
 * Teams and Google Chat both authenticate this way and each has its own
 * suite; what is proved HERE is what neither of theirs can reach, because
 * each only ever sees one provider.
 *
 * THE CACHES MUST NOT BLEED. Two providers, two key sets, one module. A key
 * that verifies for one provider must never verify for the other, or the
 * whole point of pinning an issuer is lost: anyone able to get a token
 * signed by Google's Chat service account could speak to the Teams webhook.
 *
 * And the audience guard, which no channel wrapper can trigger because both
 * check their own environment variable first and refuse with a name that
 * points at the variable an operator has to go and set. It stays here as
 * defence in depth for the next channel, so it is tested here.
 */

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  verifyWebhookToken,
  resetWebhookJwksStateForTests,
  type WebhookTokenProvider
} from "@/lib/webhook-auth/jwks";

const NOW = Date.parse("2026-08-29T12:00:00Z");

const alpha = generateKeyPairSync("rsa", { modulusLength: 2048 });
const beta = generateKeyPairSync("rsa", { modulusLength: 2048 });

const ALPHA: WebhookTokenProvider = {
  name: "alpha",
  source: { jwksUrl: "https://alpha.test/keys" },
  issuer: "alpha@issuer.test"
};
const BETA: WebhookTokenProvider = {
  name: "beta",
  source: { metadataUrl: "https://beta.test/.well-known/openidconfiguration" },
  issuer: "beta@issuer.test"
};

function jwkFor(key: ReturnType<typeof createPublicKey>, kid: string) {
  return { ...(key.export({ format: "jwk" }) as object), kid, use: "sig", alg: "RS256" };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function sign(payload: Record<string, unknown>, key: typeof alpha.privateKey, kid = "k1") {
  const signing = `${b64({ alg: "RS256", kid, typ: "JWT" })}.${b64(payload)}`;
  return `${signing}.${createSign("RSA-SHA256").update(signing).sign(key).toString("base64url")}`;
}

const payloadFor = (issuer: string) => ({
  iss: issuer,
  aud: "our-app",
  exp: Math.floor(NOW / 1000) + 600
});

/** Each provider serves its OWN key, from its own URL. */
function serveBoth() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("alpha.test")) {
        return new Response(JSON.stringify({ keys: [jwkFor(alpha.publicKey, "k1")] }));
      }
      if (url.includes("openidconfiguration")) {
        return new Response(JSON.stringify({ jwks_uri: "https://beta.test/keys" }));
      }
      return new Response(JSON.stringify({ keys: [jwkFor(beta.publicKey, "k1")] }));
    })
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetWebhookJwksStateForTests();
  serveBoth();
});

afterEach(() => resetWebhookJwksStateForTests());

describe("two providers share the module but not their keys", () => {
  it("verifies each provider with its own key set", async () => {
    expect(
      await verifyWebhookToken(ALPHA, `Bearer ${sign(payloadFor(ALPHA.issuer), alpha.privateKey)}`, {
        audience: "our-app",
        now: NOW
      })
    ).toMatchObject({ ok: true });
    expect(
      await verifyWebhookToken(BETA, `Bearer ${sign(payloadFor(BETA.issuer), beta.privateKey)}`, {
        audience: "our-app",
        now: NOW
      })
    ).toMatchObject({ ok: true });
  });

  it("REFUSES a token signed by the other provider's key", async () => {
    // The property that makes one cache safe for many providers. Both keys
    // are warm and both use kid `k1`, so a cache keyed on the kid alone
    // would happily verify this.
    await verifyWebhookToken(ALPHA, `Bearer ${sign(payloadFor(ALPHA.issuer), alpha.privateKey)}`, {
      audience: "our-app",
      now: NOW
    });
    expect(
      await verifyWebhookToken(BETA, `Bearer ${sign(payloadFor(BETA.issuer), alpha.privateKey)}`, {
        audience: "our-app",
        now: NOW
      })
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a token that is valid for the OTHER provider, issuer and all", async () => {
    // Not just the signature: the whole token, correctly signed by beta for
    // beta, presented at alpha.
    expect(
      await verifyWebhookToken(ALPHA, `Bearer ${sign(payloadFor(BETA.issuer), beta.privateKey)}`, {
        audience: "our-app",
        now: NOW
      })
    ).toEqual({ ok: false, reason: "unexpected_issuer" });
  });

  it("caches per provider, so warming one does not spare the other a fetch", async () => {
    const spy = vi.mocked(globalThis.fetch);
    await verifyWebhookToken(ALPHA, `Bearer ${sign(payloadFor(ALPHA.issuer), alpha.privateKey)}`, {
      audience: "our-app",
      now: NOW
    });
    const afterAlpha = spy.mock.calls.length;
    await verifyWebhookToken(BETA, `Bearer ${sign(payloadFor(BETA.issuer), beta.privateKey)}`, {
      audience: "our-app",
      now: NOW
    });
    expect(spy.mock.calls.length).toBeGreaterThan(afterAlpha);
  });
});

describe("the two key-source shapes", () => {
  it("fetches a directly-served key set in ONE request", async () => {
    const spy = vi.mocked(globalThis.fetch);
    await verifyWebhookToken(ALPHA, `Bearer ${sign(payloadFor(ALPHA.issuer), alpha.privateKey)}`, {
      audience: "our-app",
      now: NOW
    });
    expect(spy.mock.calls).toHaveLength(1);
    expect(String(spy.mock.calls[0][0])).toBe("https://alpha.test/keys");
  });

  it("follows a discovery document to the key set in TWO", async () => {
    const spy = vi.mocked(globalThis.fetch);
    await verifyWebhookToken(BETA, `Bearer ${sign(payloadFor(BETA.issuer), beta.privateKey)}`, {
      audience: "our-app",
      now: NOW
    });
    expect(spy.mock.calls).toHaveLength(2);
    expect(String(spy.mock.calls[1][0])).toBe("https://beta.test/keys");
  });
});

describe("the audience guard", () => {
  it.each<[string, string | string[]]>([
    ["empty", ""],
    ["only whitespace", "   "],
    // The list form, which Google Chat uses because Chat picks the audience
    // from either the project number or the endpoint URL and never says
    // which. An empty list must fail closed exactly like an empty string.
    ["an empty list", []],
    ["a list of nothing but blanks", ["", "   "]]
  ])("refuses everything when our expected audience is %s", async (_label, audience) => {
    // Fails CLOSED. An empty expected audience must never mean "match any",
    // which is what a naive equality check against `undefined` would do.
    expect(
      await verifyWebhookToken(ALPHA, `Bearer ${sign(payloadFor(ALPHA.issuer), alpha.privateKey)}`, {
        audience,
        now: NOW
      })
    ).toEqual({ ok: false, reason: "audience_unconfigured" });
  });

  it("accepts a token matching ANY of several identifiers we own", async () => {
    // Widening the SET of our own identifiers, not weakening the check: the
    // rejection below proves an audience outside the set is still refused.
    for (const aud of ["our-app", "https://app.test/hook"]) {
      expect(
        await verifyWebhookToken(
          ALPHA,
          `Bearer ${sign({ ...payloadFor(ALPHA.issuer), aud }, alpha.privateKey)}`,
          { audience: ["our-app", "https://app.test/hook"], now: NOW }
        )
      ).toMatchObject({ ok: true, token: { audience: aud } });
    }

    expect(
      await verifyWebhookToken(
        ALPHA,
        `Bearer ${sign({ ...payloadFor(ALPHA.issuer), aud: "someone-elses-app" }, alpha.privateKey)}`,
        { audience: ["our-app", "https://app.test/hook"], now: NOW }
      )
    ).toEqual({ ok: false, reason: "unexpected_audience" });
  });

  it("hands the full claim set back, for the channel to read what it needs", async () => {
    const out = await verifyWebhookToken(
      ALPHA,
      `Bearer ${sign({ ...payloadFor(ALPHA.issuer), tid: "tenant-1", extra: 7 }, alpha.privateKey)}`,
      { audience: "our-app", now: NOW }
    );
    expect(out).toMatchObject({
      ok: true,
      token: { audience: "our-app", claims: { tid: "tenant-1", extra: 7 } }
    });
  });
});
