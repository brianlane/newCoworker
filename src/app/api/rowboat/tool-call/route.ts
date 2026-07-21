import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NextResponse } from "next/server";
import { resolveRowboatWebhookClaims } from "@/lib/rowboat/webhook-jwt";
import { resolveBusinessIdForRowboatProject } from "@/lib/db/vps-gateway-tokens";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import {
  CUSTOMER_TOOL_SURFACES,
  TOOL_GATES,
  baseToolKey,
  toolSurface
} from "@/lib/agent-tools/rowboat-gates";
import {
  appendCustomerPinnedNote,
  lookupCustomerByPhone,
  setCustomerDisplayName,
  E164_RE
} from "@/lib/customer-tools/handlers";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { checkSmsOptOut } from "@/lib/sms/opt-outs";
import { deliverWhatsApp } from "@/lib/whatsapp/deliver";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { sendFromOwnerMailbox } from "@/lib/email/owner-mailbox";
import { normalizeRecipients } from "@/lib/email/recipients";
import { recordOutboundAssistantEmail } from "@/lib/db/email-log";
import { lookupBusinessKnowledge } from "@/lib/knowledge-tools/handlers";
import {
  listDocumentsTool,
  requestDocumentSignatureTool,
  setDocumentExpirationTool,
  shareDocumentTool,
  updateDocumentTool
} from "@/lib/documents/tool-handlers";
import { captureWebchatLead } from "@/lib/webchat/lead-capture";
import { findCalendarSlots, bookCalendarAppointment } from "@/lib/calendar-tools/handlers";
import {
  listAiFlowsTool,
  runAiFlowTool,
  runAiflowToolArgsSchema
} from "@/lib/ai-flows/manual-run-tool";
import {
  startAiFlowForContactTool,
  startAiflowForContactArgsSchema
} from "@/lib/ai-flows/agent-start-flow";
import {
  cancelCalendarAppointment,
  rescheduleCalendarAppointment
} from "@/lib/calendar-tools/reschedule";
import { insertCoworkerLog } from "@/lib/db/logs";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import {
  generateImageForDashboard,
  generateImageForSms,
  normalizeAspectRatio
} from "@/lib/image-tools/handlers";
import { logger } from "@/lib/logger";

/**
 * Rowboat project tool webhook — makes the Rowboat-mediated coworkers'
 * tools REAL.
 *
 * Every per-tenant Rowboat project is seeded (vps/scripts/deploy-client.sh)
 * with `webhookUrl` pointing here and `isWebhook: true` on its workflow
 * tools. When the texting coworker (`Coworker`/`CoworkerLocal`) or the
 * dashboard coworker (`OwnerCoworker`/`OwnerCoworkerLocal`) calls a tool,
 * Rowboat's agents runtime POSTs `{ requestId, content }` here with an
 * HS256 `x-signature-jwt` (see src/lib/rowboat/webhook-jwt.ts), and the
 * JSON we return is fed back to the model as the tool result.
 *
 * Before this endpoint existed those tools were Rowboat "placeholder"
 * tools — the model received LLM-mocked results and nothing actually
 * persisted. Now each call is fulfilled by the same cores the voice bridge
 * adapters use, and enforced against Settings → Coworker tools
 * (`agent_tool_settings`) per call.
 *
 * Agent attribution: Rowboat's webhook payload carries the project + tool
 * but NOT which agent invoked it, so the workflow gives each surface its
 * own tool names — the texting coworker declares `customer_*` and the
 * dashboard coworker declares `dashboard_customer_*` + `send_sms`. That
 * keeps the Settings toggles per-surface AND records customer interactions
 * under the right channel. The voice path never crosses this endpoint (the
 * bridge posts /api/voice/tools/* directly), so the `voice` toggles stay
 * independent.
 *
 * Responses are HTTP 200 even for failures (`{ ok:false, detail }`):
 * Rowboat treats non-2xx as a thrown error that can wedge the turn, while
 * a structured failure lets the model explain the problem to the user.
 * Only authentication problems hard-fail with 401.
 */

