/**
 * Dashboard-chat INLINE action tools — send_sms + calendar lifecycle.
 *
 * The worker-path dashboard coworker (Rowboat `OwnerCoworker`) has had
 * `send_sms` and the `dashboard_calendar_*` tools since launch, fulfilled by
 * /api/rowboat/tool-call. When the INLINE path became primary (PR #612 /
 * #655) it shipped with only creation + knowledge tools, so a healthy inline
 * path silently REMOVED the owner's ability to text and book from chat —
 * James's (KYP Ads) test texts only worked because his turns happened to
 * fall back to the worker. This module gives the inline turn the same
 * actions through the same cores the Rowboat webhook dispatch uses.
 *
 * Design notes:
 *  - Every helper returns a plain JSON payload destined for a Gemini
 *    functionResponse — never throws (a tool blow-up must degrade to an
 *    honest failure the model can relay, not kill the turn).
 *  - send_sms mirrors the voice follow-up adapter's posture: canonicalize
 *    the destination, STOP-list check fails CLOSED, metered send, then a
 *    best-effort `sms_outbound_log` insert (source `dashboard_chat`) so the
 *    text renders in the dashboard Text history — tool sends used to be
 *    invisible platform-side (the only record lived in Telnyx).
 *  - Calendar failures carry the same model-facing guidance strings the
 *    Rowboat dispatch attaches, re-phrased for the owner surface (dashboard
 *    chat talks TO the owner; there is no notify_team here).
 */

import { z } from "zod";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { checkSmsOptOut } from "@/lib/sms/opt-outs";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import { findCalendarSlots, bookCalendarAppointment } from "@/lib/calendar-tools/handlers";
import {
  cancelCalendarAppointment,
  rescheduleCalendarAppointment
} from "@/lib/calendar-tools/reschedule";
import type { GeminiFunctionDeclaration } from "@/lib/gemini-chat";
import { logger } from "@/lib/logger";

/** Tool names as declared to the inline Gemini call (base keys, no prefix). */
export const ACTION_TOOL_NAMES = [
  "send_sms",
  "calendar_find_slots",
  "calendar_book_appointment",
  "calendar_reschedule_appointment",
  "calendar_cancel_appointment"
] as const;

export type ActionToolName = (typeof ACTION_TOOL_NAMES)[number];

