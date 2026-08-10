/**
 * Central Slack alert delivery: the one function that turns "post this to
 * the tenant's alert channel" into a chat.postMessage, shared by the Node
 * dispatcher (src/lib/notifications/dispatch.ts), the digest leg, and the
 * /api/internal/slack-send bridge the Deno mirror calls.
 *
 * Structured outcomes instead of throws (deliverWhatsApp's contract): the
 * caller decides whether "not_connected" is silence (never-connected
 * tenants record nothing) or an honest skipped row.
 *
 * Tier is RE-CHECKED at delivery time: a downgrade to starter silently
 * stops Slack traffic without deleting the stored connection, the same
 * rule every other gated delivery path follows.
 */
import { getActiveSlackConnection, getSlackConnection } from "@/lib/db/slack-connections";
import { slackAllowedForBusiness } from "@/lib/slack/tier-gate";
import { slackPostMessage } from "@/lib/slack/client";
import { logger } from "@/lib/logger";

export type SlackDeliveryResult =
  | { ok: true; channelId: string; channelName: string | null; ts: string }
  | {
      ok: false;
      reason:
        | "not_connected"
        | "needs_reconnect"
        | "no_alert_channel"
        | "tier_blocked"
        | "send_failed";
      detail?: string;
    };

export type SlackDeliveryInput = {
  businessId: string;
  /** Plain-text fallback (also the notification text on old clients). */
  text: string;
  /** Optional Block Kit blocks; when present, `text` is the fallback. */
  blocks?: unknown[];
};

export async function deliverSlackAlert(input: SlackDeliveryInput): Promise<SlackDeliveryResult> {
  let connection;
  try {
    connection = await getSlackConnection(input.businessId);
  } catch (err) {
    logger.warn("deliverSlackAlert: connection read failed", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, reason: "send_failed", detail: "connection_read_failed" };
  }
  if (!connection) return { ok: false, reason: "not_connected" };
  if (!connection.is_active || connection.botToken.length === 0) {
    return { ok: false, reason: "needs_reconnect" };
  }
  if (!connection.alert_channel_id) return { ok: false, reason: "no_alert_channel" };

  // Delivery-time tier re-check; fails toward delivering on a read error
  // (an alert must never be lost to a transient tier lookup blip).
  try {
    if (!(await slackAllowedForBusiness(input.businessId))) {
      return { ok: false, reason: "tier_blocked" };
    }
  } catch (err) {
    logger.warn("deliverSlackAlert: tier check failed, delivering anyway", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  try {
    const posted = await slackPostMessage(connection.botToken, {
      channel: connection.alert_channel_id,
      text: input.text,
      ...(input.blocks ? { blocks: input.blocks } : {})
    });
    if (!posted.ok) {
      return { ok: false, reason: "send_failed", detail: posted.error };
    }
    return {
      ok: true,
      channelId: connection.alert_channel_id,
      channelName: connection.alert_channel_name,
      ts: posted.ts
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
 * The compact Block Kit card urgent alerts post: bolded headline, the
 * summary line, and a details link, with `text` as the notification
 * fallback. Kept tiny on purpose; richer per-kind cards can layer on later
 * without changing the delivery contract.
 */
export function buildSlackAlertBlocks(input: {
  summary: string;
  detailsUrl: string;
  detailsLabel?: string;
}): unknown[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*New Coworker Alert*\n${input.summary}`
      }
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<${input.detailsUrl}|${input.detailsLabel ?? "Open dashboard"}>`
        }
      ]
    }
  ];
}

/**
 * "Does Slack apply to this business at all?" for the dispatcher's
 * never-connected silence rule. Uses the ACTIVE read so the answer also
 * carries whether the channel is currently deliverable.
 */
export async function slackAlertTargetState(businessId: string): Promise<{
  connected: boolean;
  deliverable: boolean;
  alertChannelName: string | null;
}> {
  try {
    const active = await getActiveSlackConnection(businessId);
    if (active) {
      return {
        connected: true,
        deliverable: active.alert_channel_id !== null,
        alertChannelName: active.alert_channel_name
      };
    }
    const any = await getSlackConnection(businessId);
    return { connected: any !== null, deliverable: false, alertChannelName: null };
  } catch (err) {
    logger.warn("slackAlertTargetState: read failed; treating as connected", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    // Fail toward true, mirroring whatsappConnected: a blip degrades to a
    // noisy-but-honest skip row rather than silencing a connected tenant.
    return { connected: true, deliverable: false, alertChannelName: null };
  }
}
