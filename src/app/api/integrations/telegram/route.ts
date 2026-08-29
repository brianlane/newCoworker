/**
 * Telegram connection management for the owner.
 *
 * GET     current state (never the token)
 * POST    connect: verify a pasted bot token, register our webhook
 * PATCH   pause / resume, set the alert chat, or mint a connect code
 * DELETE  disconnect: unregister the webhook, drop the row
 *
 * WHY THIS ROUTE TAKES A TOKEN AT ALL, when the Slack management route says
 * plainly that "there is no token-paste path". Telegram has no OAuth, and
 * the alternative was one shared platform bot for every tenant. Slack,
 * Teams and Google Chat all hand us an organisation id on each inbound
 * event, so a shared app still has a platform-enforced boundary; Telegram
 * has no concept of an organisation, so a shared bot would put every
 * tenant's owner in one DM pool separated only by our own row lookup, with
 * one token, one global rate limit and one reputation to lose. A bot per
 * tenant restores the boundary and gives the tenant their own bot name.
 *
 * The token is verified against Telegram before it is stored (getMe), so a
 * typo fails here rather than silently later, and the bot's own id becomes
 * the connection's `external_workspace_id`: the tenant boundary.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  CoworkerWorkspaceAlreadyLinkedError,
  deleteCoworkerConnection,
  getCoworkerConnection,
  getPublicCoworkerConnection,
  setCoworkerAlertTarget,
  setCoworkerConnectionActive,
  upsertCoworkerConnection
} from "@/lib/db/coworker-connections";
import { createLinkCode, deleteChannelIdentities } from "@/lib/db/coworker-identities";
import { coworkerChannelAllowedForBusiness } from "@/lib/coworker-channels/tier-gate";
import {
  telegramDeleteWebhook,
  telegramGetMe,
  telegramSendMessage,
  TelegramApiError
} from "@/lib/telegram/client";
import { telegramOnboardingMessage } from "@/lib/telegram/chat";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const connectSchema = z.object({
  businessId: z.string().uuid(),
  /** `<bot id>:<secret>`, as BotFather issues it. */
  botToken: z.string().trim().min(20).max(200)
});

const patchSchema = z.object({
  businessId: z.string().uuid(),
  isActive: z.boolean().optional(),
  alertChatId: z.string().trim().min(1).max(64).optional(),
  /** Mint a one-time enrolment code for the owner or one roster member. */
  mintLinkCodeFor: z
    .object({ isOwner: z.boolean(), employeeId: z.string().uuid().nullable() })
    .optional()
});

async function authorize(businessId: string) {
  const user = await getAuthUser();
  if (!user?.email) return null;
  if (!user.isAdmin) {
    await requireBusinessRole(businessId, "manage_settings");
  }
  return user;
}

function webhookUrl(connectionId: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!base) throw new Error("NEXT_PUBLIC_APP_URL is not configured");
  return new URL(`/api/webhooks/telegram/${connectionId}`, base).toString();
}

