/**
 * Credentialed-browse helper: return a stored custom integration's DECRYPTED
 * credentials so the headless render service (vps/aiflow-render) can log into a
 * gated site (e.g. a ReferralExchange agent account) before reading a lead page.
 *
 * This is the ONLY route besides the call-proxy where a stored credential leaves
 * the encrypted-at-rest column, so the rules mirror that route:
 *
 *   1. Auth is gateway-only (ROWBOAT_GATEWAY_TOKEN). The dashboard never calls
 *      this; only trusted VPS infra (the render service) does.
 *   2. The tenant (businessId) is bound by the URL query (?businessId=<uuid>),
 *      never the JSON body — same anti-injection posture as the call proxy.
 *   3. Credentials are returned ONLY to the gateway holder, never to a browser
 *      or the model. The render service uses them in-process to drive a login
 *      form and never persists or echoes them.
 *
 * Response: { ok, data: { authScheme, username, password } }. For the `basic`
 * scheme the stored secret is "username:password" (split on the first colon).
 */
import { z } from "zod";
import { logger } from "@/lib/logger";
import { errorResponse } from "@/lib/api-response";
import {
  gatewayBusinessGuard,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { getCustomIntegrationByLabel } from "@/lib/db/custom-integrations";

const bodySchema = z.object({
  label: z.string().min(1).max(80)
});

const businessIdSchema = z.string().uuid();

/** Split a stored secret into username/password on the FIRST colon. */
export function splitCredential(secret: string | null): { username: string; password: string } {
  if (!secret) return { username: "", password: "" };
  const i = secret.indexOf(":");
  if (i < 0) return { username: secret, password: "" };
  return { username: secret.slice(0, i), password: secret.slice(i + 1) };
}

export async function POST(request: Request) {
  let businessId: string;
  try {
    const raw = new URL(request.url).searchParams.get("businessId");
    const parsed = businessIdSchema.safeParse(raw);
    if (!parsed.success) return voiceToolValidationError("missing_business_id");
    businessId = parsed.data;
  } catch {
    /* c8 ignore next 2 -- WHATWG URL never throws for a routed request; defensive only */
    return voiceToolValidationError("invalid_request_url");
  }

  const bindGuard = await gatewayBusinessGuard(request, businessId);
  if (bindGuard) return bindGuard;

  let label: string;
  try {
    label = bodySchema.parse(await request.json()).label;
  } catch (err) {
    const detail = err instanceof z.ZodError ? "invalid_args" : "invalid_body";
    return voiceToolValidationError(detail);
  }

  let integration;
  try {
    integration = await getCustomIntegrationByLabel(businessId, label);
  } catch (err) {
    logger.error("custom-integration credentials: lookup failed", {
      businessId,
      label,
      errorMessage: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse({ ok: false, detail: "lookup_failed" }, 500);
  }
  if (!integration) return voiceToolResponse({ ok: false, detail: "integration_not_found" });
  if (!integration.is_active) return voiceToolResponse({ ok: false, detail: "integration_disabled" });
  if (!integration.secret) return voiceToolResponse({ ok: false, detail: "secret_missing" });

  const { username, password } = splitCredential(integration.secret);

  logger.info("custom-integration credentials issued", {
    businessId,
    label,
    authScheme: integration.auth_scheme
  });

  return voiceToolResponse({
    ok: true,
    data: { authScheme: integration.auth_scheme, username, password }
  });
}

export async function GET() {
  return errorResponse("VALIDATION_ERROR", "GET not supported on this route — use POST", 405);
}
