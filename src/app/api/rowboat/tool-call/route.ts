import crypto from "node:crypto";
import { z } from "zod";
import { NextResponse } from "next/server";
import { verifyRowboatWebhookJwt } from "@/lib/rowboat/webhook-jwt";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import type { AgentKey } from "@/lib/agent-tools/registry";
import {
  appendCustomerPinnedNote,
  lookupCustomerByPhone,
  setCustomerDisplayName,
  E164_RE
} from "@/lib/customer-tools/handlers";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
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
 * but NOT which agent invoked it, so each tool maps to the surface that
 * owns its toggle — customer-memory tools to the texting coworker (`sms`),
 * `send_sms` to the dashboard coworker. The voice path never crosses this
 * endpoint (the bridge posts /api/voice/tools/* directly), so the `voice`
 * toggles stay independent.
 *
 * Responses are HTTP 200 even for failures (`{ ok:false, detail }`):
 * Rowboat treats non-2xx as a thrown error that can wedge the turn, while
 * a structured failure lets the model explain the problem to the user.
 * Only authentication problems hard-fail with 401.
 */

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

type ToolResult = { ok: boolean; detail?: string; data?: unknown };

/** toolName → the Settings → Coworker tools toggle that gates it. */
const TOOL_GATES: Record<string, { agentKey: AgentKey; toolKey: string }> = {
  customer_lookup_by_phone: { agentKey: "sms", toolKey: "customer_lookup_by_phone" },
  customer_set_display_name: { agentKey: "sms", toolKey: "customer_set_display_name" },
  customer_append_pinned_note: { agentKey: "sms", toolKey: "customer_append_pinned_note" },
  send_sms: { agentKey: "dashboard", toolKey: "send_sms" }
};

async function dispatch(businessId: string, name: string, args: unknown): Promise<ToolResult> {
  switch (name) {
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
      return setCustomerDisplayName(businessId, parsed.data.phone, displayName, "sms");
    }
    case "customer_append_pinned_note": {
      const parsed = pinNoteArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      const note = parsed.data.note.trim();
      if (!note) return { ok: false, detail: "invalid_args:note empty" };
      // Stamp "via chat": this path serves both the texting and dashboard
      // coworkers and the payload cannot distinguish them.
      return appendCustomerPinnedNote(businessId, parsed.data.phone, note, "sms", "chat");
    }
    case "send_sms": {
      const parsed = sendSmsArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
      }
      const config = await getTelnyxMessagingForBusiness(businessId);
      try {
        const messageId = await sendTelnyxSms(config, parsed.data.toE164, parsed.data.body, {
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
    default:
      return { ok: false, detail: "unknown_tool" };
  }
}

export async function POST(request: Request) {
  const jwt = request.headers.get("x-signature-jwt") ?? "";
  const claims = verifyRowboatWebhookJwt(jwt);
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

  const businessId = claims.projectId;
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

  const gate = TOOL_GATES[name];
  if (gate) {
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
