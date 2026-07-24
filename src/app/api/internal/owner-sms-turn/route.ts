/**
 * Owner-operator turn over SMS — the dashboard-chat inline engine, reached
 * from the SMS pipeline.
 *
 * When the business OWNER texts their own business line, the SMS worker
 * historically ran the turn on the Rowboat staff persona, whose tool
 * surface deliberately excludes send_sms (customers must never trigger
 * arbitrary outbound texts) — so "can you text Uday a confirmation?" could
 * only escalate via notify_team… straight back to the owner who asked (KYP
 * Ads, Jul 16). The Rowboat tool webhook carries no sender context, so
 * owner-only tools CANNOT be gated safely on that path.
 *
 * This route is the safe path: the platform executes the turn itself
 * (runInlineChatTurn — the same engine, prompt blocks, Settings gates, and
 * action tools as dashboard chat, including send_sms, calendar lifecycle,
 * and list/run AiFlows), with the owner's identity established server-side
 * by the caller (telnyx-sms-inbound already classifies staff_kind="owner"
 * from the owner's known number before the job is queued).
 *
 * Auth: platform-internal — the SMS worker presents the gateway bearer;
 * verified per-business exactly like the other worker→app calls
 * (gatewayBusinessGuard). POST { businessId, ownerE164, ownerName?, text }
 * → { ok, reply } (ok:false ⇒ the worker falls back to the Rowboat staff
 * path, so a platform hiccup never silences the owner).
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { gatewayBusinessGuard } from "@/lib/voice-tools/common";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import { getPublicWhatsAppConnection } from "@/lib/db/whatsapp-connections";
import { getChatSpendSnapshotForBusiness } from "@/lib/db/chat-usage";
import type { PlanTier } from "@/lib/plans/tier";
import { runInlineChatTurn } from "@/lib/dashboard-chat/inline-turn";
import {
  buildBusinessContextBlock,
  buildIntegrationsStatusLine
} from "@/lib/dashboard-chat/context-blocks";
import { scheduleCaptureOwnerRuleInline } from "@/lib/dashboard-chat/schedule-memory-capture";
import { listMessagesForCustomer } from "@/lib/db/sms-history";
import { OWNER_PREAMBLE } from "@/app/api/dashboard/chat/route";
import { logger } from "@/lib/logger";
import { currentDateTimeLine } from "../../../../../supabase/functions/_shared/datetime_line";

export const dynamic = "force-dynamic";
// Same worst-case budget as dashboard chat (tool loops); the SMS worker
// applies its own shorter wait and falls back if we exceed it.
export const maxDuration = 300;

const bodySchema = z.object({
  businessId: z.string().uuid(),
  ownerE164: z.string().min(5).max(32),
  ownerName: z.string().max(200).nullish(),
  text: z.string().trim().min(1).max(4000)
});

/** SMS replies must fit texting: hard clip as the last resort. */
const SMS_REPLY_MAX_CHARS = 1200;

/** Recent owner-thread messages replayed for continuity. */
const OWNER_SMS_TAIL_MESSAGES = 12;

// Exported for the live-AI e2e suite (tests/e2e/kyp-owner-sms-operator):
// the replay must run against the EXACT production string, not a paraphrase
// (same convention as sms_prompt_lines.ts / the exported OWNER_PREAMBLE).
export const SMS_SURFACE_BLOCK = `THIS CONVERSATION IS OVER SMS. You are texting with the OWNER on their own phone (identity verified by the platform from their number, do not ask them to prove who they are). Everything in OWNER MODE applies here exactly as on the dashboard.
- Keep replies SHORT and plain-text: no markdown, no bullets unless truly needed, well under ${SMS_REPLY_MAX_CHARS} characters.
- You HAVE working tools on this surface (texting, calendar, running automations, editing automations). Use them per your rules; never claim you can't act just because this is SMS.
- When you need a decision (e.g. presenting options), ask ONE clear question and wait for their reply.`;

