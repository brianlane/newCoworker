/**
 * The website chat widget's tool surface for the PLATFORM-SIDE Gemini
 * engine (reply_engine='gemini') — declarations + gated executor.
 *
 * This is the same restricted, fail-closed surface the box-hosted
 * WebchatCoworker gets, kept in DELIBERATE LOCKSTEP with two other layers:
 *
 *   * the Rowboat workflow seed in vps/scripts/deploy-client.sh (the
 *     `webchat_*` tool declarations — descriptions/parameters here mirror
 *     those verbatim so both engines steer the model identically), and
 *   * the `/api/rowboat/tool-call` dispatcher (TOOL_GATES + zod arg
 *     schemas + per-tool Settings enforcement + the failure-guidance copy).
 *
 * Info + lead gen ONLY: knowledge lookup, lead capture, calendar
 * find/book, inline document share. NO SMS, NO email, NO calls, NO image
 * generation — visitors are untrusted, and an unknown tool name fails
 * closed here exactly like it does on the webhook path. Do NOT add
 * side-effect tools without revisiting that threat model.
 */

import { z } from "zod";
import type { GeminiFunctionDeclaration } from "@/lib/gemini-chat";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import { lookupBusinessKnowledge } from "@/lib/knowledge-tools/handlers";
import { captureWebchatLead } from "@/lib/webchat/lead-capture";
import { findCalendarSlots, bookCalendarAppointment } from "@/lib/calendar-tools/handlers";
import { shareDocumentTool } from "@/lib/documents/tool-handlers";

export type WebchatToolResult = {
  ok: boolean;
  detail?: string;
  data?: unknown;
  message?: string;
};

/**
 * Declarations mirroring the deploy-client.sh workflow seed byte-for-byte
 * on names and near-verbatim on descriptions (the seed's descriptions are
 * apostrophe-free only because of its bash heredoc — no such constraint
 * here, but keeping them identical keeps model behavior identical).
 */
export const WEBCHAT_TOOL_DECLARATIONS: GeminiFunctionDeclaration[] = [
  {
    name: "webchat_business_knowledge_lookup",
    description:
      "Answer a website visitor question (hours, services, pricing, policies) from the business knowledge base and website summary. Use when the answer is not already in your instructions.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to answer, in plain words." }
      },
      required: ["question"]
    }
  },
  {
    name: "webchat_capture_lead",
    description:
      "Record a website visitor as a lead so the team can follow up. Call when the visitor shares contact details or asks to be contacted. Include whatever they provided — never invent details.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Visitor name, if given." },
        phone: { type: "string", description: "Visitor phone number, if given." },
        email: { type: "string", description: "Visitor email address, if given." },
        interest: {
          type: "string",
          description: "What the visitor wants — service, question, timeline."
        },
        notes: { type: "string", description: "Any other useful context from the conversation." },
        sessionRef: {
          type: "string",
          description: "The session reference from your system prompt, passed verbatim."
        }
      },
      required: []
    }
  },
  {
    name: "webchat_calendar_find_slots",
    description:
      "Find up to 3 free time ranges on the owner connected calendar for a website visitor. Use before proposing appointment times.",
    parameters: {
      type: "object",
      properties: {
        purpose: { type: "string", description: "What the appointment is for." },
        earliest: {
          type: "string",
          description: "Earliest acceptable start, ISO 8601. Defaults to now."
        },
        latest: {
          type: "string",
          description: "Latest acceptable end, ISO 8601. Defaults to 7 days out."
        },
        durationMinutes: {
          type: "number",
          description: "Appointment length in minutes. Defaults to 30."
        },
        timezone: { type: "string", description: "IANA timezone of the visitor, if known." }
      },
      required: []
    }
  },
  {
    name: "webchat_calendar_book_appointment",
    description:
      "Book an appointment on the owner connected calendar for a website visitor. This tool is the ONLY way an appointment gets created — never tell the visitor an appointment is booked unless this call returned success. Confirm the time with the visitor before booking. Times must be ISO 8601 with timezone offset. Confirm the booked day and time by quoting the result startLocal field verbatim. If it fails with detail attendee_already_booked, the visitor ALREADY has an upcoming appointment — tell them its existingStartLocal time and that the team can move or cancel it; do NOT book another one.",
    parameters: {
      type: "object",
      properties: {
        startIso: { type: "string", description: "Start time, ISO 8601." },
        endIso: { type: "string", description: "End time, ISO 8601." },
        summary: { type: "string", description: "Short event title." },
        attendeeName: { type: "string", description: "Visitor name for the event." },
        attendeeEmail: { type: "string", description: "Visitor email, if provided." },
        attendeePhone: { type: "string", description: "Visitor phone, if known." },
        notes: { type: "string", description: "Extra context for the event description." },
        timezone: { type: "string", description: "IANA timezone for the event times." }
      },
      required: ["startIso", "endIso", "summary", "attendeeName"]
    }
  },
  {
    name: "webchat_document_share",
    description:
      "Give the website visitor an expiring link to one of the client-facing business documents (price sheet, policy, contract) when they ask for a copy. Returns the link — include it in your chat reply. It never texts or emails anyone. Internal-only and expired documents are refused server-side; if the tool fails, say the team can provide a copy and never invent a link.",
    parameters: {
      type: "object",
      properties: {
        document: {
          type: "string",
          description: "The document title (or part of it) as listed in your instructions."
        }
      },
      required: ["document"]
    }
  }
];

/**
 * tool name → Settings → Coworker tools toggle. Identical mapping to the
 * `webchat_*` block of TOOL_GATES in /api/rowboat/tool-call — the same
 * owner toggle must gate BOTH engines or flipping one off would only
 * half-apply.
 */
