import { z } from "zod";
import {
  agentToolDisabledResponse,
  gatewayBusinessGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { scheduleTextTool } from "@/lib/sms/schedule-text";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import { smsReachability } from "@/lib/phone/deliverability";

/**
 * `schedule_text`, the phone coworker's path to a FUTURE text (the same
 * core the texting coworker got in #1728: one pending `scheduled_sms` row
 * per contact, created_by 'sms_coworker', dispatched by the
 * scheduled-sms-sweep cron, pinned to the contact so later turns on any
 * channel read the standing promise). "I'll text you a reminder at 6:30"
 * used to be a spoken promise with nothing queued behind it, which is the
 * incident class that created the tool.
 *
 * Recipient posture mirrors `send_follow_up_sms`: `phone` is optional and
 * defaults to `envelope.callerE164`, and a model-supplied destination is
 * canonicalized before the core runs (STOP rows are stored canonical, and
 * the core's own opt-out check does an exact match). The plan tier gate,
 * lead-time bounds, opt-out refusal, and the automatic_reminder_exists
 * handshake all live inside the core.
 */

const argsSchema = z.object({
  phone: z.string().min(5).max(32).optional(),
  action: z.enum(["schedule", "cancel"]).optional(),
  sendAtIso: z.string().max(64).optional(),
  text: z.string().max(1600).optional(),
  confirmed: z.boolean().optional()
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
    "schedule_text"
  );
  if (disabled) return disabled;

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }
  const args = parsed.data;
  const phoneRaw = args.phone ?? envelope.callerE164 ?? "";
  if (!phoneRaw) {
    return voiceToolResponse({ ok: false, detail: "no_destination" });
  }
  const normalized = normalizeContactNumber(phoneRaw);
  if (!normalized.ok) {
    return voiceToolResponse({ ok: false, detail: "invalid_destination" });
  }
  // Up-front reachability refusal (same rule as dashboard send_sms/
  // schedule_text): our long codes deliver SMS to NANP (+1) numbers only,
  // and a queued text that dies at dispatch days later is a silently broken
  // promise, the exact class this tool exists to end. An international
  // caller gets an honest "I can't text that number" instead.
  if (smsReachability(normalized.value) !== "nanp") {
    return voiceToolResponse({
      ok: false,
      detail: "sms_unreachable_destination",
      message:
        "Texts can only be delivered to US and Canada (+1) numbers, so a scheduled text to this number would never arrive. Tell the caller honestly that you cannot text this number, and offer email instead if they want a written follow-up."
    });
  }

  const result = await scheduleTextTool(envelope.businessId, {
    phone: normalized.value,
    action: args.action ?? "schedule",
    sendAtIso: args.sendAtIso,
    text: args.text,
    confirmed: args.confirmed
  });
  return voiceToolResponse(result);
}
