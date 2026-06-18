import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getActiveMock } = vi.hoisted(() => ({ getActiveMock: vi.fn() }));
vi.mock("@/lib/db/vps-gateway-tokens", () => ({
  getActiveGatewayTokenForBusiness: getActiveMock
}));

import {
  verifyRowboatWebhookJwt,
  verifyRowboatWebhookJwtWithSecret,
  resolveRowboatWebhookClaims
} from "@/lib/rowboat/webhook-jwt";

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

describe("verifyRowboatWebhookJwtWithSecret", () => {
  it("verifies against an explicit secret", () => {
    const tok = sign(validClaims(), { secret: "per-tenant" });
    expect(verifyRowboatWebhookJwtWithSecret(tok, "per-tenant")).toMatchObject({
      projectId: "11111111-1111-4111-8111-111111111111"
    });
    expect(verifyRowboatWebhookJwtWithSecret(tok, "wrong")).toBeNull();
  });
});

describe("resolveRowboatWebhookClaims", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ROWBOAT_GATEWAY_TOKEN = SECRET;
  });

  it("verifies with the per-tenant secret resolved by projectId", async () => {
    getActiveMock.mockResolvedValue("per-tenant-secret");
    const tok = sign(validClaims(), { secret: "per-tenant-secret" });
    const claims = await resolveRowboatWebhookClaims(tok);
    expect(claims).toMatchObject({ projectId: "11111111-1111-4111-8111-111111111111" });
    expect(getActiveMock).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("falls back to the shared secret when no per-tenant token exists", async () => {
    getActiveMock.mockResolvedValue(null);
    const tok = sign(validClaims()); // signed with shared SECRET
    expect(await resolveRowboatWebhookClaims(tok)).toMatchObject({ requestId: "req-1" });
  });

  it("falls back to the shared secret when the per-tenant verify fails", async () => {
    getActiveMock.mockResolvedValue("a-different-secret");
    const tok = sign(validClaims()); // signed with shared SECRET, not the per-tenant one
    expect(await resolveRowboatWebhookClaims(tok)).toMatchObject({ requestId: "req-1" });
  });

  it("falls back to the shared secret when the per-tenant lookup throws", async () => {
    getActiveMock.mockRejectedValue(new Error("db down"));
    const tok = sign(validClaims());
    expect(await resolveRowboatWebhookClaims(tok)).toMatchObject({ requestId: "req-1" });
  });

  it("skips the per-tenant lookup for a malformed token (no projectId to peek)", async () => {
    expect(await resolveRowboatWebhookClaims("a.b")).toBeNull();
    expect(getActiveMock).not.toHaveBeenCalled();
  });

  it("skips the per-tenant lookup when the payload isn't valid JSON", async () => {
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const badToken = `${header}.${b64url("not-json{")}.AAAA`;
    expect(await resolveRowboatWebhookClaims(badToken)).toBeNull();
    expect(getActiveMock).not.toHaveBeenCalled();
  });

  it("skips the per-tenant lookup when projectId is not a string", async () => {
    getActiveMock.mockResolvedValue("unused");
    // projectId is a number -> peekProjectId returns null -> shared-secret path,
    // which also rejects (projectId claim must be a string).
    const tok = sign(validClaims({ projectId: 123 }));
    expect(await resolveRowboatWebhookClaims(tok)).toBeNull();
    expect(getActiveMock).not.toHaveBeenCalled();
  });
});
