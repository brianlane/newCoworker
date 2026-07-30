/**
 * Internal AiFlow adapter: organize one email (label / move / archive /
 * mark read) in a connected Gmail/Outlook mailbox or the AI coworker's
 * email_log row.
 *
 * Auth is gateway-only (ROWBOAT_GATEWAY_TOKEN). Connection lookups are
 * scoped by businessId so the worker cannot touch another tenant's mail.
 */
import { z } from "zod";
import {
  gatewayBusinessGuard,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { organizeMessage } from "@/lib/email/organize";
import { logger } from "@/lib/logger";
import { recordSystemLog } from "@/lib/db/system-logs";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  connectionId: z.string().uuid().optional(),
  messageId: z.string().min(1).max(500).optional(),
  emailLogId: z.string().uuid().optional(),
  actions: z.object({
    markRead: z.boolean().optional(),
    markUnread: z.boolean().optional(),
    archive: z.boolean().optional(),
    unarchive: z.boolean().optional(),
    addLabels: z.array(z.string().min(1).max(120)).max(20).optional(),
    removeLabels: z.array(z.string().min(1).max(120)).max(20).optional(),
    moveToFolder: z.string().min(1).max(120).optional()
  })
});

export async function POST(request: Request) {
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    const detail =
      err instanceof z.ZodError ? err.issues[0]?.message ?? "invalid args" : "invalid body";
    return voiceToolValidationError(detail);
  }

  const bindGuard = await gatewayBusinessGuard(request, body.businessId);
  if (bindGuard) return bindGuard;

  try {
    const result = await organizeMessage({
      businessId: body.businessId,
      connectionId: body.connectionId,
      messageId: body.messageId,
      emailLogId: body.emailLogId,
      actions: body.actions
    });
    if (!result.ok) {
      return voiceToolResponse({ ok: false, detail: result.detail });
    }
    return voiceToolResponse({
      ok: true,
      data: { provider: result.provider }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("aiflows/organize-email failed", {
      businessId: body.businessId,
      error: message
    });
    await recordSystemLog({
      businessId: body.businessId,
      source: "aiflow",
      level: "error",
      event: "ai_flow_organize_email_failed",
      message: `Email organize failed: ${message}`,
      payload: {
        connection_id: body.connectionId ?? null,
        message_id: body.messageId ?? null,
        email_log_id: body.emailLogId ?? null
      }
    });
    return voiceToolResponse({ ok: false, detail: "organize_failed" }, 500);
  }
}
