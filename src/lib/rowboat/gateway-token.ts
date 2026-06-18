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
 * - Otherwise fall back to the legacy shared `ROWBOAT_GATEWAY_TOKEN`. This keeps
 *   already-deployed boxes (still carrying the shared token) working until they
 *   are re-provisioned with a per-tenant token.
 * - Any DB error during resolution fails OPEN to the legacy check so a transient
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
    // Fail open to the legacy shared-token check below.
    binding = null;
  }
  if (binding) {
    return binding.businessId === businessId;
  }

  const expected = process.env.ROWBOAT_GATEWAY_TOKEN ?? "";
  if (expected === "") return false;
  return timingSafeEqualUtf8(token, expected);
}

/**
 * Layered binding check: returns true UNLESS the presented bearer is a known
 * per-tenant token bound to a DIFFERENT business. Used to add cross-tenant
 * protection on top of an existing non-gateway auth (e.g. the provisioning
 * progress token) without disturbing that auth's own secret comparison. Fails
 * open (returns true) on any DB error.
 */
export async function tokenBindingAllowsBusiness(
  request: Request,
  businessId: string
): Promise<boolean> {
  const token = extractBearerToken(request);
  if (!token) return true;
  try {
    const binding = await resolveGatewayTokenBinding(token);
    return !binding || binding.businessId === businessId;
  } catch {
    return true;
  }
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
