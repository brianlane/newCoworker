/**
 * Owner-facing management for the business's Slack workspace connection.
 *
 *   GET    ?businessId=…   → connection state (masked) + the channel list
 *                            for the alert-channel picker (best-effort).
 *   PATCH  {businessId, isActive?}                → pause / resume.
 *   PATCH  {businessId, alertChannel: {id,name}}  → pick the alerts channel.
 *          The channel is stored ONLY after a hello post proves the bot can
 *          actually deliver there, so the alert path never points at a
 *          channel that silently swallows everything.
 *   PATCH  {businessId, alertChannel: null}       → clear the channel.
 *   DELETE {businessId}    → best-effort token revoke at Slack, then remove
 *                            the connection entirely.
 *
 * Connect/reconnect is the browser-navigated OAuth flow under
 * /api/integrations/slack/connect; there is no token-paste path.
 */
import { z } from "zod";
import { cookies } from "next/headers";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  deleteSlackConnection,
  getActiveSlackConnection,
  getPublicSlackConnection,
  getSlackConnection,
  setSlackAlertChannel,
  setSlackConnectionActive
} from "@/lib/db/slack-connections";
import { revokeSlackToken } from "@/lib/slack/oauth";
import { slackListChannels, slackPostMessage, type SlackChannelSummary } from "@/lib/slack/client";
import { slackAlertChannelHelloMessage } from "@/lib/slack/copy";
import { resolveUiLocale } from "@/lib/i18n/resolve-locale";
import { LOCALE_COOKIE } from "@/i18n/routing";

const businessIdSchema = z.string().uuid();

const patchSchema = z
  .object({
    businessId: z.string().uuid(),
    isActive: z.boolean().optional(),
    alertChannel: z
      .object({
        id: z.string().trim().min(1).max(64),
        name: z.string().trim().min(1).max(100)
      })
      .nullable()
      .optional()
  })
  .refine((body) => body.isActive !== undefined || body.alertChannel !== undefined, {
    message: "isActive or alertChannel is required"
  });

async function authorize(businessId: string) {
  const user = await getAuthUser();
  if (!user?.email) return null;
  if (!user.isAdmin) {
    await requireBusinessRole(businessId, "manage_settings");
  }
  return user;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = businessIdSchema.safeParse(url.searchParams.get("businessId"));
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required");
    }
    const user = await authorize(parsed.data);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const connection = await getPublicSlackConnection(parsed.data);

    // Channel list for the picker, best-effort: a Slack-side hiccup (or a
    // wiped token) degrades to an empty list, never a failed page.
    let channels: SlackChannelSummary[] = [];
    if (connection?.is_active && connection.has_bot_token) {
      try {
        const withToken = await getSlackConnection(parsed.data);
        if (withToken && withToken.botToken.length > 0) {
          channels = await slackListChannels(withToken.botToken);
        }
      } catch {
        channels = [];
      }
    }

    return successResponse({ connection, channels });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = patchSchema.parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const existing = await getPublicSlackConnection(body.businessId);
    if (!existing) return errorResponse("NOT_FOUND", "No Slack connection");

    if (body.isActive !== undefined) {
      await setSlackConnectionActive(body.businessId, body.isActive);
    }

    if (body.alertChannel === null) {
      await setSlackAlertChannel(body.businessId, null);
    } else if (body.alertChannel !== undefined) {
      const active = await getActiveSlackConnection(body.businessId);
      if (!active) {
        return errorResponse(
          "CONFLICT",
          "Reconnect Slack before choosing an alert channel"
        );
      }
      // Prove deliverability BEFORE storing: chat:write.public covers public
      // channels, but a private channel needs the bot invited first.
      const cookieStore = await cookies();
      const locale = resolveUiLocale({
        cookieLocale: cookieStore.get(LOCALE_COOKIE)?.value ?? null
      });
      const posted = await slackPostMessage(active.botToken, {
        channel: body.alertChannel.id,
        text: slackAlertChannelHelloMessage(locale)
      });
      if (!posted.ok) {
        const needsInvite =
          posted.error === "not_in_channel" || posted.error === "channel_not_found";
        return errorResponse(
          "CONFLICT",
          needsInvite
            ? "The bot can't post there yet - invite @New Coworker to that channel in Slack, then try again"
            : `Slack refused the test message (${posted.error})`
        );
      }
      await setSlackAlertChannel(body.businessId, {
        id: body.alertChannel.id,
        name: body.alertChannel.name
      });
    }

    const row = await getPublicSlackConnection(body.businessId);
    return successResponse(row);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = z.object({ businessId: z.string().uuid() }).parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    // Best-effort revoke so the grant doesn't linger on the workspace;
    // deletion proceeds regardless (revoke can 4xx on already-dead tokens).
    const row = await getSlackConnection(body.businessId).catch(() => null);
    if (row && row.botToken.length > 0) {
      await revokeSlackToken(row.botToken);
    }

    await deleteSlackConnection(body.businessId);
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
