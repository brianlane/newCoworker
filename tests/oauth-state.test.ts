import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOAuthStateCodec, DEFAULT_OAUTH_STATE_TTL_MS } from "@/lib/oauth/state";

const ORIGINAL_ENV = { ...process.env };

class TestNotConfigured extends Error {}

function codec<Extra extends Record<string, string> = Record<string, never>>(
  label = "test-oauth-state",
  ttlMs?: number
) {
  return createOAuthStateCodec<Extra>({
    label,
    ttlMs,
    onMissingSecret: () => new TestNotConfigured("no signing key")
  });
}

/**
 * Mints a VALIDLY SIGNED state around an arbitrary payload.
 *
 * Needed to test the checks that run AFTER the signature passes. Attaching a
 * signature borrowed from some other payload would just fail the signature
 * comparison, so the parse and field-validation branches would never run and the
 * test would prove nothing about them. This is the attacker who has the key.
 */
function signedState(payloadBytes: string, label = "test-oauth-state", secret = "test-signing-key") {
  const payload = Buffer.from(payloadBytes, "utf8").toString("base64url");
  const key = createHmac("sha256", label).update(secret).digest();
  const sig = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

describe("lib/oauth/state", () => {
  beforeEach(() => {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = "test-signing-key";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("round-trips the bound business", () => {
    const c = codec();
    const state = c.create("biz-1");
    expect(c.verify(state)).toEqual({ businessId: "biz-1" });
  });

  it("carries and returns caller-supplied extras", () => {
    const c = codec<{ c: string }>();
    const state = c.create("biz-1", { c: "d" });
    expect(c.verify(state)).toEqual({ businessId: "biz-1", c: "d" });
  });

  it("rejects a tampered payload", () => {
    const c = codec();
    const state = c.create("biz-1");
    const [, sig] = state.split(".");
    const forged = Buffer.from(
      JSON.stringify({ b: "biz-2", e: Date.now() + 60_000, n: "x" }),
      "utf8"
    ).toString("base64url");
    expect(c.verify(`${forged}.${sig}`)).toBeNull();
  });

  it("rejects a tampered signature of the same length", () => {
    const c = codec();
    const state = c.create("biz-1");
    const dot = state.indexOf(".");
    const sig = state.slice(dot + 1);
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(c.verify(`${state.slice(0, dot)}.${flipped}`)).toBeNull();
  });

  it("rejects a signature of the wrong length without throwing", () => {
    // timingSafeEqual throws on a length mismatch, and an attacker picks this
    // length, so the guard has to come first.
    const c = codec();
    const state = c.create("biz-1");
    const dot = state.indexOf(".");
    expect(() => c.verify(`${state.slice(0, dot)}.short`)).not.toThrow();
    expect(c.verify(`${state.slice(0, dot)}.short`)).toBeNull();
  });

  it.each([["no dot", "abcdef"], ["leading dot", ".sig"], ["trailing dot", "payload."], ["empty", ""]])(
    "rejects a malformed state (%s)",
    (_label, value) => {
      expect(codec().verify(value)).toBeNull();
    }
  );

  it("rejects a correctly signed payload that is not JSON", () => {
    // Signature passes, so this exercises the parse guard specifically.
    expect(codec().verify(signedState("not json at all"))).toBeNull();
  });

  it("rejects an expired state", () => {
    const c = codec("test-oauth-state", 1_000);
    const t0 = 1_000_000;
    const state = c.create("biz-1", undefined, t0);
    expect(c.verify(state, t0 + 500)).toEqual({ businessId: "biz-1" });
    expect(c.verify(state, t0 + 1_001)).toBeNull();
  });

  it("defaults to a ten minute TTL", () => {
    expect(DEFAULT_OAUTH_STATE_TTL_MS).toBe(10 * 60 * 1000);
    const c = codec();
    const t0 = 1_000_000;
    const state = c.create("biz-1", undefined, t0);
    expect(c.verify(state, t0 + DEFAULT_OAUTH_STATE_TTL_MS - 1)).not.toBeNull();
    expect(c.verify(state, t0 + DEFAULT_OAUTH_STATE_TTL_MS + 1)).toBeNull();
  });

  it("does not verify a state minted for a different label", () => {
    // Domain separation: both derive from the same platform secret, so without
    // the label a Zoom state would satisfy a Google callback.
    const google = codec("google-oauth-state");
    const outlook = codec("outlook-oauth-state");
    expect(outlook.verify(google.create("biz-1"))).toBeNull();
  });

  it("mints a different state each time for the same business", () => {
    const c = codec();
    expect(c.create("biz-1", undefined, 1_000)).not.toBe(c.create("biz-1", undefined, 1_000));
  });

  it("falls back to the service-role key when no dedicated key is set", () => {
    delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    const c = codec();
    expect(c.verify(c.create("biz-1"))).toEqual({ businessId: "biz-1" });
  });

  it("throws from create when no signing key is available", () => {
    delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => codec().create("biz-1")).toThrow(TestNotConfigured);
  });

  it("returns null rather than throwing from verify when no key is available", () => {
    // A callback is attacker-reachable. A misconfigured deploy should refuse
    // states, not surface a stack trace.
    const c = codec();
    const state = c.create("biz-1");
    delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => c.verify(state)).not.toThrow();
    expect(c.verify(state)).toBeNull();
  });

  it.each([
    ["business id absent", { e: 9_999_999_999_999 }],
    ["business id empty", { b: "", e: 9_999_999_999_999 }],
    ["business id not a string", { b: 7, e: 9_999_999_999_999 }],
    ["expiry absent", { b: "biz-1" }],
    ["expiry not a number", { b: "biz-1", e: "soon" }],
    ["expiry not finite", { b: "biz-1", e: Number.POSITIVE_INFINITY }]
  ])("rejects a correctly signed payload with %s", (_label, bad) => {
    // All correctly signed, so each one reaches the field checks rather than
    // stopping at the signature.
    expect(codec().verify(signedState(JSON.stringify(bad)))).toBeNull();
  });

  it("ignores non-string extras rather than returning them", () => {
    const state = signedState(
      JSON.stringify({ b: "biz-1", e: 9_999_999_999_999, n: "x", c: "d", bad: 7 })
    );
    expect(codec().verify(state)).toEqual({ businessId: "biz-1", c: "d" });
  });
});
