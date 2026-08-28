/**
 * WhatsApp from the business's own people.
 *
 * The bug this closes: an owner messaging their own business's WhatsApp
 * number reached the CUSTOMER sales assistant. It pitched them, asked for
 * their contact details, and filed them as a lead. For KYP Ads that channel
 * matters more than most, because the owner has no working SMS at all.
 *
 * ONLY WHATSAPP CAN IDENTIFY STAFF, and that rule lives here rather than in
 * the shared runner because it is a fact about Meta's platforms, not about
 * owner surfaces. A WhatsApp `psid` IS the `wa_id`, the sender's real number
 * as WhatsApp itself confirms it, which is a stronger signal than anything
 * self-asserted. A Messenger or Instagram psid is an opaque page-scoped id,
 * and `contact_phone` there was typed by whoever was in the chat. Trusting
 * either would let anyone claim to be the owner by writing a phone number
 * into a DM, so those platforms never reach this path at all.
 *
 * Everything after identity (staff mode, the transcript window, the context
 * reads, the prompt, the turn, the failure taxonomy) is the shared
 * `runOwnerSurfaceTurn`. STAFF MODE OFF STILL MEANS SILENT here: the worker
 * must never fall through to the customer engine, which would re-create the
 * original bug through the settings page.
 */

import { runOwnerSurfaceTurn } from "@/lib/owner-surfaces/run-turn";
import { resolveSurfaceSpeaker, type SurfaceSpeaker } from "@/lib/owner-surfaces/speaker";
import { messengerBookingPhone } from "@/lib/messenger/engine";
import type { MessengerConversationRow, MessengerMessageRow } from "@/lib/messenger/db";

/** Recent turns replayed for continuity, matching the owner-SMS window. */
const STAFF_TAIL_MESSAGES = 12;

export type MessengerStaffTurnOutcome =
  /** Not staff: the caller runs its normal customer turn. */
  | { kind: "customer" }
  /** Staff, but the owner turned this surface off. Say nothing. */
  | { kind: "silent"; reason: string }
  | { kind: "reply"; reply: string }
  /**
   * Staff, but the turn did not produce a reply. The caller must NOT fall
   * back to the customer engine. `terminal` says whether retrying could
   * ever change the answer: "there is nothing to answer" and "over the
   * spend cap" cannot, and burning three attempts on them just dead-letters
   * the job under a misleading code.
   */
  | { kind: "failed"; detail: string; code: string; terminal?: boolean };

export type MessengerStaffTurnDeps = {
  resolveSpeaker?: typeof resolveSurfaceSpeaker;
  runSurfaceTurn?: typeof runOwnerSurfaceTurn;
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
  const runSurfaceTurn = deps.runSurfaceTurn ?? runOwnerSurfaceTurn;
  /* c8 ignore stop */

  // See the header: only a WhatsApp wa_id is a verified number.
  if (conversation.platform !== "whatsapp") return { kind: "customer" };
  const phone = messengerBookingPhone(conversation);
  if (!phone) return { kind: "customer" };

  const speaker = await resolveSpeaker(businessId, { phoneE164: phone });
  if (speaker.kind === "customer") return { kind: "customer" };

  const outcome = await runSurfaceTurn({
    businessId,
    surfaceKey: "whatsapp",
    speaker,
    speakerRef: phone,
    // `owner` rows are a human answering by hand from the Meta inbox or
    // Business Suite. They fold to `assistant`, which keeps both of the
    // behaviours that role already had: the transcript labels them
    // "Coworker", and a TRAILING one closes the turn, so the AI never
    // follows up on top of a colleague.
    history: history.slice(-STAFF_TAIL_MESSAGES).map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.content
    })),
    speakerLabel: speakerLabel(speaker),
    userLabel: `WhatsApp from ${speaker.kind === "owner" ? "owner" : "team member"}${
      speaker.name ? ` ${speaker.name}` : ""
    }`
  });

  // WhatsApp has nowhere to post an "over the cap" line that would not
  // spend a billed template on an apology, so it stays quiet and terminal,
  // which is what this surface has always done.
  if (outcome.kind === "over_cap") {
    return { kind: "failed", detail: "over_cap", code: "over_cap", terminal: true };
  }
  // Narrowed rather than passed straight through: the runner also hands
  // back the pre-clip answer for the surfaces that post-process before
  // clipping, and WhatsApp does not, so it must not leak out of here.
  if (outcome.kind === "reply") return { kind: "reply", reply: outcome.reply };
  return outcome;
}
