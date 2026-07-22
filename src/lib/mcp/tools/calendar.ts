/**
 * Calendar MCP tools — thin adapters over the shared calendar core in
 * src/lib/calendar-tools/handlers.ts (the same code path the voice bridge
 * and Rowboat tool webhook use), so provider resolution (Vagaro > Nango
 * Google/Microsoft > Calendly > CalDAV) and booking semantics come free.
 */

import { z } from "zod";
import {
  McpToolError,
  requireMcpBusinessRole,
  resolveMcpBusinessId
} from "@/lib/mcp/auth";
import { defineMcpTool } from "@/lib/mcp/tooling";

const businessIdField = z
  .string()
  .uuid()
  .optional()
  .describe("Business whose calendar to use. Optional when the account has exactly one business.");

/** Model-facing failure text per calendar-core detail code. */
export function calendarFailureMessage(detail: string | undefined): string {
  if (detail === "calendar_not_connected") {
    return "No calendar is connected to this business — connect one on the Integrations page first.";
  }
  if (detail === "calendar_book_failed") {
    return "The booking did not go through — treat that time as no longer available, re-check with calendar_find_slots, and offer a fresh option.";
  }
  return `Calendar request failed${detail ? ` (${detail})` : ""}.`;
}

export const calendarFindSlotsTool = defineMcpTool({
  name: "calendar_find_slots",
  description:
    "Find open appointment slots on the business's connected calendar (Google, Microsoft 365, Calendly, Vagaro, or CalDAV). Returns up to 3 bookable start/end times.",
  schema: {
    business_id: businessIdField,
    durationMinutes: z
      .number()
      .int()
      .min(5)
      .max(480)
      .describe("Appointment length in minutes."),
    earliest: z
      .string()
      .optional()
      .describe("ISO 8601 earliest acceptable start; defaults to now."),
    latest: z
      .string()
      .optional()
      .describe("ISO 8601 latest acceptable start; defaults to 7 days after earliest."),
    purpose: z.string().max(200).optional().describe("What the appointment is for."),
    timezone: z.string().optional().describe("IANA timezone for the returned times."),
    serviceId: z
      .string()
      .max(120)
      .optional()
      .describe("Vagaro only: explicit service to search.")
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "operate_messages");
    const { findCalendarSlots } = await import("@/lib/calendar-tools/handlers");
    const result = await findCalendarSlots(businessId, {
      durationMinutes: args.durationMinutes,
      earliest: args.earliest,
      latest: args.latest,
      purpose: args.purpose,
      timezone: args.timezone,
      serviceId: args.serviceId
    });
    if (!result.ok) throw new McpToolError(calendarFailureMessage(result.detail));
    return result.data;
  }
});

export const calendarBookAppointmentTool = defineMcpTool({
  name: "calendar_book_appointment",
  description:
    "Book an appointment on the business's connected calendar. Use calendar_find_slots first and book one of the returned slots. Confirm the booked day/time from the result's startLocal field verbatim. If it fails because the person already has an upcoming appointment (attendee_already_booked), offer to keep, reschedule, or cancel the existing one instead of booking again. Note: with Calendly, this returns a single-use scheduling link to send the customer instead of a confirmed booking.",
  schema: {
    business_id: businessIdField,
    startIso: z.string().describe("Appointment start — ISO 8601 with timezone offset."),
    endIso: z.string().describe("Appointment end — ISO 8601 with timezone offset."),
    summary: z.string().min(1).max(200).describe("Calendar event title."),
    attendeeName: z.string().min(1).max(200).describe("Customer's name."),
    attendeeEmail: z.string().email().optional(),
    attendeePhone: z.string().max(32).optional(),
    notes: z.string().max(2000).optional(),
    timezone: z.string().optional().describe("IANA timezone."),
    serviceId: z
      .string()
      .max(120)
      .optional()
      .describe("Vagaro only: explicit service to book."),
    allowAdditional: z
      .boolean()
      .optional()
      .describe(
        "Set true ONLY after the customer explicitly confirmed they want an additional appointment on top of an existing upcoming one (bypasses the attendee_already_booked guard)."
      )
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "operate_messages");
    const { bookCalendarAppointment } = await import("@/lib/calendar-tools/handlers");
    const result = await bookCalendarAppointment(businessId, {
      startIso: args.startIso,
      endIso: args.endIso,
      summary: args.summary,
      attendeeName: args.attendeeName,
      attendeeEmail: args.attendeeEmail,
      attendeePhone: args.attendeePhone,
      notes: args.notes,
      timezone: args.timezone,
      serviceId: args.serviceId,
      allowAdditional: args.allowAdditional
    });
    if (!result.ok) {
      // The duplicate guard's result carries its own precise guidance
      // (existing time + keep/move/cancel options) — surface it verbatim.
      throw new McpToolError(result.message ?? calendarFailureMessage(result.detail));
    }
    return result.data;
  }
});

export const calendarTools = [calendarFindSlotsTool, calendarBookAppointmentTool];
