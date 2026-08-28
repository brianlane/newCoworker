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
import { scheduleCaptureOwnerRuleInline } from "@/lib/dashboard-chat/schedule-memory-capture";
import { listMessagesForCustomer } from "@/lib/db/sms-history";
import {
  runOwnerSurfaceTurn,
  type OwnerSurfaceTurnMessage
} from "@/lib/owner-surfaces/run-turn";
import { SMS_SURFACE_BLOCK, ownerTurnSurface } from "@/lib/owner-surfaces/turn-surfaces";
import { fulfillOwnerEmailBlocks } from "@/lib/dashboard-chat/email-blocks";
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
    // Continuity: the recent SMS exchange with the owner's number (both
    // directions, inbound texts, AI replies, and logged outbound sends).
    // This is the one genuinely SMS-shaped part of the turn, which is why
    // it stays here: the shared runner takes a role-tagged transcript, and
    // SMS stores a DIRECTION-tagged one that has to be mapped and deduped
    // first.
    let history: OwnerSurfaceTurnMessage[] = [];
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
      history = tail.map((m) => ({
        role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
        content: m.content
      }));
    } catch (err) {
      logger.warn("owner-sms-turn: transcript read failed", {
        businessId: body.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    // The runner answers the LAST row and replays everything before it, so
    // the message we were called with goes on the end.
    history.push({ role: "user", content: body.text });

    const outcome = await runOwnerSurfaceTurn({
      businessId: body.businessId,
      surfaceKey: "sms",
      // This route is only ever called after telnyx-sms-inbound has
      // classified the sender as the owner from their known number, so the
      // speaker is established server-side before we get here.
      speaker: { kind: "owner", name: body.ownerName ?? null, readFailed: false },
      speakerRef: body.ownerE164,
      history,
      speakerLabel: "Owner",
      userLabel: "SMS from owner",
      // Kept verbatim rather than taking the runner's generic
      // `sms-owner-operator` default: this string is what the MCP bridge
      // files against every tool call made by text, and renaming it would
      // silently split the audit trail at the deploy.
      bridgeUserId: "owner-sms-operator"
    });

    if (outcome.kind === "over_cap") {
      // Same fuse posture as the dashboard route: over the shared AI cap
      // this surface refuses (ok:false), and the SMS worker's Rowboat
      // fallback owns the local-model degrade.
      return NextResponse.json({ ok: false, detail: "over_cap" });
    }
    if (outcome.kind === "silent") {
      // Unreachable in production, and worth a loud line if it ever fires.
      // telnyx-sms-inbound reads the same coworker_staff_mode row BEFORE
      // queueing and persists a suppressed `done` job when staff replies
      // are off, so this job is never claimed in the first place. Reaching
      // here means the Deno gate and this one disagree, which is a wiring
      // bug rather than a runtime condition.
      logger.error("owner-sms-turn: staff mode off reached the turn route", {
        businessId: body.businessId
      });
      return NextResponse.json({ ok: false, detail: outcome.reason });
    }
    if (outcome.kind === "failed") {
      return NextResponse.json({ ok: false, detail: outcome.detail });
    }
    // Fulfil EMAIL_SEND blocks BEFORE the SMS clip: the raw JSON must never
    // reach the owner's phone, and a clip applied first could truncate a
    // block into an unparseable fragment that then leaks verbatim. That is
    // exactly why the runner hands back `unclipped` alongside the clipped
    // reply: fulfil against the whole answer, then clip what comes out.
    const emailOutcome = await fulfillOwnerEmailBlocks({
      businessId: body.businessId,
      content: outcome.unclipped,
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
