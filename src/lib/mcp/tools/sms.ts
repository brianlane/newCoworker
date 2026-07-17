/**
 * send_sms — the Claude connector's outbound text tool.
 *
 * Reuses the EXACT metered send path as the dashboard compose box and the
 * public REST API (`sendTelnyxSms` with `meterBusinessId`), so monthly SMS
 * caps and per-second throttles apply identically no matter which surface
 * initiated the send. Logged to `sms_outbound_log` with source 'mcp' so
 * the message renders in the owner's thread view attributed to Claude.
 */

import { z } from "zod";
import {
  McpToolError,
  requireMcpBusinessRole,
  resolveMcpBusinessId
} from "@/lib/mcp/auth";
import { defineMcpTool } from "@/lib/mcp/tooling";
import { normalizePhoneArg } from "@/lib/mcp/tools/read";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";

// Same ceiling as the public REST API's send endpoint: above any human
// pace, below anything that could drain a monthly SMS pool in one hour.
const MCP_SMS_SEND_RATE = { interval: 60 * 1000, maxRequests: 60 };

export const sendSmsTool = defineMcpTool({
  name: "send_sms",
  description:
    "Send a text message to a customer from the business's phone number. Counts against the business's monthly SMS quota exactly like a dashboard send; the message appears in the owner's Text history.",
  schema: {
    business_id: z
      .string()
      .uuid()
      .optional()
      .describe("Business to send from. Optional when the account has exactly one business."),
    to: z.string().describe("Recipient phone number (any common format)."),
    text: z.string().min(1).max(1600).describe("Message body (1600 chars max).")
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "operate_messages");
    const to = normalizePhoneArg(args.to);

    const limiter = rateLimit(`mcp-sms:${businessId}`, MCP_SMS_SEND_RATE);
    if (!limiter.success) {
      throw new McpToolError("SMS rate limit exceeded — retry in a minute.");
    }

    const db = await createSupabaseServiceClient();
    const { getTelnyxMessagingForBusiness, sendTelnyxSms } = await import(
      "@/lib/telnyx/messaging"
    );
    // resolveRcs: connector sends are customer-facing, same as dashboard compose.
    const config = await getTelnyxMessagingForBusiness(businessId, db, { resolveRcs: true });

    let telnyxMessageId: string;
    let channel: "sms" | "rcs";
    try {
      ({ id: telnyxMessageId, channel } = await sendTelnyxSms(config, to, args.text, {
        meterBusinessId: businessId
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new McpToolError(`Could not send: ${message}`.slice(0, 300));
    }

    // Best-effort log — the SMS already went out; a failed insert only means
    // the thread view misses the row (same policy as the dashboard compose).
    const { error: logErr } = await db.from("sms_outbound_log").insert({
      business_id: businessId,
      to_e164: to,
      from_e164: config.fromE164 ?? null,
      body: args.text,
      source: "mcp",
      run_id: null,
      flow_id: null,
      telnyx_message_id: telnyxMessageId,
      channel
    });
    if (logErr) {
      const { logger } = await import("@/lib/logger");
      logger.error("mcp sms: outbound log insert failed", {
        businessId,
        error: logErr.message
      });
    }

    return { sent: true, to, message_id: telnyxMessageId, channel };
  }
});

export const sendWhatsAppTool = defineMcpTool({
  name: "send_whatsapp",
  description:
    "Send a WhatsApp message to a customer from the business's connected WhatsApp Business number. Inside the recipient's 24-hour conversation window the text goes out as written; outside it, an approved template carries the message (Meta bills the business per template message). Fails with guidance when WhatsApp isn't connected.",
  schema: {
    business_id: z
      .string()
      .uuid()
      .optional()
      .describe("Business to send from. Optional when the account has exactly one business."),
    to: z.string().describe("Recipient phone number (any common format)."),
    text: z.string().min(1).max(1600).describe("Message body (1600 chars max).")
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "operate_messages");
    const to = normalizePhoneArg(args.to);

    const limiter = rateLimit(`mcp-whatsapp:${businessId}`, MCP_SMS_SEND_RATE);
    if (!limiter.success) {
      throw new McpToolError("WhatsApp rate limit exceeded — retry in a minute.");
    }

    const { deliverWhatsApp } = await import("@/lib/whatsapp/deliver");
    const delivered = await deliverWhatsApp({
      businessId,
      to,
      text: args.text,
      audience: "contact"
    });
    if (!delivered.ok) {
      if (delivered.reason === "not_connected") {
        throw new McpToolError(
          "WhatsApp is not connected for this business — connect it under Dashboard → Integrations → WhatsApp Business."
        );
      }
      if (delivered.reason === "template_not_approved") {
        throw new McpToolError(
          "The recipient hasn't messaged on WhatsApp in the last 24 hours and the message template is still in Meta review — use send_sms instead."
        );
      }
      throw new McpToolError(
        `Could not send: ${delivered.reason}${delivered.detail ? ` (${delivered.detail})` : ""}`.slice(
          0,
          300
        )
      );
    }

    return { sent: true, to, message_id: delivered.messageId, via: delivered.via };
  }
});

export const smsTools = [sendSmsTool, sendWhatsAppTool];