export async function GET(request: Request) {
  try {
    const businessId = new URL(request.url).searchParams.get("businessId") ?? "";
    if (!z.string().uuid().safeParse(businessId).success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required", 400);
    }
    if (!(await authorize(businessId))) {
      return errorResponse("UNAUTHORIZED", "Sign in required", 401);
    }
    const connection = await getPublicCoworkerConnection(businessId, "telegram");
    return successResponse({
      connection,
      allowedForTier: await coworkerChannelAllowedForBusiness(businessId)
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = connectSchema.parse(await request.json());
    if (!(await authorize(body.businessId))) {
      return errorResponse("UNAUTHORIZED", "Sign in required", 401);
    }
    // Gate at the INGRESS as well as at delivery: a starter tenant should
    // be told why before they go and create a bot.
    if (!(await coworkerChannelAllowedForBusiness(body.businessId))) {
      return errorResponse(
        "FORBIDDEN",
        "The Telegram integration is available on Standard and Enterprise plans.",
        403
      );
    }

    // Verify the token with Telegram BEFORE storing it: a typo must fail
    // here, where somebody is watching, not silently at the first alert.
    let bot;
    try {
      bot = await telegramGetMe(body.botToken);
    } catch (err) {
      const detail = err instanceof TelegramApiError ? err.message : "token check failed";
      return errorResponse("VALIDATION_ERROR", `That bot token was rejected by Telegram (${detail}).`, 400);
    }

    const webhookSecret = randomBytes(32).toString("hex");
    const connection = await upsertCoworkerConnection({
      businessId: body.businessId,
      channel: "telegram",
      // The bot's own id IS the tenant boundary for this channel.
      externalWorkspaceId: String(bot.id),
      externalWorkspaceName: bot.username ? `@${bot.username}` : bot.firstName,
      credential: body.botToken,
      webhookSecret
    });

    // Point the bot at us. If this fails the row still exists, so the owner
    // can retry from the card rather than starting over with BotFather.
    const { telegramSetWebhook } = await import("@/lib/telegram/client");
    try {
      await telegramSetWebhook(body.botToken, {
        url: webhookUrl(connection.id),
        secretToken: webhookSecret
      });
    } catch (err) {
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        `Saved the bot, but Telegram would not accept the webhook (${
          err instanceof Error ? err.message : "unknown error"
        }). Try again from the card.`,
        502
      );
    }

    return successResponse({ connection });
  } catch (err) {
    if (err instanceof CoworkerWorkspaceAlreadyLinkedError) {
      return errorResponse("CONFLICT", err.message, 409);
    }
    return handleRouteError(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = patchSchema.parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Sign in required", 401);

    if (body.isActive !== undefined) {
      await setCoworkerConnectionActive(body.businessId, "telegram", body.isActive);
    }

    if (body.alertChatId) {
      const connection = await getCoworkerConnection(body.businessId, "telegram");
      if (!connection || connection.credential.length === 0) {
        return errorResponse("VALIDATION_ERROR", "Connect Telegram first.", 400);
      }
      // Prove the bot can actually reach that chat BEFORE recording it as
      // the alert target. Storing an unreachable target is how a tenant
      // ends up with alerts that report success and arrive nowhere.
      try {
        await telegramSendMessage(connection.credential, {
          chatId: body.alertChatId,
          text: telegramOnboardingMessage()
        });
      } catch (err) {
        return errorResponse(
          "VALIDATION_ERROR",
          `The bot could not post to that chat (${
            err instanceof Error ? err.message : "unknown error"
          }). Start a chat with the bot first, then try again.`,
          400
        );
      }
      await setCoworkerAlertTarget(body.businessId, "telegram", {
        id: body.alertChatId,
        name: null
      });
    }

    let linkCode: { code: string; expiresAt: string } | null = null;
    if (body.mintLinkCodeFor) {
      linkCode = await createLinkCode({
        businessId: body.businessId,
        channel: "telegram",
        employeeId: body.mintLinkCodeFor.employeeId,
        isOwner: body.mintLinkCodeFor.isOwner,
        createdByUserId: user.userId ?? null
      });
    }

    return successResponse({
      connection: await getPublicCoworkerConnection(body.businessId, "telegram"),
      linkCode
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const businessId = new URL(request.url).searchParams.get("businessId") ?? "";
    if (!z.string().uuid().safeParse(businessId).success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required", 400);
    }
    if (!(await authorize(businessId))) {
      return errorResponse("UNAUTHORIZED", "Sign in required", 401);
    }

    const connection = await getCoworkerConnection(businessId, "telegram");
    if (connection && connection.credential.length > 0) {
      // Best effort: the row goes either way. A bot still pointed at a
      // deleted connection just gets 401s from the webhook.
      await telegramDeleteWebhook(connection.credential).catch(() => undefined);
    }
    // Forget who was connected, too. Nothing cascades these, so leaving
    // them would mean a later reconnect with a different bot silently
    // treated every previously bound account as staff again.
    await deleteChannelIdentities(businessId, "telegram");
    await deleteCoworkerConnection(businessId, "telegram");
    return successResponse({ disconnected: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
