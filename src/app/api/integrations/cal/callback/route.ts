/**
 * Cal.com OAuth callback. Verifies the signed state, exchanges the code,
 * stores the encrypted token pair, and registers a booking webhook when
 * Cal.com accepts one. A webhook failure does not undo the connection:
 * slot search and booking still work.
 */
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  exchangeCalAuthCode,
  verifyCalOAuthState,
  CalOAuthError
} from "@/lib/cal/oauth";
import { createCalWebhook, fetchCalProfile, listCalEventTypes } from "@/lib/cal/client";
import {
  newCalWebhookToken,
  setCalDefaultEventType,
  setCalWebhook,
  upsertCalConnection
} from "@/lib/db/cal-connections";
import { logger } from "@/lib/logger";

function dashboardRedirect(request: Request, params: Record<string, string>) {
  const url = new URL("/dashboard/integrations/cal", request.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

function webhookUrl(request: Request, businessId: string, token: string): string {
  const url = new URL("/api/webhooks/cal", request.url);
  url.searchParams.set("business", businessId);
  url.searchParams.set("token", token);
  return url.toString();
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return dashboardRedirect(request, { error: "Cal.com connection was cancelled" });
  }
  const verified = verifyCalOAuthState(state);
  if (!verified) {
    return dashboardRedirect(request, { error: "Cal.com connection expired. Please try again." });
  }
  const user = await getAuthUser();
  if (!user?.email) {
    const resume = `/api/integrations/cal/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    return NextResponse.redirect(new URL(`/login?redirectTo=${encodeURIComponent(resume)}`, request.url));
  }
  try {
    if (!user.isAdmin) {
      await requireBusinessRole(verified.businessId, "manage_settings");
    }
    const tokens = await exchangeCalAuthCode(code);
    const profile = await fetchCalProfile(tokens.accessToken);
    const webhookToken = newCalWebhookToken();
    const stored = await upsertCalConnection({
      businessId: verified.businessId,
      tokens,
      profile,
      defaultEventTypeId: null,
      webhookToken
    });
    try {
      const types = await listCalEventTypes(stored);
      if (types.length === 1) {
        await setCalDefaultEventType(stored.id, types[0].id);
      }
    } catch (err) {
      logger.warn("cal event type list failed after connect", {
        businessId: verified.businessId,
        error: (err as Error).message
      });
    }
    try {
      const secret = randomBytes(24).toString("hex");
      const webhookId = await createCalWebhook(stored, {
        subscriberUrl: webhookUrl(request, verified.businessId, webhookToken),
        secret
      });
      if (webhookId) await setCalWebhook(stored.id, webhookId, secret);
    } catch (err) {
      logger.warn("cal webhook registration failed after connect", {
        businessId: verified.businessId,
        error: (err as Error).message
      });
    }
    return dashboardRedirect(request, { connected: "1" });
  } catch (err) {
    logger.warn("cal oauth callback failed", {
      businessId: verified.businessId,
      error: (err as Error).message,
      code: err instanceof CalOAuthError ? err.code : "unknown"
    });
    return dashboardRedirect(request, { error: "Could not finish the Cal.com connection" });
  }
}
