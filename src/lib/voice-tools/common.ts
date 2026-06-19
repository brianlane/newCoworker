import { z } from "zod";
import { NextResponse } from "next/server";
import { verifyGatewayTokenForBusiness } from "@/lib/rowboat/gateway-token";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import type { AgentKey } from "@/lib/agent-tools/registry";

/**
 * Shared request envelope for all `/api/voice/tools/*` adapters.
 *
 * The voice bridge (running on the customer VPS) POSTs here with the same
 * `ROWBOAT_GATEWAY_TOKEN` bearer that Rowboat uses to call the app from the
 * VPS. Keeping the adapters server-side lets us:
 *
 *   - Keep Nango secrets off the VPS.
 *   - Share one shape for every voice tool call (auth + log correlation).
 *   - Add rate limits or tenant allowlists in one place later.
 *
 * Response contract differs from the rest of the app: we return the raw
 * `{ ok, detail?, data? }` shape that the bridge forwards to Gemini Live as
 * a `functionResponse`. Wrapping with the standard `successResponse`
 * envelope would double-nest the ok flag and confuse the model.
 */
export const voiceToolEnvelopeSchema = z.object({
  businessId: z.string().uuid(),
  callControlId: z.string().optional(),
  callerE164: z.string().optional(),
  args: z.record(z.string(), z.unknown()).default({})
});

export type VoiceToolEnvelope = z.infer<typeof voiceToolEnvelopeSchema>;

export type VoiceToolResponse = {
  ok: boolean;
  detail?: string;
  data?: unknown;
};

export function voiceToolResponse(body: VoiceToolResponse, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

export function voiceToolUnauthorized(): NextResponse {
  return NextResponse.json({ ok: false, detail: "unauthorized" }, { status: 401 });
}

export function voiceToolValidationError(message: string): NextResponse {
  return NextResponse.json({ ok: false, detail: `invalid_args:${message}` }, { status: 400 });
}

/**
 * Single authoritative gateway guard for VPS → app calls. Call AFTER the
 * businessId is known (envelope / query): the presented bearer must resolve to
 * THIS business (per-tenant token) OR be the legacy shared `ROWBOAT_GATEWAY_TOKEN`
 * (fail-open for boxes not yet on a per-tenant token). This closes the
 * cross-tenant hole — a leaked tenant token can only act as ITS tenant, never as
 * another via a forged businessId — while still accepting a tenant's own unique
 * token at the door (no separate shared-only pre-gate that would 401 it first).
 */
export async function gatewayBusinessGuard(
  request: Request,
  businessId: string
): Promise<NextResponse | null> {
  const ok = await verifyGatewayTokenForBusiness(request, businessId);
  if (!ok) return voiceToolUnauthorized();
  return null;
}

export async function parseVoiceToolRequest(request: Request): Promise<VoiceToolEnvelope> {
  const body = await request.json().catch(() => ({}));
  return voiceToolEnvelopeSchema.parse(body);
}

/**
 * Settings → Coworker tools enforcement for tool adapters. Returns a
 * `tool_disabled` response when the owner turned the tool off, null when the
 * call may proceed. `isAgentToolEnabled` resolves read errors to the
 * registry default, so a transient DB blip never breaks a live call for
 * default-on tools.
 *
 * Returned with HTTP 200 (not 4xx) deliberately: the caller is a model
 * runtime (Gemini Live bridge / chat-worker) that forwards the `{ ok,
 * detail }` body as a tool result — a 200 with ok:false lets it degrade
 * gracefully instead of treating the turn as an infrastructure failure.
 */
export async function agentToolDisabledResponse(
  businessId: string,
  agentKey: AgentKey,
  toolKey: string
): Promise<NextResponse | null> {
  const enabled = await isAgentToolEnabled(businessId, agentKey, toolKey);
  if (enabled) return null;
  return voiceToolResponse({ ok: false, detail: "tool_disabled" });
}
