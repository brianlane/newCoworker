import { z } from "zod";
import {
  agentToolDisabledResponse,
  gatewayBusinessGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { shareDocumentTool } from "@/lib/documents/tool-handlers";
import { logger } from "@/lib/logger";

/**
 * `document_share` — voice-bridge adapter. Texts the caller an expiring
 * link to a client-facing business document (price sheet, menu, policy)
 * via the shared core in src/lib/documents/tool-handlers.ts. The core
 * enforces the audience gate (voice can only share client-audience docs)
 * and the document's own expiration.
 */

const argsSchema = z.object({
  /** Document title (or id) as the caller referred to it. */
  document: z.string().min(1).max(300),
  /** Destination in E.164; omitted → the caller's own ANI (envelope). */
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/, "phone must be E.164").optional(),
  message: z.string().max(500).optional()
});

export async function POST(request: Request) {
  let envelope;
  try {
    envelope = await parseVoiceToolRequest(request);
  } catch (err) {
    return voiceToolValidationError(
      err instanceof z.ZodError ? err.issues[0]?.message ?? "invalid envelope" : "invalid body"
    );
  }

  const bindGuard = await gatewayBusinessGuard(request, envelope.businessId);
  if (bindGuard) return bindGuard;

  const disabled = await agentToolDisabledResponse(envelope.businessId, "voice", "document_share");
  if (disabled) return disabled;

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }
  const phone = parsed.data.phone ?? envelope.callerE164 ?? "";
  if (!phone) {
    return voiceToolResponse({ ok: false, detail: "no_destination" });
  }

  try {
    const result = await shareDocumentTool(
      envelope.businessId,
      {
        documentRef: parsed.data.document,
        phone,
        ...(parsed.data.message ? { message: parsed.data.message } : {})
      },
      "voice"
    );
    return voiceToolResponse(result);
  } catch (err) {
    logger.warn("voice-tools/document-share: unexpected error", {
      error: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse({ ok: false, detail: "internal_error" }, 500);
  }
}
