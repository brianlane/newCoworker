import { z } from "zod";
import { randomUUID } from "crypto";
import {
  agentToolDisabledResponse,
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
 * `notify_team` — relays a caller request to the owner/team through the
 * shared notifications dispatcher (dashboard row + email/SMS per the owner's
 * notification preferences).
 *
 * This exists because the voice assistant kept telling callers "let me check
 * with the team and get back to you" while having NO channel to the team at
 * all — the promise died with the call. The system prompt now requires the
 * model to call this tool before making any check-with-the-team statement,
 * so the promise is backed by a real owner notification the moment it is
 * spoken.
 *
 * Deliberately NOT metered against the tenant's monthly SMS pool: the owner
 * notification is platform/owner traffic, never customer-facing (same
 * exemption as `dispatchUrgentNotification`'s other callers — see the
 * "Budget enforcement" section of the README).
 */

const argsSchema = z.object({
  /** What the team needs to do, in plain language. */
  message: z.string().min(1).max(1000),
  /** Caller's name if known, so the owner knows who to get back to. */
  callerName: z.string().max(200).optional(),
  /** Caller's phone if the model collected one other than the ANI. */
  callerPhone: z.string().max(32).optional()
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

  const disabled = await agentToolDisabledResponse(envelope.businessId, "voice", "notify_team");
  if (disabled) return disabled;

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }
  const args = parsed.data;
  const callerPhone = args.callerPhone ?? envelope.callerE164 ?? null;

  try {
    // Dashboard call log first, so the request is visible even if every
    // notification channel is disabled or fails.
    const logId = randomUUID();
    const logPayload = {
      source: "voice_tool_notify_team",
      message: args.message,
      callerName: args.callerName ?? null,
      callerPhone,
      callControlId: envelope.callControlId ?? null
    };
    // `urgent_alert` (not `success`) so the request surfaces in the
    // dashboard alerts feed — a caller was promised a follow-up, and the
    // team acting on it is the whole point of this tool.
    await insertCoworkerLog({
      id: logId,
      business_id: envelope.businessId,
      task_type: "call",
      status: "urgent_alert",
      log_payload: logPayload
    });

    const who = args.callerName
      ? `${args.callerName}${callerPhone ? ` (${callerPhone})` : ""}`
      : callerPhone ?? "a caller";
    const summary = `Caller follow-up needed: ${args.message}`.slice(0, 200);
    let notified = false;
    try {
      const { results } = await dispatchUrgentNotification({
        businessId: envelope.businessId,
        summary,
        kind: "voice_team_notify",
        payload: { logId, ...logPayload },
        emailSubject: `Follow up with ${who}`,
        emailBody: `Your phone coworker took a call from ${who} and promised the team would follow up.\n\nRequest: ${args.message}`,
        smsBody: `[Coworker] Follow up with ${who}: ${args.message}`.slice(0, 640)
      });
      notified = results.some((r) => r.status === "sent");
    } catch (err) {
      // The dashboard log row is already written; report the degraded state
      // to the model truthfully so it doesn't tell the caller the team was
      // reached when no channel delivered.
      logger.warn("voice-tools/notify-team: dispatch failed", {
        businessId: envelope.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      await recordSystemLog({
        businessId: envelope.businessId,
        source: "voice",
        level: "warn",
        event: "voice_notify_team_dispatch_failed",
        message: err instanceof Error ? err.message : String(err),
        payload: { log_id: logId, call_control_id: envelope.callControlId ?? null }
      });
    }

    return voiceToolResponse({
      ok: true,
      data: {
        logId,
        // notified=false means "logged to the dashboard only" — the model is
        // instructed to promise a follow-up, not claim the team already saw it.
        notified
      }
    });
  } catch (err) {
    logger.warn("voice-tools/notify-team failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    await recordSystemLog({
      businessId: envelope.businessId,
      source: "voice",
      level: "error",
      event: "voice_tool_notify_team_failed",
      message: err instanceof Error ? err.message : String(err),
      payload: { call_control_id: envelope.callControlId ?? null }
    });
    return voiceToolResponse({ ok: false, detail: "internal_error" }, 500);
  }
}
