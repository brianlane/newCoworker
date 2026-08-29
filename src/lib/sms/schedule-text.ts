/**
 * `schedule_text`: the texting coworker's only way to send a text later.
 *
 * R V (KYP Ads, 2026-08-28) asked for a reminder 30 minutes before his
 * Monday strategy call. The assistant replied "I'll make sure you get a
 * reminder text at 6:30 PM Eastern" and nothing was queued anywhere: the
 * SMS coworker had no tool that could send at a future time, so the promise
 * was pure narration. The dashboard has had a scheduled-send queue since
 * the tier relaunch (`scheduled_sms`, dispatched by the scheduled-sms-sweep
 * Edge cron every minute); this hands the same queue to the agent.
 *
 * Four limits the dashboard does not need, because a customer is steering
 * this one:
 *
 *   1. RECIPIENT IS THE CONVERSATION. The tool takes the texter's number and
 *      queues only to it. There is no path to a third party, so "text my
 *      buddy at ..." (or a prompt-injected number) cannot turn the business
 *      line into a sender for strangers.
 *   2. ONE QUEUED TEXT PER CONTACT. Scheduling again MOVES the pending row
 *      rather than adding a second, so a chatty thread cannot stack a dozen
 *      metered sends, and "actually make it 6:45" does the obvious thing.
 *   3. ASK BEFORE DOUBLING UP. When the tenant already runs an automatic
 *      pre-call reminder (an enabled `event_start` calendar AiFlow, which is
 *      exactly what KYP has at 60 minutes), the first call REFUSES and hands
 *      back the lead time, so the model tells the texter what already goes
 *      out and asks before adding a second reminder.
 *   4. LEAVE A TRACE. What was queued is pinned to the contact, and pinned
 *      notes ride the SMS preamble on every later turn, so a reschedule or a
 *      cancel two days later still sees the standing promise.
 *
 * Dispatch-time failures (a downgrade, an opt-out, the monthly SMS cap) stay
 * the sweep's business: it marks the row canceled/failed and the owner sees
 * it in the dashboard queue, the same as an owner-scheduled send.
 */

import { z } from "zod";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  SCHEDULED_SMS_MAX_DAYS_AHEAD,
  SCHEDULED_SMS_MIN_LEAD_MS,
  smsToolsAllowedForBusiness
} from "@/lib/plans/sms-tools";
import { checkSmsOptOut } from "@/lib/sms/opt-outs";
import { getBusinessTimezone } from "@/lib/db/businesses";
import { appendCustomerPinnedNote } from "@/lib/customer-tools/handlers";
import { formatBookingStartLocal } from "@/lib/calendar-tools/handlers";
import { gsmSafeSpaces } from "@/lib/sms/segment-info";

/**
 * The local time label, GSM-7 safe. The model is told to quote this back to
 * the texter VERBATIM, and Intl hides a NARROW NO-BREAK SPACE before AM/PM,
 * which would re-encode that whole confirmation as UCS-2 and roughly double
 * what it costs to send. Invisible, so nothing about the reply looks wrong.
 */
function timeLabel(iso: string, timeZone: string): string {
  return gsmSafeSpaces(formatBookingStartLocal(iso, timeZone));
}

/** How much of the queued body is echoed into the pinned note. */
const PINNED_BODY_PREVIEW = 120;

export const scheduleTextArgsSchema = z.object({
  /** The CURRENT texter's number, the only person this tool may queue for. */
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/, "phone must be E.164, e.g. +15551234567"),
  action: z.enum(["schedule", "cancel"]).default("schedule"),
  /** ISO 8601 WITH offset, e.g. 2026-08-31T18:30:00-04:00. */
  sendAtIso: z.string().max(64).optional(),
  text: z.string().max(1600).optional(),
  /** True only after the texter said yes to a second, extra reminder. */
  confirmed: z.boolean().optional()
});

export type ScheduleTextArgs = z.infer<typeof scheduleTextArgsSchema>;

export type ScheduleTextResult = {
  ok: boolean;
  detail?: string;
  data?: unknown;
  message?: string;
};

type PendingRow = { id: string; send_at: string; body?: string | null };

/**
 * The tenant's automatic pre-call reminder, when they run one: an enabled
 * calendar flow that fires N minutes BEFORE an event starts. Read straight
 * off the stored definition rather than through the flow schema, so a
 * definition this app version cannot fully parse still counts (the question
 * is only "does something already text a reminder", and answering "no" to
 * that is what produces the duplicate).
 */
