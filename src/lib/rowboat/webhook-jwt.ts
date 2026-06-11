import crypto from "node:crypto";

/**
 * Verifier for Rowboat's project tool-webhook signature
 * (`x-signature-jwt`).
 *
 * Rowboat's agents runtime (apps/rowboat/src/application/lib/agents-runtime/
 * agent-tools.ts → invokeWebhookTool in the brianlane/rowboat fork) signs
 * every tool-call POST with an HS256 JWT over the project secret:
 *
 *   claims: { requestId, projectId, bodyHash }   (bodyHash = sha256 of the
 *   `content` string in the request body), iss "rowboat", sub
 *   "tool-call-<id>", exp +5 minutes.
 *
 * deploy-client.sh seeds every per-tenant Rowboat project with
 * `secret: ROWBOAT_GATEWAY_TOKEN` — the same shared secret the VPS already
 * uses as the bearer for /api/voice/tools/* — so the platform can verify
 * with one env var instead of a per-tenant secret table.
 *
 * No `jose` dependency in this repo; HS256 verification is ~20 lines of
 * node:crypto, done here with timing-safe comparison.
 */

export type RowboatWebhookClaims = {
  requestId: string;
  projectId: string;
  bodyHash: string;
};

function b64urlDecode(part: string): Buffer {
  return Buffer.from(part, "base64url");
}

/**
 * Verifies signature + expiry + issuer and returns the claims, or null when
 * anything fails. Callers must still compare `bodyHash` against the actual
 * request content and treat `projectId` as the tenant id.
 */
export function verifyRowboatWebhookJwt(token: string): RowboatWebhookClaims | null {
  const secret = process.env.ROWBOAT_GATEWAY_TOKEN ?? "";
  if (!secret) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;

  let header: { alg?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlDecode(headerPart).toString("utf8"));
    payload = JSON.parse(b64urlDecode(payloadPart).toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${headerPart}.${payloadPart}`, "utf8")
    .digest();
  const actual = b64urlDecode(signaturePart);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return null;
  }

  if (payload.iss !== "rowboat") return null;
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  if (exp * 1000 < Date.now()) return null;

  const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
  const projectId = typeof payload.projectId === "string" ? payload.projectId : "";
  const bodyHash = typeof payload.bodyHash === "string" ? payload.bodyHash : "";
  if (!requestId || !projectId || !bodyHash) return null;

  return { requestId, projectId, bodyHash };
}
