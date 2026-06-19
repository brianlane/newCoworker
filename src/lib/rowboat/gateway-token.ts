import { timingSafeEqualUtf8 } from "@/lib/timing-safe-utf8";
import {
  getActiveGatewayTokenForBusiness,
  resolveGatewayTokenBinding
} from "@/lib/db/vps-gateway-tokens";

/** Extract the raw bearer token from an Authorization header. */
export function extractBearerToken(request: Request): string {
  const auth = request.headers.get("authorization") ?? "";
  return auth.replace(/^Bearer\s+/i, "").trim();
}

/** Validates `Authorization: Bearer` against `ROWBOAT_GATEWAY_TOKEN` (Rowboat / VPS → app). */
export function verifyRowboatGatewayToken(request: Request): boolean {
  const token = extractBearerToken(request);
  const expected = process.env.ROWBOAT_GATEWAY_TOKEN ?? "";
  if (expected === "") return false;
  return timingSafeEqualUtf8(token, expected);
}

/**
 * Per-tenant, binding-aware gateway auth for VPS → app calls.
 *
 * - If the presented bearer is a known per-tenant token, it MUST resolve to
 *   `businessId` — this is what closes the cross-tenant hole (a leaked tenant
 *   token can only act as ITS tenant, never as another via a forged businessId).
 * - Otherwise the shared `ROWBOAT_GATEWAY_TOKEN` is accepted. The shared token is
 *   a PLATFORM-INTERNAL secret: it is held by the app and by trusted platform
 *   callers (e.g. the Supabase `ai-flow-worker` edge function, which calls these
 *   endpoints on behalf of every tenant), and is NEVER deployed to a tenant VPS
 *   — provisioning injects each box's own per-tenant token as its
 *   `ROWBOAT_GATEWAY_TOKEN`. So the bearer path is intentionally NOT exclusive:
 *   making it exclusive would 401 the platform edge worker for any migrated
 *   tenant. Cross-tenant safety on this path comes from the binding check above,
 *   not from rejecting the shared token. (The JWT path IS exclusive — see
 *   `resolveRowboatWebhookClaims` — because that secret is forgeable by anyone
 *   who knows the shared value.)
 * - Any DB error during resolution fails OPEN to the shared check so a transient
 *   blip never 401s a live voice/chat call.
 */
export async function verifyGatewayTokenForBusiness(
  request: Request,
  businessId: string
): Promise<boolean> {
  const token = extractBearerToken(request);
  if (!token) return false;

  let binding: { businessId: string } | null = null;
  try {
    binding = await resolveGatewayTokenBinding(token);
  } catch {
    // Fail open to the shared-token check below.
    binding = null;
  }
  if (binding) {
    return binding.businessId === businessId;
  }

  // Not a known per-tenant token: accept the platform-internal shared token.
  return verifyRowboatGatewayToken(request);
}

/**
 * Resolve the bearer the platform should send when calling a tenant's Rowboat
 * (app → Rowboat). Prefers the per-tenant token, then the legacy
 * `ROWBOAT_VPS_CHAT_BEARER` / `ROWBOAT_GATEWAY_TOKEN` env fallbacks so existing
 * tenants keep working until they carry a per-tenant token. Fails over to the
 * env values on any DB error.
 */
export async function resolveOutboundRowboatBearer(businessId: string): Promise<string> {
  const envFallback =
    process.env.ROWBOAT_VPS_CHAT_BEARER ?? process.env.ROWBOAT_GATEWAY_TOKEN ?? "";
  try {
    const perTenant = await getActiveGatewayTokenForBusiness(businessId);
    return perTenant ?? envFallback;
  } catch {
    return envFallback;
  }
}
