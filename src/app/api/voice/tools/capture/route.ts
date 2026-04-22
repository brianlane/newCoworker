import { z } from "zod";
import { randomUUID } from "crypto";
import {
  gatewayGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { insertCoworkerLog } from "@/lib/db/logs";
import { logger } from "@/lib/logger";

/**
 * `capture_caller_details` — writes caller information (name, phone, email,
 * reason for call, notes) to `coworker_logs` so the owner sees it on the
 * dashboard after the call ends. We keep this separate from SMS/email tools
 * so Gemini can log a call even when no follow-up channel is available.
 *
 * Matches the bridge's declaration (`name`, `phone`, `email`, `reason`,
 * `notes`, `urgency`) — `urgency: 'high'` maps to the existing `urgent_alert`
 * status so the notification fan-out already wired to `coworker_logs` will
 * email/SMS the owner.
 */

const argsSchema = z.object({
  name: z.string().max(200).optional(),
  phone: z.string().max(32).optional(),
  email: z.string().email().optional(),
  reason: z.string().max(1000).optional(),
  notes: z.string().max(2000).optional(),
  urgency: z.enum(["low", "normal", "high"]).optional()
});

export async function POST(request: Request) {
  const guard = gatewayGuard(request);
  if (guard) return guard;

  let envelope;
  try {
    envelope = await parseVoiceToolRequest(request);
  } catch (err) {
    return voiceToolValidationError(
      err instanceof z.ZodError ? err.issues[0]?.message ?? "invalid envelope" : "invalid body"
    );
  }

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }
  const args = parsed.data;

  // Require at least one useful field so the log isn't empty noise.
  const hasContent = Boolean(
    args.name || args.phone || args.email || args.reason || args.notes
  );
  if (!hasContent) {
    return voiceToolResponse({ ok: false, detail: "empty_capture" });
  }

  try {
    const logId = randomUUID();
    await insertCoworkerLog({
      id: logId,
      business_id: envelope.businessId,
      task_type: "call",
      status: args.urgency === "high" ? "urgent_alert" : "success",
      log_payload: {
        source: "voice_tool_capture",
        callerName: args.name ?? null,
        callerPhone: args.phone ?? envelope.callerE164 ?? null,
        callerEmail: args.email ?? null,
        reason: args.reason ?? null,
        notes: args.notes ?? null,
        urgency: args.urgency ?? "normal",
        callControlId: envelope.callControlId ?? null
      }
    });

    return voiceToolResponse({ ok: true, data: { logId } });
  } catch (err) {
    logger.warn("voice-tools/capture failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse({ ok: false, detail: "internal_error" }, 500);
  }
}
