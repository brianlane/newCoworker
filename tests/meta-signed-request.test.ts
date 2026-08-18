/**
 * Meta `signed_request` verification (src/lib/meta/signed-request.ts).
 *
 * This is the ONLY authentication on the deauthorize and data-deletion
 * callbacks: both are public, unauthenticated POST endpoints, and a verifier
 * that accepts a forged request would let anyone on the internet sever a
 * paying tenant's Meta connection by guessing an app-scoped id. Every
 * rejection path is pinned deliberately.
 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  readSignedRequestField,
  verifyMetaSignedRequest
} from "@/lib/meta/signed-request";

const APP_SECRET = "test-app-secret";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.META_APP_SECRET = APP_SECRET;
});

/** Build a signed_request the way Meta does. */
function sign(payload: unknown, secret = APP_SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(encoded, "utf8").digest("base64url");
  return `${sig}.${encoded}`;
}

const VALID = {
  algorithm: "HMAC-SHA256",
  issued_at: 1786400000,
  expires: 1786403600,
  user_id: "122098495527401398"
};

describe("verifyMetaSignedRequest", () => {
  it("accepts Meta's documented payload and returns the app-scoped user id", () => {
    expect(verifyMetaSignedRequest(sign(VALID))).toEqual({
      algorithm: "HMAC-SHA256",
      user_id: "122098495527401398",
      issued_at: 1786400000,
      expires: 1786403600
    });
  });

  it("signs over the RAW payload segment, not a re-encoding of the decoded JSON", () => {
    // Key order and whitespace both change the bytes. Verifying a
    // re-serialized object instead of the received segment would reject
    // Meta's own requests, so this pins that we hash what arrived.
    const json = '{  "user_id" : "42" ,  "algorithm":"HMAC-SHA256"  }';
    const encoded = Buffer.from(json, "utf8").toString("base64url");
    const sig = createHmac("sha256", APP_SECRET).update(encoded, "utf8").digest("base64url");
    expect(verifyMetaSignedRequest(`${sig}.${encoded}`)?.user_id).toBe("42");
  });

  it("REJECTS a signature made with the wrong secret", () => {
    expect(verifyMetaSignedRequest(sign(VALID, "not-our-secret"))).toBeNull();
  });

  it("REJECTS a payload tampered with after signing", () => {
    // The attack this endpoint invites: keep a real signature, swap in
    // someone else's app-scoped id to sever their connection.
    const [sig] = sign(VALID).split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...VALID, user_id: "999999999999" }),
      "utf8"
    ).toString("base64url");
    expect(verifyMetaSignedRequest(`${sig}.${forged}`)).toBeNull();
  });

  it("REJECTS an unsigned payload passed off as signed", () => {
    const encoded = Buffer.from(JSON.stringify(VALID), "utf8").toString("base64url");
    expect(verifyMetaSignedRequest(`.${encoded}`)).toBeNull();
    expect(verifyMetaSignedRequest(`x.${encoded}`)).toBeNull();
    expect(verifyMetaSignedRequest(encoded)).toBeNull();
  });

  it("REJECTS an algorithm other than HMAC-SHA256, even correctly signed", () => {
    // Signature valid, algorithm claim not. Pinned so a future downgrade
    // cannot be accepted silently.
    expect(verifyMetaSignedRequest(sign({ ...VALID, algorithm: "HMAC-SHA1" }))).toBeNull();
    expect(verifyMetaSignedRequest(sign({ ...VALID, algorithm: "none" }))).toBeNull();
    const { algorithm: _dropped, ...noAlgorithm } = VALID;
    expect(verifyMetaSignedRequest(sign(noAlgorithm))).toBeNull();
  });

  it("REJECTS a correctly signed payload with no usable user id", () => {
    // Nothing to act on; acting on "" would match every row with a null id.
    const { user_id: _dropped, ...noUser } = VALID;
    expect(verifyMetaSignedRequest(sign(noUser))).toBeNull();
    expect(verifyMetaSignedRequest(sign({ ...VALID, user_id: "" }))).toBeNull();
    expect(verifyMetaSignedRequest(sign({ ...VALID, user_id: null }))).toBeNull();
    expect(verifyMetaSignedRequest(sign({ ...VALID, user_id: { id: "1" } }))).toBeNull();
  });

  it("accepts a numeric user_id, since it identifies the same person", () => {
    expect(verifyMetaSignedRequest(sign({ ...VALID, user_id: 42 }))?.user_id).toBe("42");
  });

  it("REJECTS malformed shapes without throwing", () => {
    for (const input of [
      null,
      undefined,
      "",
      "nodots",
      "a.b.c",
      "sig.",
      ".",
      "sig.not-base64-json"
    ]) {
      expect(verifyMetaSignedRequest(input as string | null)).toBeNull();
    }
  });

  it("REJECTS a correctly signed payload whose bytes are not JSON", () => {
    // A valid signature over garbage. The signature check passes, so only
    // the parse guard stops it.
    const encoded = Buffer.from("this is not json", "utf8").toString("base64url");
    const sig = createHmac("sha256", APP_SECRET).update(encoded, "utf8").digest("base64url");
    expect(verifyMetaSignedRequest(`${sig}.${encoded}`)).toBeNull();
  });

  it("REJECTS a correctly signed payload that is not an object", () => {
    expect(verifyMetaSignedRequest(sign("a string"))).toBeNull();
    expect(verifyMetaSignedRequest(sign(null))).toBeNull();
    expect(verifyMetaSignedRequest(sign([1, 2]))).toBeNull();
  });

  it("omits issued_at / expires when Meta does not send them", () => {
    expect(verifyMetaSignedRequest(sign({ algorithm: "HMAC-SHA256", user_id: "7" }))).toEqual({
      algorithm: "HMAC-SHA256",
      user_id: "7"
    });
  });
});

describe("readSignedRequestField", () => {
  it("reads the form-encoded field Meta actually posts", () => {
    const body = new URLSearchParams({ signed_request: "abc.def" }).toString();
    expect(readSignedRequestField(body, "application/x-www-form-urlencoded")).toBe("abc.def");
    // No content type at all still parses as form data.
    expect(readSignedRequestField(body, null)).toBe("abc.def");
  });

  it("reads JSON too, which the App Dashboard test tooling has sent", () => {
    expect(readSignedRequestField('{"signed_request":"abc.def"}', "application/json")).toBe(
      "abc.def"
    );
  });

  it("returns null for a body with no usable field", () => {
    expect(readSignedRequestField("", "application/x-www-form-urlencoded")).toBeNull();
    expect(readSignedRequestField("other=1", "application/x-www-form-urlencoded")).toBeNull();
    expect(readSignedRequestField("signed_request=", null)).toBeNull();
    expect(readSignedRequestField("not json", "application/json")).toBeNull();
    expect(readSignedRequestField('{"signed_request":5}', "application/json")).toBeNull();
    expect(readSignedRequestField("{}", "application/json")).toBeNull();
  });
});
