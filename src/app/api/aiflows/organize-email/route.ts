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
import { hasAnyOrganizeAction, organizeMessage } from "@/lib/email/organize";
import { coerceEmailImportance } from "@/lib/db/email-log";
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
    trash: z.boolean().optional(),
    star: z.boolean().optional(),
    unstar: z.boolean().optional(),
    addLabels: z.array(z.string().min(1).max(120)).max(20).optional(),
    removeLabels: z.array(z.string().min(1).max(120)).max(20).optional(),
    moveToFolder: z.string().min(1).max(120).optional(),
    /**
     * The engine's RENDERED importance template, still raw text. Accepted as a
     * loose string rather than a number because it is whatever a language model
     * emitted ("6", "6/10", "high", ""); coerceEmailImportance takes the
     * leading integer and clamps it, and anything else scores nothing.
     *
     * Parsed here rather than in the engine so the range rule lives in one
     * place, next to the column's check constraint.
     */
    importanceText: z.string().max(300).optional()
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

  // importanceText is the wire name; it is coerced here and never forwarded
  // as-is, so split it off rather than spreading it into the action bag.
  const { importanceText, ...rest } = body.actions;
  const importance = importanceText === undefined ? null : coerceEmailImportance(importanceText);
  // A flow may SET a score, never CLEAR one. An unparseable answer ("high", "")
  // means the model did not produce a number, which is not the same as the
  // owner asking for the score to be removed, and wiping a good score from
  // yesterday because today's run hiccuped would be the worse reading. The
  // explicit-null clear stays reachable from organizeMessage's own API.
  const actions = { ...rest, ...(typeof importance === "number" ? { importance } : {}) };

  // Nothing left to do. Reached when a step's ONLY instruction was a score the
  // model did not produce, which must cost the score and never the step: the
  // worker turns any !ok into a failed run step, so answering
  // `no_organize_actions` here would fail a flow over a display-only field.
  if (!hasAnyOrganizeAction(actions)) {
    return voiceToolResponse({ ok: true, data: { provider: "none", detail: "no_score" } });
  }

  try {
    const result = await organizeMessage({
      businessId: body.businessId,
      connectionId: body.connectionId,
      messageId: body.messageId,
      emailLogId: body.emailLogId,
      actions
    });
    if (!result.ok) {
      return voiceToolResponse({ ok: false, detail: result.detail });
    }
    // The detail rides the SUCCESS response too. `importance_row_not_found` is
    // a partial: the labelling landed and the score had no row to sit on. It
    // was added precisely so that miss is not silent, so dropping it one layer
    // up would put the silence straight back.
    if (result.detail?.includes("importance_row_not_found")) {
      await recordSystemLog({
        businessId: body.businessId,
        source: "aiflow",
        level: "warn",
        event: "ai_flow_email_importance_row_missing",
        message: "Organized the message but found no email_log row to score",
        payload: {
          connection_id: body.connectionId ?? null,
          message_id: body.messageId ?? null,
          email_log_id: body.emailLogId ?? null
        }
      });
    }
    return voiceToolResponse({
      ok: true,
      data: { provider: result.provider, ...(result.detail ? { detail: result.detail } : {}) }
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
