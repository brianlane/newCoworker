/**
 * Owner-operator turn over SMS, the dashboard-chat inline engine, reached
 * from the SMS pipeline.
 *
 * When the business OWNER texts their own business line, the SMS worker
 * historically ran the turn on the Rowboat staff persona, whose tool
 * surface deliberately excludes send_sms (customers must never trigger
 * arbitrary outbound texts), so "can you text Uday a confirmation?" could
 * only escalate via notify_team… straight back to the owner who asked (KYP
 * Ads, Jul 16). The Rowboat tool webhook carries no sender context, so
 * owner-only tools CANNOT be gated safely on that path.
 *
 * This route is the safe path: the platform executes the turn itself
 * (runInlineChatTurn, the same engine, prompt blocks, Settings gates, and
 * action tools as dashboard chat, including send_sms, calendar lifecycle,
 * and list/run AiFlows), with the owner's identity established server-side
 * by the caller (telnyx-sms-inbound already classifies staff_kind="owner"
 * from the owner's known number before the job is queued).
 *
 * Auth: platform-internal, the SMS worker presents the gateway bearer;
 * verified per-business exactly like the other worker→app calls
 * (gatewayBusinessGuard). POST { businessId, ownerE164, ownerName?, text }
 * → { ok, reply } (ok:false ⇒ the worker falls back to the Rowboat staff
 * path, so a platform hiccup never silences the owner).
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { gatewayBusinessGuard } from "@/lib/voice-tools/common";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getAgentToolStates } from "@/lib/db/agent-tool-settings";
import { getPublicWhatsAppConnection } from "@/lib/db/whatsapp-connections";
import { getChatSpendSnapshotForBusiness } from "@/lib/db/chat-usage";
import type { PlanTier } from "@/lib/plans/tier";
import { runInlineChatTurn } from "@/lib/dashboard-chat/inline-turn";
import {
  buildBusinessContextBlock,
  buildIntegrationsStatusLine
} from "@/lib/dashboard-chat/context-blocks";
import { scheduleCaptureOwnerRuleInline } from "@/lib/dashboard-chat/schedule-memory-capture";
import { buildMcpBridgeExtraTools } from "@/lib/dashboard-chat/mcp-bridge";
import { listMessagesForCustomer } from "@/lib/db/sms-history";
import { ownerSurfaceToolGates } from "@/lib/owner-surfaces/gates";
import { buildOwnerSurfaceSystem } from "@/lib/owner-surfaces/system";
import { SMS_SURFACE_BLOCK, ownerTurnSurface } from "@/lib/owner-surfaces/turn-surfaces";
import { fulfillOwnerEmailBlocks } from "@/lib/dashboard-chat/email-blocks";
import { bookingLinkPromptLine } from "@/lib/booking-page/prompt-line";
import { logger } from "@/lib/logger";

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

/** Recent owner-thread messages replayed for continuity. */
const OWNER_SMS_TAIL_MESSAGES = 12;

/** Prompt block, budget, gates channel: all of it lives in the registry now. */
const SURFACE = ownerTurnSurface("sms");

