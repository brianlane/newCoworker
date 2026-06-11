import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyRowboatWebhookJwt } from "@/lib/rowboat/webhook-jwt";

const SECRET = "test-gateway-token";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: Record<string, unknown>, opts?: { alg?: string; secret?: string }): string {
  const header = b64url(JSON.stringify({ alg: opts?.alg ?? "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac("sha256", opts?.secret ?? SECRET)
    .update(`${header}.${body}`, "utf8")
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req-1",
    projectId: "11111111-1111-4111-8111-111111111111",
    bodyHash: "abc123",
    iss: "rowboat",
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides
  };
}

beforeEach(() => {
  process.env.ROWBOAT_GATEWAY_TOKEN = SECRET;
});

afterEach(() => {
  delete process.env.ROWBOAT_GATEWAY_TOKEN;
});

describe("verifyRowboatWebhookJwt", () => {
  it("accepts a well-formed HS256 token and returns the claims", () => {
    const claims = verifyRowboatWebhookJwt(sign(validClaims()));
    expect(claims).toEqual({
      requestId: "req-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      bodyHash: "abc123"
    });
  });

  it("rejects when the env secret is unset", () => {
    delete process.env.ROWBOAT_GATEWAY_TOKEN;
    expect(verifyRowboatWebhookJwt(sign(validClaims()))).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    expect(verifyRowboatWebhookJwt(sign(validClaims(), { secret: "wrong" }))).toBeNull();
  });

  it("rejects tampered payloads", () => {
    const token = sign(validClaims());
    const [h, , s] = token.split(".");
    const forged = `${h}.${b64url(JSON.stringify(validClaims({ projectId: "evil" })))}.${s}`;
    expect(verifyRowboatWebhookJwt(forged)).toBeNull();
  });

  it("rejects non-HS256 algorithms (alg-none downgrade)", () => {
    expect(verifyRowboatWebhookJwt(sign(validClaims(), { alg: "none" }))).toBeNull();
  });

  it("rejects expired tokens", () => {
    expect(
      verifyRowboatWebhookJwt(sign(validClaims({ exp: Math.floor(Date.now() / 1000) - 10 })))
    ).toBeNull();
  });

  it("rejects tokens with no exp claim", () => {
    expect(verifyRowboatWebhookJwt(sign(validClaims({ exp: undefined })))).toBeNull();
  });

  it("rejects a wrong issuer", () => {
    expect(verifyRowboatWebhookJwt(sign(validClaims({ iss: "not-rowboat" })))).toBeNull();
  });

  it("rejects missing claims", () => {
    expect(verifyRowboatWebhookJwt(sign(validClaims({ requestId: undefined })))).toBeNull();
    expect(verifyRowboatWebhookJwt(sign(validClaims({ projectId: undefined })))).toBeNull();
    expect(verifyRowboatWebhookJwt(sign(validClaims({ bodyHash: undefined })))).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyRowboatWebhookJwt("")).toBeNull();
    expect(verifyRowboatWebhookJwt("a.b")).toBeNull();
    expect(verifyRowboatWebhookJwt("not.a.jwt")).toBeNull();
  });

  it("rejects a truncated signature (length mismatch short-circuit)", () => {
    const [h, p] = sign(validClaims()).split(".");
    expect(verifyRowboatWebhookJwt(`${h}.${p}.AAAA`)).toBeNull();
  });
});
