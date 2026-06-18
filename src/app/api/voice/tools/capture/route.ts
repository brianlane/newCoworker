import { z } from "zod";
import { randomUUID } from "crypto";
import {
  agentToolDisabledResponse,
  gatewayGuard,
  gatewayBusinessGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { insertCoworkerLog } from "@/lib/db/logs";
import { recordSystemLog } from "@/lib/db/system-logs";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { logger } from "@/lib/logger";

/**
 * `capture_caller_details` — writes caller information (name, phone, email,
 * reason for call, notes) to `coworker_logs` so the owner sees it on the
 * dashboard after the call ends. We keep this separate from SMS/email tools
 * so Gemini can log a call even when no follow-up channel is available.
 *
 * Matches the bridge's declaration (`name`, `phone`, `email`, `reason`,
 * `notes`, `urgency`) — `urgency: 'high'` triggers the shared notifications
 * dispatcher (see `src/lib/notifications/dispatch.ts`) so the urgent path is
 * the same whether the alert originates from Rowboat or a live voice call.
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

  const bindGuard = await gatewayBusinessGuard(request, envelope.businessId);
  if (bindGuard) return bindGuard;

  const disabled = await agentToolDisabledResponse(
    envelope.businessId,
    "voice",
    "capture_caller_details"
  );
  if (disabled) return disabled;

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
    const callerPhone = args.phone ?? envelope.callerE164 ?? null;
    const logPayload = {
      source: "voice_tool_capture",
      callerName: args.name ?? null,
      callerPhone,
      callerEmail: args.email ?? null,
      reason: args.reason ?? null,
      notes: args.notes ?? null,
      urgency: args.urgency ?? "normal",
      callControlId: envelope.callControlId ?? null
    };
    await insertCoworkerLog({
      id: logId,
      business_id: envelope.businessId,
      task_type: "call",
      status: args.urgency === "high" ? "urgent_alert" : "success",
      log_payload: logPayload
    });

    if (args.urgency === "high") {
      // High-urgency captures fan out to email/SMS via the shared dispatcher
      // so the same code path handles preferences, recipient resolution, and
      // history-row writes whether the alert originated from Rowboat or here.
      // Failures are logged but do NOT fail the voice-tool call — the call
      // log is already written, and the customer is mid-conversation.
      try {
        const summary = args.reason
          ? `Urgent call: ${args.reason}`.slice(0, 200)
          : "Urgent caller request";
        await dispatchUrgentNotification({
          businessId: envelope.businessId,
          summary,
          kind: "voice_capture",
          payload: { logId, ...logPayload }
        });
      } catch (err) {
        logger.warn("voice-tools/capture: notification dispatch failed", {
          error: err instanceof Error ? err.message : String(err)
        });
        await recordSystemLog({
          businessId: envelope.businessId,
          source: "voice",
          level: "warn",
          event: "voice_urgent_notification_failed",
          message: err instanceof Error ? err.message : String(err),
          payload: { log_id: logId, call_control_id: envelope.callControlId ?? null }
        });
      }
    }

    return voiceToolResponse({ ok: true, data: { logId } });
  } catch (err) {
    logger.warn("voice-tools/capture failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    await recordSystemLog({
      businessId: envelope.businessId,
      source: "voice",
      level: "error",
      event: "voice_tool_capture_failed",
      message: err instanceof Error ? err.message : String(err),
      payload: { call_control_id: envelope.callControlId ?? null }
    });
    return voiceToolResponse({ ok: false, detail: "internal_error" }, 500);
  }
}