// Re-exported for the live-AI e2e suites (kyp-owner-sms-operator,
// beth-delegation, owner-ask-needs-flow-change), which replay the EXACT
// production string and import it from this route.
export { SMS_SURFACE_BLOCK };

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

    // Same per-turn gates as the dashboard chat route (identical semantics),
    // batched into one settings query instead of fifteen.
    const [toolStates, integrationsLine, businessContextBlock, bookingLinkLine] =
      await Promise.all([
        getAgentToolStates(body.businessId, "dashboard", [
          "business_knowledge_lookup",
          "send_sms",
          "send_whatsapp",
          "calendar_find_slots",
          "calendar_book_appointment",
          "calendar_reschedule_appointment",
          "calendar_cancel_appointment",
          "calendar_join_waitlist",
          "run_aiflow",
          "edit_aiflow",
          "update_notification_preferences",
          "flag_contact_spam",
          "set_contact_reply_mode",
          "manage_employee",
        "custom_table_read",
        "custom_table_write",
        "custom_table_manage",
          "send_email",
          "read_business_data",
          "manage_contacts",
          "manage_flows",
          "manage_agents",
          "update_business_profile",
          "update_business_knowledge",
          "manage_coworker_tools"
        ] as const),
        buildIntegrationsStatusLine(body.businessId),
        buildBusinessContextBlock(body.businessId, {}, { includeCustomTables: true }),
        // The public booking link, so "schedule Liz through her assistant"
        // can send the page instead of negotiating times over email.
        bookingLinkPromptLine(body.businessId)
      ]);
    const {
      business_knowledge_lookup: knowledgeToolEnabled,
      send_sms: smsToolEnabled,
      send_whatsapp: whatsappToolEnabled,
      calendar_find_slots: calFindEnabled,
      calendar_book_appointment: calBookEnabled,
      calendar_reschedule_appointment: calRescheduleEnabled,
      calendar_cancel_appointment: calCancelEnabled,
      calendar_join_waitlist: calWaitlistEnabled,
      run_aiflow: runAiflowEnabled,
      edit_aiflow: editAiflowEnabled,
      update_notification_preferences: notificationPrefsToolEnabled,
      flag_contact_spam: flagSpamToolEnabled,
      set_contact_reply_mode: replyModeToolEnabled,
      manage_employee: manageEmployeeToolEnabled,
      send_email: emailToolEnabled,
      custom_table_read: customTableReadEnabled,
      custom_table_write: customTableWriteEnabled,
      custom_table_manage: customTableManageEnabled
    } = toolStates;

    // MCP-bridge tools: this surface IS the verified owner (the SMS
    // pipeline classified the sender before queueing), so every per-group
    // role bar is satisfied and the gates are the Settings toggles alone.
    // The handlers still re-run requireMcpBusinessRole against the owner
    // email per call. No owner email on record ⇒ no bridge (handlers
    // could only refuse).
    const bridgeExtraTools = meta.ownerEmail
      ? buildMcpBridgeExtraTools(
          body.businessId,
          { userId: "owner-sms-operator", email: meta.ownerEmail },
          {
            read_business_data: toolStates.read_business_data,
            manage_contacts: toolStates.manage_contacts,
            manage_flows: toolStates.manage_flows,
            manage_agents: toolStates.manage_agents,
            update_business_profile: toolStates.update_business_profile,
            update_business_knowledge: toolStates.update_business_knowledge,
            manage_coworker_tools: toolStates.manage_coworker_tools
          },
          "owner"
        )
      : null;

    // Continuity: the recent SMS exchange with the owner's number (both
    // directions, inbound texts, AI replies, and logged outbound sends).
    let transcript = "";
    try {
      const messages = await listMessagesForCustomer(body.businessId, body.ownerE164, {
        limit: OWNER_SMS_TAIL_MESSAGES
      });
      // The in-flight inbound job is usually already stored, so the current
      // message would otherwise appear twice (transcript + user turn),
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

    const systemInstruction = buildOwnerSurfaceSystem({
      surface: SURFACE,
      // This route is only ever called after telnyx-sms-inbound has
      // classified the sender as the owner from their known number, so the
      // speaker is established server-side before we get here.
      speaker: { kind: "owner", name: body.ownerName ?? null, readFailed: false },
      speakerRef: body.ownerE164,
      // Email over SMS (the Beth delegation, Jul 2026): the owner texting
      // "schedule Liz through her assistant Beth" needs the SAME EMAIL_SEND
      // protocol dashboard chat teaches, or the coworker can only offer to
      // text a person who works by email.
      emailToolEnabled,
      timezone: meta.timezone,
      integrationsLine,
      bookingLinkLine,
      businessContextBlock,
      bridgeToolsDeclared: Boolean(bridgeExtraTools),
      transcript
    });

    const inline = await runInlineChatTurn({
      businessId: body.businessId,
      systemInstruction,
      userMessage: `[SMS from owner] ${body.text}`,
      knowledgeToolEnabled,
      extraTools: bridgeExtraTools,
      // Bridged read chains need headroom; the 60s budget below still
      // bounds the wall clock regardless of the step count.
      maxToolSteps: SURFACE.maxToolSteps,
      // Provenance for the definition history: an edit made by text is the
      // one an owner is least likely to remember agreeing to.
      flowEditSource: SURFACE.flowEditSource,
      flowEditActor: body.ownerE164,
      // By text the coworker can change what an automation SAYS. Changing
      // what it DOES needs the owner looking at the flow, so structural
      // edits refuse here and point at the dashboard.
      flowEditSurfaceKind: "text",
      // No builder UI on SMS to hand a draft card to, creation tools off,
      // so compile work can't succeed into a void (the model points the
      // owner to dashboard chat / /dashboard/aiflows for authoring instead).
      includeCreationTools: false,
      // MUST stay below the SMS worker's OWNER_SMS_TURN_TIMEOUT_MS (75s)
      // abort: the engine stops starting new steps (and thus committing new
      // tool calls) before the worker gives up and falls back to the Rowboat
      // staff reply, otherwise a slow turn could keep acting after the
      // owner already received a contradictory fallback answer.
      //
      // 60s, not 70s, because EMAIL_SEND fulfilment runs AFTER this returns
      // (up to 3 provider sends). At 70s a slow turn could still be mailing
      // when the worker aborts, leaving mail in flight that the owner is
      // never told about.
      budgetMs: SURFACE.budgetMs,
      actionToolGates: ownerSurfaceToolGates({
        toolStates: {
          send_sms: smsToolEnabled,
          send_whatsapp: whatsappToolEnabled,
          calendar_find_slots: calFindEnabled,
          calendar_book_appointment: calBookEnabled,
          calendar_reschedule_appointment: calRescheduleEnabled,
          calendar_cancel_appointment: calCancelEnabled,
          calendar_join_waitlist: calWaitlistEnabled,
          run_aiflow: runAiflowEnabled,
          edit_aiflow: editAiflowEnabled,
          update_notification_preferences: notificationPrefsToolEnabled,
          flag_contact_spam: flagSpamToolEnabled,
          set_contact_reply_mode: replyModeToolEnabled,
          manage_employee: manageEmployeeToolEnabled,
          custom_table_read: customTableReadEnabled,
          custom_table_write: customTableWriteEnabled,
          custom_table_manage: customTableManageEnabled
        },
        // The texter IS the verified owner: identity was established from
        // their number before this route was called.
        isOwner: true,
        // Same connection-aware gating as dashboard chat: never declare a
        // tool that can only fail.
        whatsappConnected:
          (await getPublicWhatsAppConnection(body.businessId).catch(() => null))
            ?.is_active === true
      })
    });

    if (!inline.ok) {
      logger.warn("owner-sms-turn: inline turn failed", {
        businessId: body.businessId,
        error: inline.error,
        detail: inline.detail
      });
      return NextResponse.json({ ok: false, detail: inline.detail ?? inline.error });
    }

    // Fulfil EMAIL_SEND blocks BEFORE the SMS clip: the raw JSON must never
    // reach the owner's phone, and a clip applied first could truncate a
    // block into an unparseable fragment that then leaks verbatim.
    const emailOutcome = await fulfillOwnerEmailBlocks({
      businessId: body.businessId,
      content: inline.content,
      source: "sms_assistant"
    });

    // Same silent durable-rule capture as dashboard turns, deferred via
    // after() so the capture (and its graph ingest) reliably completes on
    // Vercel instead of being frozen when the response flushes.
    scheduleCaptureOwnerRuleInline({
      businessId: body.businessId,
      ownerMessage: body.text,
      assistantReply: emailOutcome.content
    });

    return NextResponse.json({ ok: true, reply: emailOutcome.content.slice(0, SURFACE.replyMaxChars) });
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
): Promise<{ timezone: string | null; tier: PlanTier | null; ownerEmail: string | null }> {
  try {
    const db = await createSupabaseServiceClient();
    const { data } = await db
      .from("businesses")
      .select("timezone, tier, owner_email")
      .eq("id", businessId)
      .maybeSingle();
    return {
      timezone: typeof data?.timezone === "string" ? data.timezone : null,
      tier: typeof data?.tier === "string" ? (data.tier as PlanTier) : null,
      ownerEmail:
        typeof data?.owner_email === "string" && data.owner_email.trim() !== ""
          ? data.owner_email
          : null
    };
  } catch {
    return { timezone: null, tier: null, ownerEmail: null };
  }
}
