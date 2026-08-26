/**
 * WhatsApp from the business's own people.
 *
 * The bug this closes: an owner messaging their own business's WhatsApp
 * number reached the CUSTOMER sales assistant. It pitched them, asked for
 * their contact details, and filed them as a lead. For KYP Ads that channel
 * matters more than most, because the owner has no working SMS at all.
 *
 * Two properties carry the safety here.
 *
 * ONLY WHATSAPP CAN IDENTIFY STAFF. A WhatsApp `psid` IS the `wa_id`, the
 * sender's real number as WhatsApp itself confirms it, which is a stronger
 * signal than anything self-asserted. A Messenger or Instagram psid is an
 * opaque page-scoped id, and `contact_phone` there was typed by whoever was
 * in the chat. Trusting either would let anyone claim to be the owner by
 * writing a phone number into a DM, so those platforms never reach this
 * path at all.
 *
 * STAFF MODE OFF MEANS SILENT. Never "fall through to the customer
 * assistant". Falling through would re-create the original bug through the
 * settings page: the owner turns the feature off and gets pitched by their
 * own sales agent instead. The same rule holds for a failed turn, which the
 * worker retries rather than answering as a customer.
 */

import { runInlineChatTurn } from "@/lib/dashboard-chat/inline-turn";
import { ownerSurfaceToolGates } from "@/lib/owner-surfaces/gates";
import { buildOwnerSurfaceSystem } from "@/lib/owner-surfaces/system";
import { ownerTurnSurface } from "@/lib/owner-surfaces/turn-surfaces";
import { resolveSurfaceSpeaker, type SurfaceSpeaker } from "@/lib/owner-surfaces/speaker";
import { staffModeEnabled } from "@/lib/owner-surfaces/staff-mode";
import {
  loadOwnerSurfaceContext,
  type OwnerSurfaceContext
} from "@/lib/owner-surfaces/context";
import { messengerBookingPhone } from "@/lib/messenger/engine";
import type { MessengerConversationRow, MessengerMessageRow } from "@/lib/messenger/db";
import { logger } from "@/lib/logger";

const SURFACE = ownerTurnSurface("whatsapp");

/** Recent turns replayed for continuity, matching the owner-SMS window. */
const STAFF_TAIL_MESSAGES = 12;

export type MessengerStaffTurnOutcome =
  /** Not staff: the caller runs its normal customer turn. */
  | { kind: "customer" }
  /** Staff, but the owner turned this surface off. Say nothing. */
  | { kind: "silent"; reason: string }
  | { kind: "reply"; reply: string }
  /** Staff, but the turn failed. The caller retries; it must NOT fall back. */
  | { kind: "failed"; detail: string };

export type MessengerStaffTurnDeps = {
  resolveSpeaker?: typeof resolveSurfaceSpeaker;
  isStaffModeEnabled?: typeof staffModeEnabled;
  loadContext?: typeof loadOwnerSurfaceContext;
  runTurn?: typeof runInlineChatTurn;
};

export type MessengerStaffTurnArgs = {
  businessId: string;
  conversation: MessengerConversationRow;
  /** Oldest-first transcript window (listMessengerMessages output). */
  history: MessengerMessageRow[];
};

/** How the replayed transcript labels each side. */
function speakerLabel(speaker: SurfaceSpeaker): string {
  return speaker.kind === "owner" ? "Owner" : "Teammate";
}