async function automaticReminderLeadMinutes(
  businessId: string,
  db: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<number | null> {
  const { data, error } = await db
    .from("ai_flows")
    .select("name, definition")
    .eq("business_id", businessId)
    .eq("enabled", true)
    .is("deleted_at", null)
    .limit(200);
  // Unreadable flows must not block a legitimate reminder: the worst case is
  // the duplicate the confirm step exists to avoid, not a broken tool.
  if (error || !Array.isArray(data)) return null;
  const leads: number[] = [];
  for (const row of data as Array<{ definition?: unknown }>) {
    const trigger = (row.definition as { trigger?: Record<string, unknown> } | null)?.trigger;
    if (!trigger || trigger.on !== "event_start") continue;
    const lead = trigger.leadMinutes;
    if (typeof lead === "number" && lead > 0) leads.push(lead);
  }
  if (leads.length === 0) return null;
  // Widest lead wins: with more than one, that is the reminder a texter is
  // most likely to have already seen.
  return Math.max(...leads);
}

/**
 * Rows this tool created. The owner queues into the SAME table from the Text
 * history composer, and the dashboard lets them stack freely, so scoping on
 * `created_by` is what stops a customer asking for a reminder from cancelling
 * and overwriting the owner's birthday text to the same number.
 */
const AGENT_CREATED_BY = "sms_coworker";

/** The one pending row THIS TOOL has for the contact, if any. */
async function pendingForContact(
  businessId: string,
  phone: string,
  db: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<PendingRow | null> {
  const { data, error } = await db
    .from("scheduled_sms")
    .select("id, send_at, body")
    .eq("business_id", businessId)
    .eq("to_e164", phone)
    .eq("status", "pending")
    .eq("created_by", AGENT_CREATED_BY)
    .order("send_at", { ascending: true })
    .limit(1);
  if (error || !Array.isArray(data) || data.length === 0) return null;
  return data[0] as PendingRow;
}

/**
 * Cancel one pending row. Returns false when the write matched nothing: a
 * PostgREST update that matches zero rows reports no error, and reporting a
 * cancel that never landed is exactly the class of lie this tool exists to
 * stop.
 */
async function cancelRow(
  id: string,
  db: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<boolean> {
  const { data, error } = await db
    .from("scheduled_sms")
    .update({ status: "canceled" })
    .eq("id", id)
    .eq("status", "pending")
    .select("id");
  return !error && Array.isArray(data) && data.length > 0;
}

/** Best-effort trace on the contact; a note failure never voids the queue. */
async function pin(businessId: string, phone: string, note: string): Promise<void> {
  await appendCustomerPinnedNote(businessId, phone, note, "sms", "text");
}

export async function scheduleTextTool(
  businessId: string,
  args: ScheduleTextArgs
): Promise<ScheduleTextResult> {
  const db = await createSupabaseServiceClient();

  if (!(await smsToolsAllowedForBusiness(businessId, db))) {
    return {
      ok: false,
      detail: "tier_not_allowed",
      message:
        "Queuing a text for a later time is not available on this plan, so nothing was " +
        "scheduled. Tell the texter plainly that you cannot set up a reminder text, and " +
        "offer to have someone from the team follow up instead."
    };
  }

  const timezone = (await getBusinessTimezone(businessId, db)) ?? "UTC";
  const pending = await pendingForContact(businessId, args.phone, db);

  if (args.action === "cancel") {
    if (!pending) {
      return {
        ok: false,
        detail: "nothing_scheduled",
        message:
          "There is no text queued for this person, so nothing was canceled. Do not tell " +
          "them you canceled anything."
      };
    }
    if (!(await cancelRow(pending.id, db))) {
      return {
        ok: false,
        detail: "cancel_failed",
        message:
          "The queued text could not be canceled, so it may still go out. Say you could " +
          "not cancel it and that someone from the team will sort it out."
      };
    }
    const canceledSendAtLocal = timeLabel(pending.send_at, timezone);
    await pin(businessId, args.phone, `Canceled the reminder text queued for ${canceledSendAtLocal}.`);
    return {
      ok: true,
      data: { canceledSendAtLocal },
      message: "Canceled. Confirm to them that the reminder text will not go out."
    };
  }

  const text = (args.text ?? "").trim();
  if (!args.sendAtIso || text.length === 0) {
    return {
      ok: false,
      detail: "invalid_args",
      message: "To queue a text you must pass both sendAtIso and the exact text to send."
    };
  }

  // A naive "2026-08-31T18:30:00" parses fine and is read as the SERVER's
  // local time (UTC in production), so a 6:30 PM Eastern reminder would queue
  // four hours early instead of being refused. The offset is mandatory.
  const sendAtMs = /(Z|[+-]\d{2}:?\d{2})$/.test(args.sendAtIso.trim())
    ? Date.parse(args.sendAtIso)
    : Number.NaN;
  if (!Number.isFinite(sendAtMs)) {
    return {
      ok: false,
      detail: "invalid_time",
      message:
        "sendAtIso must be an ISO 8601 date-time WITH a timezone offset, for example " +
        "2026-08-31T18:30:00-04:00. Work the offset out from the date/time line in your context."
    };
  }
  const nowMs = Date.now();
  if (sendAtMs < nowMs + SCHEDULED_SMS_MIN_LEAD_MS) {
    return {
      ok: false,
      detail: "too_soon",
      message:
        "That time is not far enough ahead to queue; it must be at least a minute out. " +
        "If they want something now, just say it in your reply."
    };
  }
  if (sendAtMs > nowMs + SCHEDULED_SMS_MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000) {
    return {
      ok: false,
      detail: "too_far",
      message: `That time is more than ${SCHEDULED_SMS_MAX_DAYS_AHEAD} days out; ask for a nearer time.`
    };
  }

  // Fail closed on the STOP list, same posture as every other outbound path.
  const optOut = await checkSmsOptOut(businessId, args.phone, db);
  if (!optOut.ok) {
    return {
      ok: false,
      detail: "opt_out_unknown",
      message:
        "The do-not-text list could not be checked, so nothing was queued. Do not promise " +
        "a later text; offer to have someone from the team follow up."
    };
  }
  if (optOut.optedOut) {
    return {
      ok: false,
      detail: "opted_out",
      message:
        "This person has opted out of texts from this business, so nothing can be queued " +
        "for them. Do not promise them a reminder."
    };
  }

  // Only ask about the tenant's automatic reminder the FIRST time. A pending
  // row means this texter already heard about it and said yes, so moving that
  // reminder ("make it 6:45") must not re-open a settled question, which is
  // exactly what a reschedule does on a tenant that runs one.
  if (!args.confirmed && !pending) {
    const leadMinutes = await automaticReminderLeadMinutes(businessId, db);
    if (leadMinutes !== null) {
      return {
        ok: false,
        detail: "automatic_reminder_exists",
        data: { leadMinutes },
        message:
          `An automatic reminder already goes out ${leadMinutes} minutes before appointments ` +
          "here, and it cannot be switched off for one person. Tell them that reminder is " +
          "already coming, ask whether they ALSO want the extra text at the time they asked " +
          "for, and only call this tool again with confirmed true if they say yes.",
      };
    }
  }

  // Insert BEFORE retiring the old row. Cancelling first would mean a failed
  // insert leaves the texter with NOTHING where they had a standing reminder,
  // while the tool reports the failure and the model tells them it is not set.
  const sendAtIso = new Date(sendAtMs).toISOString();
  const { data: insertedRow, error } = await db
    .from("scheduled_sms")
    .insert({
      business_id: businessId,
      to_e164: args.phone,
      body: text,
      send_at: sendAtIso,
      created_by: AGENT_CREATED_BY
    })
    .select("id")
    .single();
  if (error || !insertedRow) {
    return {
      ok: false,
      detail: "queue_failed",
      message:
        "The text could not be queued. Say plainly that you could not set the reminder up " +
        "and that someone from the team will follow up; never say it is scheduled."
    };
  }

  // One queued text per contact: the new row replaces the old one.
  let replacedSendAtLocal: string | undefined;
  if (pending) {
    if (await cancelRow(pending.id, db)) {
      replacedSendAtLocal = timeLabel(pending.send_at, timezone);
    } else {
      // The old row would not retire. Rather than leave the texter with two
      // live sends, retire the one just made and say plainly it did not move.
      await cancelRow((insertedRow as { id: string }).id, db);
      return {
        ok: false,
        detail: "move_failed",
        message:
          "The reminder could not be moved, so the one already queued for " +
          `${timeLabel(pending.send_at, timezone)} still stands. Tell them ` +
          "the new time did not take and that the original reminder is unchanged."
      };
    }
  }

  const sendAtLocal = timeLabel(sendAtIso, timezone);
  const preview = text.length > PINNED_BODY_PREVIEW ? `${text.slice(0, PINNED_BODY_PREVIEW)}...` : text;
  await pin(
    businessId,
    args.phone,
    `Wants a text at ${sendAtLocal}${
      replacedSendAtLocal ? ` (moved from ${replacedSendAtLocal})` : ""
    }. Queued: "${preview}"`
  );

  return {
    ok: true,
    data: { sendAtLocal, ...(replacedSendAtLocal ? { replacedSendAtLocal } : {}) },
    message:
      "Queued. Confirm the time back to them by quoting sendAtLocal exactly, timezone " +
      "included. This is the only text queued for them; scheduling again would move it."
  };
}