export async function POST(request: Request) {
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ ok: false, detail: "invalid_body" }, { status: 400 });
  }

  const guard = await gatewayBusinessGuard(request, body.businessId);
  if (guard) return guard;

  try {
    const meta = await readBusinessMeta(body.businessId);

    // Same fuse posture as the dashboard route: over the shared AI cap this
    // surface refuses (ok:false), and the SMS worker's Rowboat fallback owns
    // the local-model degrade. The read fails OPEN (quality over fuse on a
    // transient DB blip).
    const spend = await getChatSpendSnapshotForBusiness(
      body.businessId,
      undefined,
      meta.tier
    ).catch(() => null);
    if (spend !== null && spend.spendMicros >= spend.effectiveCapMicros) {
      return NextResponse.json({ ok: false, detail: "over_cap" });
    }

    // Same per-turn reads as the dashboard chat route (identical gates).
    const [
      knowledgeToolEnabled,
      smsToolEnabled,
      whatsappToolEnabled,
      calFindEnabled,
      calBookEnabled,
      calRescheduleEnabled,
      calCancelEnabled,
      runAiflowEnabled,
      editAiflowEnabled,
      notificationPrefsToolEnabled,
      flagSpamToolEnabled,
      integrationsLine,
      businessContextBlock
    ] = await Promise.all([
      isAgentToolEnabled(body.businessId, "dashboard", "business_knowledge_lookup"),
      isAgentToolEnabled(body.businessId, "dashboard", "send_sms"),
      isAgentToolEnabled(body.businessId, "dashboard", "send_whatsapp"),
      isAgentToolEnabled(body.businessId, "dashboard", "calendar_find_slots"),
      isAgentToolEnabled(body.businessId, "dashboard", "calendar_book_appointment"),
      isAgentToolEnabled(body.businessId, "dashboard", "calendar_reschedule_appointment"),
      isAgentToolEnabled(body.businessId, "dashboard", "calendar_cancel_appointment"),
      isAgentToolEnabled(body.businessId, "dashboard", "run_aiflow"),
      isAgentToolEnabled(body.businessId, "dashboard", "edit_aiflow"),
      isAgentToolEnabled(body.businessId, "dashboard", "update_notification_preferences"),
      isAgentToolEnabled(body.businessId, "dashboard", "flag_contact_spam"),
      buildIntegrationsStatusLine(body.businessId),
      buildBusinessContextBlock(body.businessId)
    ]);

    // Continuity: the recent SMS exchange with the owner's number (both
    // directions — inbound texts, AI replies, and logged outbound sends).
    let transcript = "";
    try {
      const messages = await listMessagesForCustomer(body.businessId, body.ownerE164, {
        limit: OWNER_SMS_TAIL_MESSAGES
      });
      // The in-flight inbound job is usually already stored, so the current
      // message would otherwise appear twice (transcript + user turn) —
      // drop trailing inbound copies of it.
      const tail = messages.slice(-OWNER_SMS_TAIL_MESSAGES);
      while (
        tail.length > 0 &&
        tail[tail.length - 1].direction === "inbound" &&
        tail[tail.length - 1].content.trim() === body.text.trim()
      ) {
        tail.pop();
      }
      transcript = tail
        .map(
          (m) => `[${m.direction === "inbound" ? "Owner" : "Coworker"}]: ${m.content.slice(0, 500)}`
        )
        .join("\n");
    } catch (err) {
      logger.warn("owner-sms-turn: transcript read failed", {
        businessId: body.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    const ownerLine = `The texter is the business OWNER${body.ownerName ? `, ${body.ownerName}` : ""}, texting from ${body.ownerE164}.`;
    const systemInstruction = [
      OWNER_PREAMBLE,
      SMS_SURFACE_BLOCK,
      ownerLine,
      currentDateTimeLine(new Date(), meta.timezone),
      ...(integrationsLine ? [integrationsLine] : []),
      ...(businessContextBlock ? [businessContextBlock] : []),
      ...(transcript
        ? [
            `Recent SMS exchange with the owner (oldest first, ground truth for what was already said):\n${transcript}`
          ]
        : [])
    ].join("\n\n");

    const inline = await runInlineChatTurn({
      businessId: body.businessId,
      systemInstruction,
      userMessage: `[SMS from owner] ${body.text}`,
      knowledgeToolEnabled,
      // No builder UI on SMS to hand a draft card to — creation tools off,
      // so compile work can't succeed into a void (the model points the
      // owner to dashboard chat / /dashboard/aiflows for authoring instead).
      includeCreationTools: false,
      // MUST stay below the SMS worker's OWNER_SMS_TURN_TIMEOUT_MS (75s)
      // abort: the engine stops starting new steps (and thus committing new
      // tool calls) before the worker gives up and falls back to the Rowboat
      // staff reply — otherwise a slow turn could keep acting after the
      // owner already received a contradictory fallback answer.
      budgetMs: 70_000,
      actionToolGates: {
        send_sms: smsToolEnabled,
        // Same connection-aware gating as dashboard chat: never declare a
        // tool that can only fail.
        send_whatsapp:
          whatsappToolEnabled &&
          (await getPublicWhatsAppConnection(body.businessId).catch(() => null))
            ?.is_active === true,
        calendar_find_slots: calFindEnabled,
        calendar_book_appointment: calBookEnabled,
        calendar_reschedule_appointment: calRescheduleEnabled,
        calendar_cancel_appointment: calCancelEnabled,
        list_aiflows: runAiflowEnabled,
        run_aiflow: runAiflowEnabled,
        // Edits apply in place with full validation — no builder step
        // needed, so the SMS surface gets the tool too (unlike the
        // draft-card creation tools below).
        edit_aiflow: editAiflowEnabled,
        // The dashboard image tool returns an inline /api/dashboard/images
        // URL + markdown — there is nowhere to render that over SMS (the
        // texting coworker's MMS path is a different tool). Off by design.
        generate_image: false,
        // FULL toggle control: the texter is the verified OWNER (identity
        // established server-side from their number before this route is
        // called), and owners always pass manage_settings — "let me know
        // when clients text back" flips the toggle right from this thread.
        update_notification_preferences: notificationPrefsToolEnabled,
        // The texter is the verified OWNER — exactly the caller a spam
        // declaration comes from ("hes spam", KYP Jul 23 2026, was THIS
        // surface promising an action it had no tool for).
        flag_contact_spam: flagSpamToolEnabled
      }
    });

    if (!inline.ok) {
      logger.warn("owner-sms-turn: inline turn failed", {
        businessId: body.businessId,
        error: inline.error,
        detail: inline.detail
      });
      return NextResponse.json({ ok: false, detail: inline.detail ?? inline.error });
    }

    // Same silent durable-rule capture as dashboard turns — deferred via
    // after() so the capture (and its graph ingest) reliably completes on
    // Vercel instead of being frozen when the response flushes.
    scheduleCaptureOwnerRuleInline({
      businessId: body.businessId,
      ownerMessage: body.text,
      assistantReply: inline.content
    });

    return NextResponse.json({ ok: true, reply: inline.content.slice(0, SMS_REPLY_MAX_CHARS) });
  } catch (err) {
    logger.error("owner-sms-turn: unexpected error", {
      businessId: body.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return NextResponse.json({ ok: false, detail: "internal_error" }, { status: 500 });
  }
}

/** Business timezone (date line) + tier (cap sizing). Nulls on failure. */
async function readBusinessMeta(
  businessId: string
): Promise<{ timezone: string | null; tier: PlanTier | null }> {
  try {
    const db = await createSupabaseServiceClient();
    const { data } = await db
      .from("businesses")
      .select("timezone, tier")
      .eq("id", businessId)
      .maybeSingle();
    return {
      timezone: typeof data?.timezone === "string" ? data.timezone : null,
      tier: typeof data?.tier === "string" ? (data.tier as PlanTier) : null
    };
  } catch {
    return { timezone: null, tier: null };
  }
}
