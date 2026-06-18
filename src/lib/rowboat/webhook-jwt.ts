import crypto from "node:crypto";
import { getActiveGatewayTokenForBusiness } from "@/lib/db/vps-gateway-tokens";

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
 * deploy-client.sh seeds each per-tenant Rowboat project with
 * `secret: ROWBOAT_GATEWAY_TOKEN` (the per-tenant token once provisioning
 * mints one; the legacy shared token on older boxes). The platform verifies
 * with the per-tenant token resolved by the `projectId` claim
 * (`resolveRowboatWebhookClaims`), falling back to the shared env secret so
 * already-deployed boxes keep working during the transition.
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

/** Read the (UNVERIFIED) projectId claim so we can pick the per-tenant secret. */
function peekProjectId(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(b64urlDecode(parts[1]).toString("utf8")) as Record<string, unknown>;
    return typeof payload.projectId === "string" ? payload.projectId : null;
  } catch {
    return null;
  }
}

/**
 * Verify the HS256 signature + expiry + issuer against a specific secret and
 * return the claims, or null when anything fails. Callers must still compare
 * `bodyHash` against the actual request content and treat `projectId` as the
 * tenant id.
 */
export function verifyRowboatWebhookJwtWithSecret(
  token: string,
  secret: string
): RowboatWebhookClaims | null {
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

/** Legacy shared-secret verifier (kept for callers/tests that don't need per-tenant resolution). */
export function verifyRowboatWebhookJwt(token: string): RowboatWebhookClaims | null {
  return verifyRowboatWebhookJwtWithSecret(token, process.env.ROWBOAT_GATEWAY_TOKEN ?? "");
}

/**
 * Per-tenant tool-webhook verification. Resolves the project's per-tenant token
 * (by the UNVERIFIED projectId claim) and verifies the HMAC with it; the
 * signature check is what makes trusting the peeked projectId safe (a forged
 * projectId won't verify under that tenant's secret). Falls back to the shared
 * env secret so boxes still signing with the legacy shared token keep working.
 */
export async function resolveRowboatWebhookClaims(
  token: string
): Promise<RowboatWebhookClaims | null> {
  const projectId = peekProjectId(token);
  if (projectId) {
    try {
      const perTenant = await getActiveGatewayTokenForBusiness(projectId);
      if (perTenant) {
        // The HMAC verification with the per-tenant secret is itself the
        // proof that this token belongs to `projectId` — a forged projectId
        // would not verify under that tenant's secret.
        const claims = verifyRowboatWebhookJwtWithSecret(token, perTenant);
        if (claims) return claims;
      }
    } catch {
      // Fall through to the shared-secret path on any DB error.
    }
  }
  return verifyRowboatWebhookJwt(token);
}
