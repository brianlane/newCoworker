import { z } from "zod";
import {
  agentToolDisabledResponse,
  gatewayBusinessGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { lookupBusinessKnowledge, classifyGeminiError } from "@/lib/knowledge-tools/handlers";
import { logger } from "@/lib/logger";

/**
 * `business_knowledge_lookup` — voice-bridge adapter. Answers a caller's
 * business-specific question from the vault via the shared core in
 * src/lib/knowledge-tools/handlers.ts (also used by the Rowboat tool
 * webhook for the dashboard + texting surfaces).
 */

// Re-exported for tests pinning the error-classification contract.
export { classifyGeminiError };

const argsSchema = z.object({
  question: z.string().min(1).max(500)
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

  const disabled = await agentToolDisabledResponse(
    envelope.businessId,
    "voice",
    "business_knowledge_lookup"
  );
  if (disabled) return disabled;

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }

  try {
    // callerE164 scopes graph retrieval (memory_graph_mode tenants) to the
    // caller's own entity when their number is a known contact point.
    const result = await lookupBusinessKnowledge(envelope.businessId, parsed.data.question, {
      ...(envelope.callerE164 ? { callerE164: envelope.callerE164 } : {})
    });
    return voiceToolResponse(result);
  } catch (err) {
    logger.warn("voice-tools/knowledge: unexpected error", {
      error: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse({ ok: false, detail: "internal_error" }, 500);
  }
}