export async function runMessengerStaffTurn(
  args: MessengerStaffTurnArgs,
  deps: MessengerStaffTurnDeps = {}
): Promise<MessengerStaffTurnOutcome> {
  const { businessId, conversation, history } = args;
  /* c8 ignore start -- production defaults; tests inject */
  const resolveSpeaker = deps.resolveSpeaker ?? resolveSurfaceSpeaker;
  const isStaffModeEnabled = deps.isStaffModeEnabled ?? staffModeEnabled;
  const loadContext = deps.loadContext ?? loadOwnerSurfaceContext;
  const runTurn = deps.runTurn ?? runInlineChatTurn;
  /* c8 ignore stop */

  // See the header: only a WhatsApp wa_id is a verified number.
  if (conversation.platform !== "whatsapp") return { kind: "customer" };
  const phone = messengerBookingPhone(conversation);
  if (!phone) return { kind: "customer" };

  const speaker = await resolveSpeaker(businessId, { phoneE164: phone });
  if (speaker.kind === "customer") return { kind: "customer" };

  if (!(await isStaffModeEnabled(businessId, "whatsapp"))) {
    return { kind: "silent", reason: "staff_mode_off" };
  }

  // The newest user message is what we answer; everything before it is
  // replayed as context. Answering it AND replaying it would show the model
  // the same question twice.
  const window = history.slice(-STAFF_TAIL_MESSAGES);
  const lastUserIndex = window.map((m) => m.role).lastIndexOf("user");
  if (lastUserIndex === -1) return { kind: "failed", detail: "no_input" };
  const text = window[lastUserIndex].content.trim();
  if (!text) return { kind: "failed", detail: "no_input" };
  const transcript = window
    .slice(0, lastUserIndex)
    .map(
      (m) =>
        `[${m.role === "user" ? speakerLabel(speaker) : "Coworker"}]: ${m.content.slice(0, 500)}`
    )
    .join("\n");

  let context: OwnerSurfaceContext;
  try {
    context = await loadContext(businessId, SURFACE, speaker);
  } catch (err) {
    return {
      kind: "failed",
      detail: err instanceof Error ? err.message : String(err)
    };
  }
  // Same fuse posture as the other owner surfaces: over the shared AI cap
  // this surface declines rather than degrading.
  if (context.overCap) return { kind: "failed", detail: "over_cap" };

  const inline = await runTurn({
    businessId,
    systemInstruction: buildOwnerSurfaceSystem({
      surface: SURFACE,
      speaker,
      speakerRef: phone,
      emailToolEnabled: context.emailToolEnabled,
      timezone: context.timezone,
      integrationsLine: context.integrationsLine,
      bookingLinkLine: context.bookingLinkLine,
      businessContextBlock: context.businessContextBlock,
      bridgeToolsDeclared: Boolean(context.bridgeExtraTools),
      transcript
    }),
    userMessage: `[WhatsApp from ${speaker.kind === "owner" ? "owner" : "team member"}${
      speaker.name ? ` ${speaker.name}` : ""
    }] ${text}`,
    knowledgeToolEnabled: context.knowledgeToolEnabled,
    extraTools: context.bridgeExtraTools,
    includeCreationTools: false,
    maxToolSteps: SURFACE.maxToolSteps,
    budgetMs: SURFACE.budgetMs,
    flowEditSource: SURFACE.flowEditSource,
    flowEditActor: phone,
    // By message the coworker can change what an automation SAYS. Changing
    // what it DOES needs the owner looking at the flow, so structural edits
    // refuse here and point at the dashboard.
    flowEditSurfaceKind: "text",
    actionToolGates: ownerSurfaceToolGates({
      toolStates: context.toolStates,
      isOwner: speaker.kind === "owner",
      whatsappConnected: context.whatsappConnected
    })
  });

  if (!inline.ok) {
    logger.warn("messenger staff turn: inline turn failed", {
      businessId,
      conversationId: conversation.id,
      error: inline.error,
      detail: inline.detail
    });
    return { kind: "failed", detail: inline.detail ?? inline.error ?? "turn_failed" };
  }
  const reply = inline.content.trim();
  // An empty reply is a failure, not a message: sending a blank WhatsApp
  // message is worse than retrying.
  if (!reply) return { kind: "failed", detail: "empty_reply" };
  return { kind: "reply", reply: reply.slice(0, SURFACE.replyMaxChars) };
}
