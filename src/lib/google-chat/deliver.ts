/**
 * Central Google Chat alert delivery, shared by the Node dispatcher and the
 * /api/internal/google-chat-send bridge the Deno mirror calls.
 *
 * Structured outcomes instead of throws (deliverSlackAlert's contract): the
 * caller decides whether "not_connected" is silence (a never-connected
 * tenant records nothing) or an honest skipped row.
 *
 * NO `no_alert_target` HERE, which is the difference from Teams and worth
 * saying out loud because the two channels otherwise look alike. Teams
 * cannot start a conversation, so a tenant can be connected with nowhere to
 * deliver. A Chat app that is a member of a space can post into it
 * whenever, and the space IS the connection, so connected and deliverable
 * are the same state.
 */

import {
  getCoworkerConnection,
  type CoworkerConnectionRow
} from "@/lib/db/coworker-connections";
import { coworkerChannelAllowedForBusiness } from "@/lib/coworker-channels/tier-gate";
import {
  buildGoogleChatAlertCard,
  googleChatConfigured,
  googleChatSendMessage
} from "@/lib/google-chat/client";
import { logger } from "@/lib/logger";

export type GoogleChatDeliveryResult =
  | { ok: true; space: string; messageName: string }
  | {
      ok: false;
      reason:
        | "not_connected"
        | "needs_reconnect"
        | "not_configured"
        | "tier_blocked"
        | "send_failed";
      detail?: string;
    };

export type GoogleChatDeliveryInput = {
  businessId: string;
  summary: string;
  details?: string | null;
  detailsUrl?: string | null;
};

export async function deliverGoogleChatAlert(
  input: GoogleChatDeliveryInput
): Promise<GoogleChatDeliveryResult> {
  let connection: CoworkerConnectionRow | null;
  try {
    connection = await getCoworkerConnection(input.businessId, "google_chat");
  } catch (err) {
    logger.warn("deliverGoogleChatAlert: connection read failed", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, reason: "send_failed", detail: "connection_read_failed" };
  }
  if (!connection) return { ok: false, reason: "not_connected" };
  if (!connection.is_active) return { ok: false, reason: "needs_reconnect" };

  // OUR credential is missing, not the tenant's. Distinct from every other
  // reason because it is the one nobody at the business can fix, and a
  // "needs_reconnect" here would send an owner round a loop that cannot
  // help them.
  if (!googleChatConfigured()) return { ok: false, reason: "not_configured" };

  // Delivery-time tier re-check, failing TOWARD delivering on a read error:
  // an alert must never be lost to a transient tier lookup blip.
  try {
    if (!(await coworkerChannelAllowedForBusiness(input.businessId))) {
      return { ok: false, reason: "tier_blocked" };
    }
  } catch (err) {
    logger.warn("deliverGoogleChatAlert: tier check failed, delivering anyway", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  const space = connection.external_workspace_id;
  try {
    const sent = await googleChatSendMessage(
      // Deliberately NOT threaded. An alert is new information, not a reply
      // to whatever was last discussed, and burying it under an old thread
      // is how it goes unseen.
      { space, thread: null },
      {
        // Plain text alongside the card: Chat shows it in the notification
        // and in clients that will not render a card.
        text: input.summary,
        cardsV2: [buildGoogleChatAlertCard(input)]
      }
    );
    return { ok: true, space, messageName: sent.messageName };
  } catch (err) {
    return {
      ok: false,
      reason: "send_failed",
      detail: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Does this channel apply to this business at all?
 *
 * On a read error this reports CONNECTED, the noisier and more honest of the
 * two mistakes: a skipped row that says why beats silence that looks like a
 * tenant who never connected.
 */
export async function googleChatConnectedState(businessId: string): Promise<boolean> {
  try {
    return (await getCoworkerConnection(businessId, "google_chat")) !== null;
  } catch (err) {
    logger.warn("googleChatConnectedState: read failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return true;
  }
}
