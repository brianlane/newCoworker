import { z } from "zod";
import { NextResponse } from "next/server";
import { verifyRowboatGatewayToken } from "@/lib/rowboat/gateway-token";

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

export function gatewayGuard(request: Request): NextResponse | null {
  if (!verifyRowboatGatewayToken(request)) {
    return voiceToolUnauthorized();
  }
  return null;
}

export async function parseVoiceToolRequest(request: Request): Promise<VoiceToolEnvelope> {
  const body = await request.json().catch(() => ({}));
  return voiceToolEnvelopeSchema.parse(body);
}