export function isActionToolName(name: string): name is ActionToolName {
  return (ACTION_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Settings → Coworker tools gate state for the action tools (dashboard
 * agent). The chat route reads the toggles once per turn — same pattern as
 * `emailToolEnabled` / `knowledgeToolEnabled` — and tools that are OFF are
 * never even declared to the model.
 */
export type ActionToolGates = {
  send_sms: boolean;
  calendar_find_slots: boolean;
  calendar_book_appointment: boolean;
  calendar_reschedule_appointment: boolean;
  calendar_cancel_appointment: boolean;
};

const SEND_SMS_DECLARATION: GeminiFunctionDeclaration = {
  name: "send_sms",
  description:
    "Send a text message from the business number to any phone number. Use ONLY when the owner explicitly asks, in this conversation, for a text to be sent. Never invent recipients or bodies — send exactly what the owner asked for, and when re-sending after a delivery complaint, send the SAME intended message again (never your own previous chat reply). After the tool returns, tell the owner the exact body that was sent.",
  parameters: {
    type: "object",
    properties: {
      toE164: {
        type: "string",
        description: "Recipient phone in E.164, e.g. +15551234567."
      },
      body: {
        type: "string",
        description: "Plain-text message body, at most 1600 characters."
      }
    },
    required: ["toE164", "body"]
  }
};

const FIND_SLOTS_DECLARATION: GeminiFunctionDeclaration = {
  name: "calendar_find_slots",
  description:
    "Find up to 3 free time ranges on the owner's connected calendar. Use when the owner asks about availability. Times are ISO 8601 with timezone offsets.",
  parameters: {
    type: "object",
    properties: {
      purpose: { type: "string", description: "What the appointment is for (optional)." },
      earliest: { type: "string", description: "Earliest acceptable start, ISO 8601 (optional)." },
      latest: { type: "string", description: "Latest acceptable end, ISO 8601 (optional)." },
      durationMinutes: {
        type: "number",
        description: "Appointment length in minutes (default 30)."
      },
      timezone: { type: "string", description: "IANA timezone for interpreting times (optional)." }
    },
    required: []
  }
};

const BOOK_DECLARATION: GeminiFunctionDeclaration = {
  name: "calendar_book_appointment",
  description:
    "Book an appointment on the owner's connected calendar. Use ONLY when the owner explicitly asks to book, with a confirmed start/end time. Times MUST be ISO 8601 with a timezone offset.",
  parameters: {
    type: "object",
    properties: {
      startIso: { type: "string", description: "Start time, ISO 8601 with offset." },
      endIso: { type: "string", description: "End time, ISO 8601 with offset." },
      summary: { type: "string", description: "Short event title." },
      attendeeName: { type: "string", description: "Attendee's name." },
      attendeeEmail: { type: "string", description: "Attendee's email (optional)." },
      attendeePhone: { type: "string", description: "Attendee's phone (optional)." },
      notes: { type: "string", description: "Notes for the event body (optional)." },
      timezone: { type: "string", description: "IANA timezone (optional)." }
    },
    required: ["startIso", "endIso", "summary", "attendeeName"]
  }
};

const RESCHEDULE_DECLARATION: GeminiFunctionDeclaration = {
  name: "calendar_reschedule_appointment",
  description:
    "Move an EXISTING appointment to a new time — the invitation is updated in place, never duplicated. Identify the appointment by the attendee's phone or email. Times MUST be ISO 8601 with a timezone offset.",
  parameters: {
    type: "object",
    properties: {
      newStartIso: { type: "string", description: "New start time, ISO 8601 with offset." },
      newEndIso: { type: "string", description: "New end time, ISO 8601 with offset." },
      attendeeName: { type: "string", description: "Attendee's name (optional)." },
      attendeeEmail: { type: "string", description: "Attendee's email (optional)." },
      attendeePhone: { type: "string", description: "Attendee's phone (optional)." },
      timezone: { type: "string", description: "IANA timezone (optional)." }
    },
    required: ["newStartIso", "newEndIso"]
  }
};

const CANCEL_DECLARATION: GeminiFunctionDeclaration = {
  name: "calendar_cancel_appointment",
  description:
    "Cancel an EXISTING appointment — the attendee gets a single cancellation notice. Identify the appointment by the attendee's phone or email. Use ONLY when the owner explicitly asks to cancel.",
  parameters: {
    type: "object",
    properties: {
      attendeeName: { type: "string", description: "Attendee's name (optional)." },
      attendeeEmail: { type: "string", description: "Attendee's email (optional)." },
      attendeePhone: { type: "string", description: "Attendee's phone (optional)." }
    },
    required: []
  }
};

const DECLARATIONS: Record<ActionToolName, GeminiFunctionDeclaration> = {
  send_sms: SEND_SMS_DECLARATION,
  calendar_find_slots: FIND_SLOTS_DECLARATION,
  calendar_book_appointment: BOOK_DECLARATION,
  calendar_reschedule_appointment: RESCHEDULE_DECLARATION,
  calendar_cancel_appointment: CANCEL_DECLARATION
};

/** The declarations for every gate that is ON, in stable order. */
export function actionToolDeclarations(gates: ActionToolGates): GeminiFunctionDeclaration[] {
  return ACTION_TOOL_NAMES.filter((name) => gates[name]).map((name) => DECLARATIONS[name]);
}

// ---------------------------------------------------------------------
// Arg schemas — kept in lockstep with /api/rowboat/tool-call so both turn
// paths accept the same shapes.
// ---------------------------------------------------------------------

const sendSmsArgsSchema = z.object({
  toE164: z.string().min(5).max(32),
  body: z.string().min(1).max(1600)
});

const findSlotsArgsSchema = z.object({
  purpose: z.string().max(200).optional(),
  earliest: z.string().optional(),
  latest: z.string().optional(),
  durationMinutes: z.number().int().min(5).max(480).default(30),
  timezone: z.string().optional(),
  serviceId: z.string().max(120).optional()
});

const bookAppointmentArgsSchema = z.object({
  startIso: z.string().datetime({ offset: true }),
  endIso: z.string().datetime({ offset: true }),
  summary: z.string().min(1).max(200),
  attendeeName: z.string().min(1).max(200),
  attendeeEmail: z.string().email().optional(),
  attendeePhone: z.string().max(32).optional(),
  notes: z.string().max(2000).optional(),
  timezone: z.string().optional(),
  serviceId: z.string().max(120).optional()
});

const rescheduleAppointmentArgsSchema = z.object({
  newStartIso: z.string().datetime({ offset: true }),
  newEndIso: z.string().datetime({ offset: true }),
  attendeeName: z.string().max(200).optional(),
  attendeeEmail: z.string().email().optional(),
  attendeePhone: z.string().max(32).optional(),
  timezone: z.string().optional()
});

const cancelAppointmentArgsSchema = z.object({
  attendeeName: z.string().max(200).optional(),
  attendeeEmail: z.string().email().optional(),
  attendeePhone: z.string().max(32).optional()
});

// ---------------------------------------------------------------------
// Owner-surface guidance (dashboard chat talks TO the owner, so the
// escalation arm of the Rowboat guidance — notify_team / capture_lead —
// doesn't apply; the honest move here is telling the owner directly).
// ---------------------------------------------------------------------

function bookFailureGuidance(detail: string): string {
  if (detail === "calendar_not_connected") {
    return (
      "No calendar is connected, so you cannot book anything. Tell the owner plainly and " +
      "point them to /dashboard/integrations to connect a calendar."
    );
  }
  return (
    "The booking did not go through — treat that time as no longer available and never " +
    "blame a technical error. Re-check availability with calendar_find_slots and offer a " +
    "fresh option, or tell the owner the booking could not be completed."
  );
}

function lifecycleFailureGuidance(detail: string, verb: "reschedule" | "cancel"): string | null {
  if (detail === "booking_not_found") {
    return (
      "No upcoming appointment was found for that person. Ask the owner for the phone " +
      "number or email the appointment was booked under and the original time. Never book " +
      `a new appointment to fake a ${verb}.`
    );
  }
  if (detail === "calendar_not_connected") {
    return (
      "No calendar is connected, so you cannot change or cancel any appointment. Tell the " +
      "owner plainly and point them to /dashboard/integrations."
    );
  }
  if (detail === "calendar_reschedule_failed" || detail === "calendar_cancel_failed") {
    return (
      `The ${verb} did not go through — never blame a technical error and never book a ` +
      "second appointment as a workaround. Tell the owner it could not be completed."
    );
  }
  return null;
}

const RESCHEDULE_LINK_STEERING =
  "The appointment has NOT been moved yet. Give the owner the rescheduleLink so the " +
  "attendee picks the new time themselves — the SAME appointment gets updated when they " +
  "finish. Never state the reschedule is done or confirm a new time.";

// ---------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------

export type ActionToolDeps = {
  /** Injectable cores (tests). */
  getMessagingConfig?: typeof getTelnyxMessagingForBusiness;
  sendSms?: typeof sendTelnyxSms;
  checkOptOut?: typeof checkSmsOptOut;
  findSlots?: typeof findCalendarSlots;
  book?: typeof bookCalendarAppointment;
  reschedule?: typeof rescheduleCalendarAppointment;
  cancel?: typeof cancelCalendarAppointment;
  createDb?: typeof createSupabaseServiceClient;
};

/**
 * Execute one inline action tool call; the returned payload becomes the
 * Gemini functionResponse. Never throws.
 */
export async function executeActionTool(
  businessId: string,
  call: { name: ActionToolName; args: Record<string, unknown> },
  deps: ActionToolDeps = {}
): Promise<unknown> {
  /* c8 ignore start -- production defaults; tests inject */
  const getMessagingConfig = deps.getMessagingConfig ?? getTelnyxMessagingForBusiness;
  const sendSms = deps.sendSms ?? sendTelnyxSms;
  const checkOptOut = deps.checkOptOut ?? checkSmsOptOut;
  const findSlots = deps.findSlots ?? findCalendarSlots;
  const book = deps.book ?? bookCalendarAppointment;
  const reschedule = deps.reschedule ?? rescheduleCalendarAppointment;
  const cancel = deps.cancel ?? cancelCalendarAppointment;
  const createDb = deps.createDb ?? createSupabaseServiceClient;
  /* c8 ignore stop */

  try {
    switch (call.name) {
      case "send_sms": {
        const parsed = sendSmsArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        // Canonicalize BEFORE the opt-out check and the send — STOP rows are
        // stored canonical, so a differently-formatted destination must not
        // slip past the exact-match check.
        const normalized = normalizeContactNumber(parsed.data.toE164);
        if (!normalized.ok) {
          return { ok: false, message: "invalid_destination" };
        }
        const toPhone = normalized.value;
        const optOut = await checkOptOut(businessId, toPhone);
        if (!optOut.ok) {
          logger.error("dashboard-chat send_sms: opt-out check failed; refusing (fail closed)", {
            businessId,
            error: optOut.error
          });
          return { ok: false, message: "opt_out_check_failed" };
        }
        if (optOut.optedOut) {
          return {
            ok: false,
            message:
              "recipient_opted_out — this number texted STOP and cannot be messaged. Tell the owner."
          };
        }
        const config = await getMessagingConfig(businessId, undefined, { resolveRcs: true });
        let messageId: string;
        let channel: string | undefined;
        try {
          const sent = await sendSms(config, toPhone, parsed.data.body, {
            meterBusinessId: businessId
          });
          messageId = sent.id;
          channel = sent.channel;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const isQuota = /Monthly SMS limit|SMS quota blocked|throttled/i.test(message);
          logger.warn("dashboard-chat send_sms: send failed", { businessId, error: message });
          return {
            ok: false,
            message: isQuota
              ? "sms_quota_blocked — the monthly SMS limit is used up. Tell the owner; do not retry."
              : "sms_send_failed — the text did NOT go out. Tell the owner honestly."
          };
        }
        // Best-effort durable log so the text renders in the dashboard Text
        // history (source dashboard_chat). A failed insert must not fail the
        // tool call — the SMS already went out.
        try {
          const db = await createDb();
          const { error: logErr } = await db.from("sms_outbound_log").insert({
            business_id: businessId,
            to_e164: toPhone,
            from_e164: config.fromE164 ?? null,
            body: parsed.data.body,
            source: "dashboard_chat",
            run_id: null,
            flow_id: null,
            telnyx_message_id: messageId,
            channel
          });
          if (logErr) throw new Error(logErr.message);
        } catch (logErr) {
          logger.error("dashboard-chat send_sms: outbound log insert failed", {
            businessId,
            error: logErr instanceof Error ? logErr.message : String(logErr)
          });
        }
        return {
          ok: true,
          messageId,
          toE164: toPhone,
          sentBody: parsed.data.body,
          note: "Tell the owner the exact message body that was texted."
        };
      }
      case "calendar_find_slots": {
        const parsed = findSlotsArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        return await findSlots(businessId, parsed.data);
      }
      case "calendar_book_appointment": {
        const parsed = bookAppointmentArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        const booked = await book(businessId, parsed.data, null);
        if (
          !booked.ok &&
          (booked.detail === "calendar_book_failed" || booked.detail === "calendar_not_connected")
        ) {
          return { ...booked, message: bookFailureGuidance(booked.detail) };
        }
        return booked;
      }
      case "calendar_reschedule_appointment": {
        const parsed = rescheduleAppointmentArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        const rescheduled = await reschedule(businessId, parsed.data, null);
        if (!rescheduled.ok && rescheduled.detail) {
          const message = lifecycleFailureGuidance(rescheduled.detail, "reschedule");
          if (message) return { ...rescheduled, message };
        }
        // Calendly cannot move an event on the invitee's behalf: the tool
        // returns the invitee's own reschedule link. Without this steering
        // the model would confirm a new time that does not exist yet.
        if (rescheduled.ok && rescheduled.detail === "reschedule_link_created") {
          return { ...rescheduled, message: RESCHEDULE_LINK_STEERING };
        }
        return rescheduled;
      }
      case "calendar_cancel_appointment": {
        const parsed = cancelAppointmentArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        const canceled = await cancel(businessId, parsed.data, null);
        if (!canceled.ok && canceled.detail) {
          const message = lifecycleFailureGuidance(canceled.detail, "cancel");
          if (message) return { ...canceled, message };
        }
        return canceled;
      }
    }
  } catch (err) {
    // A tool blow-up must never kill the chat turn — degrade to an honest
    // failure the model can relay to the owner.
    logger.warn("dashboard-chat action tool failed", {
      businessId,
      tool: call.name,
      error: err instanceof Error ? err.message : String(err)
    });
    return {
      ok: false,
      message: "The tool failed unexpectedly. Tell the owner it did not complete — never pretend it did."
    };
  }
}
