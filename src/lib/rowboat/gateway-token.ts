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
 * - Otherwise (the bearer is not a per-tenant token) the shared
 *   `ROWBOAT_GATEWAY_TOKEN` is accepted ONLY when this business has no per-tenant
 *   token yet (legacy box). Once a business is migrated to a per-tenant token,
 *   the shared secret can no longer impersonate it — mirroring the exclusive
 *   rule in `resolveRowboatWebhookClaims`.
 * - Any DB error during resolution fails OPEN to the legacy shared check so a
 *   transient blip never 401s a live voice/chat call.
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
    // Fail open to the legacy shared-token check below.
    binding = null;
  }
  if (binding) {
    return binding.businessId === businessId;
  }

  // The bearer is not a per-tenant token. Accept the shared token only if this
  // business hasn't been migrated to a per-tenant token. Fail open to the shared
  // check on a DB error so a transient blip doesn't drop live calls.
  try {
    const perTenant = await getActiveGatewayTokenForBusiness(businessId);
    if (perTenant) return false;
  } catch {
    // fall through to the shared-token check
  }
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