// Image generation runs 5–15s on the lite model; keep well within Rowboat's
// tool-call wait (the chat worker's turn timeout is 240s) but above the
// default function budget.
export const maxDuration = 60;

const bodySchema = z.object({
  requestId: z.string().min(1),
  content: z.string().min(1)
});

const contentSchema = z.object({
  toolCall: z.object({
    id: z.string(),
    type: z.literal("function"),
    function: z.object({
      name: z.string().min(1),
      arguments: z.string()
    })
  })
});

const phoneSchema = z.string().regex(E164_RE, "phone must be E.164, e.g. +15551234567");

const lookupArgsSchema = z.object({ phone: phoneSchema });
const setNameArgsSchema = z.object({ displayName: z.string().min(1).max(200), phone: phoneSchema });
const pinNoteArgsSchema = z.object({ note: z.string().min(1).max(1500), phone: phoneSchema });
const sendSmsArgsSchema = z.object({
  toE164: phoneSchema,
  body: z.string().min(1).max(1600)
});
const sendEmailArgsSchema = z.object({
  toEmail: z.string().email(),
  subject: z.string().min(1).max(150),
  bodyText: z.string().min(1).max(4000),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  bcc: z.union([z.string(), z.array(z.string())]).optional()
});
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
  // Vagaro connections only: explicit service to search.
  serviceId: z.string().max(120).optional()
});
const dashboardGenerateImageArgsSchema = z.object({
  prompt: z.string().min(1).max(2000),
  aspectRatio: z.string().max(10).optional(),
  // Source image to EDIT (uploaded/attached/previously generated): the
  // /api/dashboard/images/... URL or bare ref the model saw in conversation.
  inputImageUrl: z.string().max(300).optional()
});
const smsGenerateImageArgsSchema = z.object({
  prompt: z.string().min(1).max(2000),
  phone: phoneSchema,
  caption: z.string().max(500).optional(),
  // Source image to EDIT: the stored ref of a photo the texter sent (MMS),
  // surfaced to the model in its context notes.
  inputImageRef: z.string().max(300).optional()
});
const bookAppointmentArgsSchema = z.object({
  // offset:true — the tool description tells the model "ISO 8601 with
  // timezone offset"; the bare .datetime() only accepted trailing-Z UTC, so
  // a model following its own instructions had every booking rejected.
  startIso: z.string().datetime({ offset: true }),
  endIso: z.string().datetime({ offset: true }),
  summary: z.string().min(1).max(200),
  attendeeName: z.string().min(1).max(200),
  attendeeEmail: z.string().email().optional(),
  attendeePhone: z.string().max(32).optional(),
  notes: z.string().max(2000).optional(),
  timezone: z.string().optional(),
  // Vagaro connections only: explicit service to book.
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
const documentShareArgsSchema = z.object({
  /** Document id or (partial) title. */
  document: z.string().min(1).max(300),
  phone: phoneSchema.optional(),
  email: z.string().email().optional(),
  message: z.string().max(500).optional()
});
const documentUpdateArgsSchema = z.object({
  document: z.string().min(1).max(300),
  instruction: z.string().min(3).max(2000)
});
const documentSetExpirationArgsSchema = z.object({
  document: z.string().min(1).max(300),
  /** ISO date/datetime; omit/empty/null to clear (never expires). */
  expiresAt: z.string().max(64).nullish()
});
const documentRequestSignatureArgsSchema = z.object({
  document: z.string().min(1).max(300),
  signerName: z.string().min(1).max(200),
  phone: phoneSchema.optional(),
  email: z.string().email().optional(),
  message: z.string().max(1000).optional()
});
const notifyTeamArgsSchema = z.object({
  /** What the team needs to do, in plain language. */
  message: z.string().min(1).max(1000),
  /** Customer's name if known, so the owner knows who to get back to. */
  customerName: z.string().max(200).optional(),
  /** Customer's phone if the model knows it (the webhook has no caller context). */
  customerPhone: z.string().max(32).optional()
});

type ToolResult = { ok: boolean; detail?: string; data?: unknown; message?: string };

/**
 * Model-facing guidance attached to a failed booking (their persona says
 * nothing about failure handling, and without this the model either blames
 * "a system error" or retry-loops — Truly's lead was offered four failing
 * times in a row until he gave up). Attributed to availability, per-surface
 * escalation: the texting coworker escalates via notify_team, the website
 * widget saves the request via capture_lead, and dashboard chat just tells
 * the owner directly.
 */
function bookFailureGuidance(toolName: string, detail: string): string {
  const escalate =
    toolName === "calendar_book_appointment"
      ? "call notify_team with their preferred day/time and tell the customer a team member will confirm the appointment"
      : toolName === "webchat_calendar_book_appointment"
        ? "save their preferred day/time with capture_lead and say the team will confirm the appointment"
        : "tell the owner the booking could not be completed";
  if (detail === "calendar_not_connected") {
    return (
      "No calendar is connected, so you cannot book or promise any appointment time. " +
      `Collect the preferred day/time, then ${escalate}.`
    );
  }
  return (
    "The booking did not go through — treat that time as no longer available and " +
    "never blame a technical error. Re-check availability with the find-slots tool " +
    `and offer a fresh option. If a second booking also fails, stop offering times: ${escalate}.`
  );
}

/**
 * Model-facing guidance for failed reschedule/cancel calls — same rationale
 * as bookFailureGuidance: without it the model blames "a system error" or,
 * worse, books a SECOND event to fake a reschedule (the exact lifecycle
 * failure this tool exists to prevent). Null for details that need no
 * extra steering (e.g. invalid_window — a plain arg fix).
 */
function lifecycleFailureGuidance(detail: string, verb: "reschedule" | "cancel"): string | null {
  if (detail === "booking_not_found") {
    return (
      "No upcoming appointment was found for this person. Confirm the phone number or " +
      "email their appointment was booked under and the original time. Never book a new " +
      `appointment to fake a ${verb} — if it still can't be found, call notify_team with ` +
      "the details and tell them a team member will sort it out."
    );
  }
  if (detail === "calendar_not_connected") {
    return (
      "No calendar is connected, so you cannot change or cancel any appointment. " +
      "Call notify_team with the request and tell them a team member will handle it."
    );
  }
  if (detail === "vagaro_auth_failed") {
    return (
      `The Vagaro connection was rejected, so the appointment was NOT ${verb === "cancel" ? "canceled" : "changed"}. ` +
      "Call notify_team so the owner can reconnect Vagaro, and tell the customer a team " +
      `member will handle the ${verb === "cancel" ? "cancellation" : "change"}. Never book a ` +
      "duplicate appointment as a workaround."
    );
  }
  if (detail === "calendar_reschedule_failed" || detail === "calendar_cancel_failed") {
    return (
      `The ${verb} did not go through — never blame a technical error and never book a ` +
      "second appointment as a workaround. Call notify_team with the requested change and " +
      "tell them a team member will confirm it."
    );
  }
  return null;
}

// TOOL_GATES (the dispatch allowlist), the customer-tool surface map, and
// the name-prefix helpers moved to src/lib/agent-tools/rowboat-gates.ts so
// the seed-parity CI test can import them (a Next route module may only
// export HTTP handlers). Semantics unchanged.

async function dispatch(businessId: string, name: string, args: unknown): Promise<ToolResult> {
  const surface = CUSTOMER_TOOL_SURFACES[name];
  switch (baseToolKey(name)) {
    case "customer_lookup_by_phone": {
      const parsed = lookupArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      return lookupCustomerByPhone(businessId, parsed.data.phone);
    }
    case "customer_set_display_name": {
      const parsed = setNameArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      const displayName = parsed.data.displayName.trim();
      if (!displayName) return { ok: false, detail: "invalid_args:displayName empty" };
      return setCustomerDisplayName(businessId, parsed.data.phone, displayName, surface.channel);
    }
    case "customer_append_pinned_note": {
      const parsed = pinNoteArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      const note = parsed.data.note.trim();
      if (!note) return { ok: false, detail: "invalid_args:note empty" };
      return appendCustomerPinnedNote(
        businessId,
        parsed.data.phone,
        note,
        surface.channel,
        surface.stamp
      );
    }
    case "business_knowledge_lookup": {
      const parsed = knowledgeArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      // Owner dashboard reads as staff (sees internal docs); customer
      // surfaces read as clients.
      return lookupBusinessKnowledge(businessId, parsed.data.question, {
        audience: toolSurface(name) === "dashboard" ? "staff" : "clients"
      });
    }
    case "document_list": {
      return listDocumentsTool(businessId);
    }
    // Run-automations tools (dashboard_ names only — see TOOL_GATES): the
    // SAME cores as the inline dashboard path, so the Rowboat fallback path
    // resolves flows, refuses disabled/voice flows, and enqueues manual runs
    // byte-identically.
    case "list_aiflows": {
      return await listAiFlowsTool(businessId);
    }
    case "run_aiflow": {
      const parsed = runAiflowToolArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      return await runAiFlowTool(businessId, parsed.data);
    }
    // The texting coworker's ONLY automation tool (bare sms name — see the
    // TOOL_GATES comment): enrolls the CURRENT texter into a flow the owner
    // flagged options.agentInvocable. The core refuses everything else.
    case "start_aiflow_for_contact": {
      const parsed = startAiflowForContactArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      return await startAiFlowForContactTool(businessId, parsed.data);
    }
    case "document_share": {
      const parsed = documentShareArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      return shareDocumentTool(
        businessId,
        {
          documentRef: parsed.data.document,
          ...(parsed.data.phone ? { phone: parsed.data.phone } : {}),
          ...(parsed.data.email ? { email: parsed.data.email } : {}),
          ...(parsed.data.message ? { message: parsed.data.message } : {})
        },
        toolSurface(name)
      );
    }
    case "document_update": {
      const parsed = documentUpdateArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      return updateDocumentTool(
        businessId,
        { documentRef: parsed.data.document, instruction: parsed.data.instruction },
        toolSurface(name)
      );
    }
    case "document_set_expiration": {
      const parsed = documentSetExpirationArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      return setDocumentExpirationTool(
        businessId,
        { documentRef: parsed.data.document, expiresAt: parsed.data.expiresAt ?? null },
        toolSurface(name)
      );
    }
    case "document_request_signature": {
      const parsed = documentRequestSignatureArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      return requestDocumentSignatureTool(
        businessId,
        {
          documentRef: parsed.data.document,
          signerName: parsed.data.signerName,
          ...(parsed.data.phone ? { phone: parsed.data.phone } : {}),
          ...(parsed.data.email ? { email: parsed.data.email } : {}),
          ...(parsed.data.message ? { message: parsed.data.message } : {})
        },
        toolSurface(name)
      );
    }
    case "capture_lead": {
      const parsed = captureLeadArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      return captureWebchatLead(businessId, parsed.data);
    }
    case "calendar_find_slots": {
      const parsed = findSlotsArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      return findCalendarSlots(businessId, parsed.data);
    }
    case "calendar_book_appointment": {
      const parsed = bookAppointmentArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      // No caller context on the webhook path — the model must supply any
      // attendee phone explicitly. Guidance is scoped to the two details
      // where availability/escalation framing is TRUE: a generic book
      // failure and a missing calendar. Other failures (invalid_window,
      // Calendly link modes, ...) are not slot conflicts — telling the model
      // "the time was taken" would send it retry-looping the same mistake.
      const booked = await bookCalendarAppointment(businessId, parsed.data, null);
      if (
        !booked.ok &&
        (booked.detail === "calendar_book_failed" || booked.detail === "calendar_not_connected")
      ) {
        return { ...booked, message: bookFailureGuidance(name, booked.detail) };
      }
      return booked;
    }
    case "calendar_reschedule_appointment": {
      const parsed = rescheduleAppointmentArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      const rescheduled = await rescheduleCalendarAppointment(businessId, parsed.data, null);
      if (!rescheduled.ok && rescheduled.detail) {
        const message = lifecycleFailureGuidance(rescheduled.detail, "reschedule");
        if (message) return { ...rescheduled, message };
      }
      // Calendly cannot move an event on the invitee's behalf: the tool
      // returns the invitee's own reschedule link. Without this steering the
      // model would confirm a new time that does not exist yet.
      if (rescheduled.ok && rescheduled.detail === "reschedule_link_created") {
        return {
          ...rescheduled,
          message:
            "The appointment has NOT been moved yet. Send the customer the rescheduleLink " +
            "so they pick the new time themselves — the SAME appointment gets updated when " +
            "they finish. Never state the reschedule is done or confirm a new time."
        };
      }
      return rescheduled;
    }
    case "calendar_cancel_appointment": {
      const parsed = cancelAppointmentArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      const canceled = await cancelCalendarAppointment(businessId, parsed.data, null);
      if (!canceled.ok && canceled.detail) {
        const message = lifecycleFailureGuidance(canceled.detail, "cancel");
        if (message) return { ...canceled, message };
      }
      return canceled;
    }
    case "notify_team": {
      const parsed = notifyTeamArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      const customerPhone = parsed.data.customerPhone ?? null;
      // Dashboard log row first, so the request is visible even if every
      // notification channel is disabled or fails (mirrors the voice twin).
      const logId = randomUUID();
      const logPayload = {
        source: "sms_tool_notify_team",
        message: parsed.data.message,
        customerName: parsed.data.customerName ?? null,
        customerPhone
      };
      await insertCoworkerLog({
        id: logId,
        business_id: businessId,
        task_type: "sms",
        status: "urgent_alert",
        log_payload: logPayload
      });
      const who = parsed.data.customerName
        ? `${parsed.data.customerName}${customerPhone ? ` (${customerPhone})` : ""}`
        : customerPhone ?? "a texter";
      let notified = false;
      try {
        const { results } = await dispatchUrgentNotification({
          businessId,
          summary: `Texter follow-up needed: ${parsed.data.message}`.slice(0, 200),
          kind: "sms_team_notify",
          payload: { logId, ...logPayload },
          emailSubject: `Follow up with ${who}`,
          emailBody:
            `Your texting coworker was messaging with ${who} and promised the team ` +
            `would follow up.\n\nRequest: ${parsed.data.message}`,
          smsBody: `[Coworker] Follow up with ${who}: ${parsed.data.message}`.slice(0, 640)
        });
        notified = results.some((r) => r.status === "sent");
      } catch (err) {
        // The dashboard log row is already written; report the degraded
        // state truthfully so the model doesn't tell the texter the team
        // was reached when no channel delivered.
        logger.warn("rowboat/tool-call: notify_team dispatch failed", {
          businessId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      return { ok: true, data: { logId, notified } };
    }
    case "send_email": {
      const parsed = sendEmailArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      const ccEmails = normalizeRecipients(parsed.data.cc);
      const bccEmails = normalizeRecipients(parsed.data.bcc);
      const result = await sendFromOwnerMailbox(businessId, {
        toEmail: parsed.data.toEmail,
        subject: parsed.data.subject,
        bodyText: parsed.data.bodyText,
        ccEmails,
        bccEmails
      });
      if (!result.ok) {
        return { ok: false, detail: result.detail };
      }
      await recordOutboundAssistantEmail({
        businessId,
        toEmail: parsed.data.toEmail,
        subject: parsed.data.subject,
        bodyText: parsed.data.bodyText,
        source: "sms_assistant",
        providerMessageId: result.messageId,
        ccEmails,
        bccEmails
      });
      return { ok: true, data: { messageId: result.messageId, provider: result.provider } };
    }
    case "generate_image": {
      // Two surfaces, one base key: the dashboard twin returns an inline
      // image URL; the texting tool delivers straight to the texter as MMS.
      if (name.startsWith("dashboard_")) {
        const parsed = dashboardGenerateImageArgsSchema.safeParse(args);
        if (!parsed.success) {
          return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        return generateImageForDashboard(businessId, parsed.data.prompt, {
          aspectRatio: normalizeAspectRatio(parsed.data.aspectRatio),
          ...(parsed.data.inputImageUrl ? { inputImageRef: parsed.data.inputImageUrl } : {})
        });
      }
      const parsed = smsGenerateImageArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      return generateImageForSms(businessId, parsed.data.prompt, parsed.data.phone, {
        ...(parsed.data.caption !== undefined ? { caption: parsed.data.caption } : {}),
        ...(parsed.data.inputImageRef ? { inputImageRef: parsed.data.inputImageRef } : {})
      });
    }
    case "send_whatsapp": {
      const parsed = sendSmsArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      const delivered = await deliverWhatsApp({
        businessId,
        to: parsed.data.toE164,
        text: parsed.data.body,
        audience: "contact"
      });
      if (!delivered.ok) {
        if (delivered.reason === "not_connected") {
          return {
            ok: false,
            detail: "whatsapp_not_connected",
            message:
              "WhatsApp is not connected. Point the owner to Integrations to connect WhatsApp Business."
          };
        }
        if (delivered.reason === "template_not_approved") {
          return {
            ok: false,
            detail: "whatsapp_window_closed",
            message:
              "The recipient has not messaged on WhatsApp in the last 24 hours and the message template is still in Meta review. Offer to text them with send_sms instead."
          };
        }
        return { ok: false, detail: "whatsapp_send_failed" };
      }
      return {
        ok: true,
        data: { messageId: delivered.messageId, toE164: parsed.data.toE164, via: delivered.via }
      };
    }
    case "send_sms": {
      const parsed = sendSmsArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      // STOP-list gate (fail closed, matching the Edge send paths).
      const optOut = await checkSmsOptOut(businessId, parsed.data.toE164);
      if (!optOut.ok) {
        logger.error("rowboat/tool-call: opt-out check failed; refusing (fail closed)", {
          businessId,
          error: optOut.error
        });
        return { ok: false, detail: "opt_out_check_failed" };
      }
      if (optOut.optedOut) {
        return { ok: false, detail: "recipient_opted_out" };
      }
      // Assistant → customer message: eligible tenants go RCS-first w/ SMS fallback.
      const config = await getTelnyxMessagingForBusiness(businessId, undefined, {
        resolveRcs: true
      });
      try {
        const { id: messageId, channel } = await sendTelnyxSms(
          config,
          parsed.data.toE164,
          parsed.data.body,
          {
            meterBusinessId: businessId
          }
        );
        // Best-effort durable log so the text renders in the dashboard Text
        // history like every other outbound path. These sends used to be
        // invisible platform-side (metered but never logged) — diagnosing the
        // KYP Ads "didn't receive anything" test texts required the Telnyx
        // portal. A failed insert must not fail the tool call — the SMS
        // already went out.
        try {
          const db = await createSupabaseServiceClient();
          const { error: logErr } = await db.from("sms_outbound_log").insert({
            business_id: businessId,
            to_e164: parsed.data.toE164,
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
          logger.error("rowboat/tool-call: sms outbound log insert failed", {
            businessId,
            error: logErr instanceof Error ? logErr.message : String(logErr)
          });
        }
        return { ok: true, data: { messageId, toE164: parsed.data.toE164 } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isQuota = /Monthly SMS limit|SMS quota blocked|throttled/i.test(message);
        logger.warn("rowboat/tool-call: sms send failed", { businessId, error: message });
        return { ok: false, detail: isQuota ? "sms_quota_blocked" : "sms_send_failed" };
      }
    }
    /* v8 ignore next 3 -- unreachable: TOOL_GATES allowlists every name before dispatch. */
    default:
      return { ok: false, detail: "unknown_tool" };
  }
}

export async function POST(request: Request) {
  const jwt = request.headers.get("x-signature-jwt") ?? "";
  const claims = await resolveRowboatWebhookClaims(jwt);
  if (!claims) {
    return NextResponse.json({ ok: false, detail: "unauthorized" }, { status: 401 });
  }

  const rawBody = await request.json().catch(() => null);
  const body = bodySchema.safeParse(rawBody);
  if (!body.success) {
    return NextResponse.json({ ok: false, detail: "invalid_body" });
  }

  // The JWT binds the signature to this exact payload: bodyHash covers the
  // content string and requestId must match the signed claim, so a token
  // cannot be replayed against a different tool call within its 5-minute
  // validity window.
  const contentHash = crypto.createHash("sha256").update(body.data.content, "utf8").digest("hex");
  if (contentHash !== claims.bodyHash || body.data.requestId !== claims.requestId) {
    return NextResponse.json({ ok: false, detail: "unauthorized" }, { status: 401 });
  }

  // The JWT's projectId is `business_configs.rowboat_project_id`, which can be
  // re-pointed, so map it to the OWNING business before gating/dispatching tools
  // (the same resolver JWT verification used to pick the secret). Using the raw
  // projectId here would run a re-pointed tenant's tools against the wrong UUID.
  let businessId: string;
  try {
    businessId = await resolveBusinessIdForRowboatProject(claims.projectId);
  } catch (err) {
    logger.warn("rowboat/tool-call: project resolve failed", {
      projectId: claims.projectId,
      error: err instanceof Error ? err.message : String(err)
    });
    return NextResponse.json({ ok: false, detail: "invalid_project" });
  }
  if (!z.string().uuid().safeParse(businessId).success) {
    return NextResponse.json({ ok: false, detail: "invalid_project" });
  }

  let name = "";
  let args: unknown = {};
  try {
    const content = contentSchema.parse(JSON.parse(body.data.content));
    name = content.toolCall.function.name;
    args = JSON.parse(content.toolCall.function.arguments || "{}");
  } catch {
    return NextResponse.json({ ok: false, detail: "invalid_tool_call" });
  }

  // TOOL_GATES doubles as the allowlist: every dispatchable name has a
  // toggle, and anything else is rejected before reaching a handler.
  const gate = TOOL_GATES[name];
  if (!gate) {
    return NextResponse.json({ ok: false, detail: "unknown_tool" });
  }
  const enabled = await isAgentToolEnabled(businessId, gate.agentKey, gate.toolKey);
  if (!enabled) {
    logger.info("rowboat/tool-call: tool disabled", { businessId, tool: name });
    return NextResponse.json({
      ok: false,
      detail: "tool_disabled",
      message:
        "The owner turned this tool off under Settings → Coworker tools. Tell them plainly instead of pretending it worked."
    });
  }

  try {
    const result = await dispatch(businessId, name, args);
    logger.info("rowboat/tool-call: dispatched", {
      businessId,
      tool: name,
      ok: result.ok,
      detail: result.detail
    });
    return NextResponse.json(result);
  } catch (err) {
    logger.warn("rowboat/tool-call: handler failed", {
      businessId,
      tool: name,
      error: err instanceof Error ? err.message : String(err)
    });
    return NextResponse.json({ ok: false, detail: "internal_error" });
  }
}
