import crypto from "node:crypto";
import { z } from "zod";
import { NextResponse } from "next/server";
import { resolveRowboatWebhookClaims } from "@/lib/rowboat/webhook-jwt";
import { resolveBusinessIdForRowboatProject } from "@/lib/db/vps-gateway-tokens";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import type { AgentKey } from "@/lib/agent-tools/registry";
import {
  appendCustomerPinnedNote,
  lookupCustomerByPhone,
  setCustomerDisplayName,
  E164_RE
} from "@/lib/customer-tools/handlers";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { sendFromOwnerMailbox } from "@/lib/email/owner-mailbox";
import { normalizeRecipients } from "@/lib/email/recipients";
import { recordOutboundAssistantEmail } from "@/lib/db/email-log";
import { lookupBusinessKnowledge } from "@/lib/knowledge-tools/handlers";
import { captureWebchatLead } from "@/lib/webchat/lead-capture";
import { findCalendarSlots, bookCalendarAppointment } from "@/lib/calendar-tools/handlers";
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
  aspectRatio: z.string().max(10).optional()
});
const smsGenerateImageArgsSchema = z.object({
  prompt: z.string().min(1).max(2000),
  phone: phoneSchema,
  caption: z.string().max(500).optional()
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

type ToolResult = { ok: boolean; detail?: string; data?: unknown };

/**
 * toolName → the Settings → Coworker tools toggle that gates it, plus the
 * channel recorded on customer interactions and the stamp on pinned notes.
 * The `dashboard_`-prefixed names are the dashboard coworker's declarations
 * of the same underlying tools (see deploy-client.sh workflow seed).
 */
const CUSTOMER_TOOL_SURFACES: Record<
  string,
  { agentKey: AgentKey; channel: "sms" | "dashboard"; stamp: string }
> = {
  customer_lookup_by_phone: { agentKey: "sms", channel: "sms", stamp: "text" },
  customer_set_display_name: { agentKey: "sms", channel: "sms", stamp: "text" },
  customer_append_pinned_note: { agentKey: "sms", channel: "sms", stamp: "text" },
  dashboard_customer_lookup_by_phone: { agentKey: "dashboard", channel: "dashboard", stamp: "dashboard" },
  dashboard_customer_set_display_name: { agentKey: "dashboard", channel: "dashboard", stamp: "dashboard" },
  dashboard_customer_append_pinned_note: { agentKey: "dashboard", channel: "dashboard", stamp: "dashboard" }
};

/** Strips the surface prefix: dashboard_customer_lookup_by_phone → customer_lookup_by_phone. */
function baseToolKey(name: string): string {
  if (name.startsWith("dashboard_")) return name.slice("dashboard_".length);
  if (name.startsWith("webchat_")) return name.slice("webchat_".length);
  return name;
}

const TOOL_GATES: Record<string, { agentKey: AgentKey; toolKey: string }> = {
  send_sms: { agentKey: "dashboard", toolKey: "send_sms" },
  // Marketplace parity (all tools on all workers): the texting coworker
  // declares the bare names, the dashboard coworker its `dashboard_` twins —
  // same cores, separate Settings toggles.
  send_email: { agentKey: "sms", toolKey: "send_email" },
  generate_image: { agentKey: "sms", toolKey: "generate_image" },
  dashboard_generate_image: { agentKey: "dashboard", toolKey: "generate_image" },
  business_knowledge_lookup: { agentKey: "sms", toolKey: "business_knowledge_lookup" },
  calendar_find_slots: { agentKey: "sms", toolKey: "calendar_find_slots" },
  calendar_book_appointment: { agentKey: "sms", toolKey: "calendar_book_appointment" },
  dashboard_business_knowledge_lookup: {
    agentKey: "dashboard",
    toolKey: "business_knowledge_lookup"
  },
  dashboard_calendar_find_slots: { agentKey: "dashboard", toolKey: "calendar_find_slots" },
  dashboard_calendar_book_appointment: {
    agentKey: "dashboard",
    toolKey: "calendar_book_appointment"
  },
  // Website chat widget (anonymous internet surface): info + lead gen ONLY.
  // This is the COMPLETE `webchat_*` allowlist — the WebchatCoworker agent
  // seed declares exactly these names, and because TOOL_GATES doubles as the
  // dispatch allowlist, no webchat-prefixed name can ever resolve to SMS,
  // email, call, or image-generation fulfilment. Keep it that way: when new
  // side-effect tools land on other surfaces, do NOT mint webchat_ twins.
  webchat_business_knowledge_lookup: {
    agentKey: "webchat",
    toolKey: "business_knowledge_lookup"
  },
  webchat_capture_lead: { agentKey: "webchat", toolKey: "capture_lead" },
  webchat_calendar_find_slots: { agentKey: "webchat", toolKey: "calendar_find_slots" },
  webchat_calendar_book_appointment: {
    agentKey: "webchat",
    toolKey: "calendar_book_appointment"
  },
  ...Object.fromEntries(
    Object.entries(CUSTOMER_TOOL_SURFACES).map(([name, surface]) => [
      name,
      { agentKey: surface.agentKey, toolKey: baseToolKey(name) }
    ])
  )
};

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
      return lookupBusinessKnowledge(businessId, parsed.data.question);
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
      // attendee phone explicitly.
      return bookCalendarAppointment(businessId, parsed.data, null);
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
        return generateImageForDashboard(
          businessId,
          parsed.data.prompt,
          normalizeAspectRatio(parsed.data.aspectRatio)
        );
      }
      const parsed = smsGenerateImageArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      return generateImageForSms(
        businessId,
        parsed.data.prompt,
        parsed.data.phone,
        parsed.data.caption
      );
    }
    case "send_sms": {
      const parsed = sendSmsArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      // Assistant → customer message: eligible tenants go RCS-first w/ SMS fallback.
      const config = await getTelnyxMessagingForBusiness(businessId, undefined, {
        resolveRcs: true
      });
      try {
        const { id: messageId } = await sendTelnyxSms(config, parsed.data.toE164, parsed.data.body, {
          meterBusinessId: businessId
        });
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