export const WEBCHAT_ENGINE_TOOL_GATES: Record<string, { toolKey: string }> = {
  webchat_business_knowledge_lookup: { toolKey: "business_knowledge_lookup" },
  webchat_capture_lead: { toolKey: "capture_lead" },
  webchat_calendar_find_slots: { toolKey: "calendar_find_slots" },
  webchat_calendar_book_appointment: { toolKey: "calendar_book_appointment" },
  webchat_document_share: { toolKey: "document_share" }
};

// Arg schemas — mirror /api/rowboat/tool-call exactly (same bounds, same
// offset-aware datetimes) so a model prompt tuned on one engine parses
// identically on the other.
const knowledgeArgsSchema = z.object({ question: z.string().min(1).max(500) });
const captureLeadArgsSchema = z.object({
  name: z.string().max(200).optional(),
  phone: z.string().max(32).optional(),
  email: z.string().email().optional(),
  interest: z.string().max(1000).optional(),
  notes: z.string().max(2000).optional(),
  sessionRef: z.string().max(64).optional()
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
const documentShareArgsSchema = z.object({
  document: z.string().min(1).max(300)
});

/**
 * Webchat variant of the tool-call route's bookFailureGuidance: the widget
 * escalates via capture_lead (the anonymous surface must not page the
 * team). Copy kept in lockstep with the route.
 */
export function webchatBookFailureGuidance(detail: string): string {
  if (detail === "calendar_not_connected") {
    return (
      "No calendar is connected, so you cannot book or promise any appointment time. " +
      "Collect the preferred day/time, then save their preferred day/time with capture_lead " +
      "and say the team will confirm the appointment."
    );
  }
  return (
    "The booking did not go through — treat that time as no longer available and " +
    "never blame a technical error. Re-check availability with the find-slots tool " +
    "and offer a fresh option. If a second booking also fails, stop offering times: " +
    "save their preferred day/time with capture_lead and say the team will confirm the appointment."
  );
}

/** Same copy the tool-call route returns for a Settings-disabled tool. */
export const WEBCHAT_TOOL_DISABLED_MESSAGE =
  "The owner turned this tool off under Settings → Coworker tools. Tell them plainly instead of pretending it worked.";

export type WebchatToolExecutorDeps = {
  isToolEnabled?: typeof isAgentToolEnabled;
  knowledgeLookup?: typeof lookupBusinessKnowledge;
  captureLead?: typeof captureWebchatLead;
  findSlots?: typeof findCalendarSlots;
  bookAppointment?: typeof bookCalendarAppointment;
  shareDocument?: typeof shareDocumentTool;
};

/**
 * Execute one webchat tool call for the Gemini engine. Never throws for a
 * model-caused problem (bad args, unknown name, disabled tool) — those
 * come back as `{ ok:false, ... }` results the model can explain, exactly
 * matching the webhook dispatcher's contract. Handler exceptions DO
 * propagate; the engine loop maps them to `{ ok:false, detail }` so one
 * broken tool can't kill the whole turn.
 */
export async function executeWebchatEngineTool(
  businessId: string,
  name: string,
  args: unknown,
  deps: WebchatToolExecutorDeps = {}
): Promise<WebchatToolResult> {
  /* c8 ignore start -- production default handlers; tests inject explicit deps */
  const isToolEnabled = deps.isToolEnabled ?? isAgentToolEnabled;
  const knowledgeLookup = deps.knowledgeLookup ?? lookupBusinessKnowledge;
  const captureLead = deps.captureLead ?? captureWebchatLead;
  const findSlots = deps.findSlots ?? findCalendarSlots;
  const bookAppointment = deps.bookAppointment ?? bookCalendarAppointment;
  const shareDocument = deps.shareDocument ?? shareDocumentTool;
  /* c8 ignore stop */

  const gate = WEBCHAT_ENGINE_TOOL_GATES[name];
  if (!gate) {
    return { ok: false, detail: "unknown_tool" };
  }
  const enabled = await isToolEnabled(businessId, "webchat", gate.toolKey);
  if (!enabled) {
    return { ok: false, detail: "tool_disabled", message: WEBCHAT_TOOL_DISABLED_MESSAGE };
  }

  switch (name) {
    case "webchat_business_knowledge_lookup": {
      const parsed = knowledgeArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      // Customer surface reads as clients — internal docs stay invisible.
      return knowledgeLookup(businessId, parsed.data.question, { audience: "clients" });
    }
    case "webchat_capture_lead": {
      const parsed = captureLeadArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      return captureLead(businessId, parsed.data);
    }
    case "webchat_calendar_find_slots": {
      const parsed = findSlotsArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      return findSlots(businessId, parsed.data);
    }
    case "webchat_calendar_book_appointment": {
      const parsed = bookAppointmentArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      const booked = await bookAppointment(businessId, parsed.data, null);
      if (
        !booked.ok &&
        (booked.detail === "calendar_book_failed" || booked.detail === "calendar_not_connected")
      ) {
        return { ...booked, message: webchatBookFailureGuidance(booked.detail) };
      }
      return booked;
    }
    // webchat_document_share by exhaustiveness: WEBCHAT_ENGINE_TOOL_GATES
    // allowlisted the name above, and the other four cases are handled.
    default: {
      const parsed = documentShareArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      // Webchat is ALWAYS inline (no phone/email args) — the handler never
      // sends SMS/email for the webchat surface.
      return shareDocument(businessId, { documentRef: parsed.data.document }, "webchat");
    }
  }
}
