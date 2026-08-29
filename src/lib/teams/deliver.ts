/**
 * Central Teams alert delivery, shared by the Node dispatcher and the
 * /api/internal/teams-send bridge the Deno mirror calls.
 *
 * Structured outcomes instead of throws (deliverSlackAlert's contract): the
 * caller decides whether "not_connected" is silence (a never-connected
 * tenant records nothing) or an honest skipped row.
 *
 * `no_alert_target` means something specific here and is worth its own
 * reason. Teams cannot start a conversation: a proactive message can only
 * continue one the bot has already seen, so a tenant who installed the app
 * but has not yet messaged it has a connection and nowhere to deliver. That
 * is a real, owner-actionable state, not a fault.
 */

import {
  getCoworkerConnection,
  type CoworkerConnectionRow
} from "@/lib/db/coworker-connections";
import { coworkerChannelAllowedForBusiness } from "@/lib/coworker-channels/tier-gate";
import { buildTeamsAlertCard, teamsSendActivity } from "@/lib/teams/client";
import { logger } from "@/lib/logger";

export type TeamsDeliveryResult =
  | { ok: true; conversationId: string; activityId: string }
  | {
      ok: false;
      reason:
        | "not_connected"
        | "needs_reconnect"
        | "no_alert_target"
        | "tier_blocked"
        | "send_failed";
      detail?: string;
    };

export type TeamsDeliveryInput = {
  businessId: string;
  summary: string;
  details?: string | null;
  detailsUrl?: string | null;
};

export async function deliverTeamsAlert(
  input: TeamsDeliveryInput
): Promise<TeamsDeliveryResult> {
  let connection: CoworkerConnectionRow | null;
  try {
    connection = await getCoworkerConnection(input.businessId, "teams");
  } catch (err) {
    logger.warn("deliverTeamsAlert: connection read failed", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, reason: "send_failed", detail: "connection_read_failed" };
  }
  if (!connection) return { ok: false, reason: "not_connected" };
  if (!connection.is_active) return { ok: false, reason: "needs_reconnect" };
  // Both halves of the conversation reference, or there is nowhere to send:
  // the id says which conversation and the service url says which regional
  // endpoint hosts it.
  if (!connection.alert_target_id || !connection.alert_target_name) {
    return { ok: false, reason: "no_alert_target" };
  }

  // Delivery-time tier re-check, failing TOWARD delivering on a read error:
  // an alert must never be lost to a transient tier lookup blip.
  try {
    if (!(await coworkerChannelAllowedForBusiness(input.businessId))) {
      return { ok: false, reason: "tier_blocked" };
    }
  } catch (err) {
    logger.warn("deliverTeamsAlert: tier check failed, delivering anyway", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  try {
    const sent = await teamsSendActivity(
      { serviceUrl: connection.alert_target_name, conversationId: connection.alert_target_id },
      {
        // Plain text alongside the card: Teams shows it in the notification
        // toast and in clients that will not render an Adaptive Card.
        text: input.summary,
        attachments: [buildTeamsAlertCard(input)]
      }
    );
    return {
      ok: true,
      conversationId: connection.alert_target_id,
      activityId: sent.activityId
    };
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
export async function teamsAlertTargetState(
  businessId: string
): Promise<{ connected: boolean; hasTarget: boolean }> {
  try {
    const connection = await getCoworkerConnection(businessId, "teams");
    return {
      connected: connection !== null,
      hasTarget: Boolean(connection?.alert_target_id && connection?.alert_target_name)
    };
  } catch (err) {
    logger.warn("teamsAlertTargetState: read failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { connected: true, hasTarget: true };
  }
}
