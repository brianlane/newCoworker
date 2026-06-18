/**
 * Owner-initiated "email this person" from a customer profile.
 *
 * POST /api/dashboard/customers/:e164/email?businessId=<uuid>
 *   body: { subject, bodyText }
 *   → { ok: true, provider, messageId }
 *
 * Sends from the owner's connected mailbox (Gmail/Outlook) to the address
 * linked on the customer profile, then logs it so it rolls up under the
 * profile's Email history. Auth: getAuthUser + requireOwner(businessId);
 * admins bypass. Requires the profile to have a linked email and the owner to
 * have connected a mailbox (Integrations) — otherwise a clear 4xx.
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { getCustomerMemory } from "@/lib/customer-memory/db";
import { sendFromOwnerMailbox } from "@/lib/email/owner-mailbox";
import { recordOutboundAssistantEmail } from "@/lib/db/email-log";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const SEND_RATE = { interval: 60 * 1000, maxRequests: 10 };

const paramsSchema = z.object({
  customerE164: z.string().regex(/^\+[1-9]\d{6,15}$/)
});

const querySchema = z.object({ businessId: z.string().uuid() });

const bodySchema = z.object({
  subject: z.string().trim().min(1).max(150),
  bodyText: z.string().trim().min(1).max(4000)
});

async function decodePathParam(raw: string): Promise<string> {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ customerE164: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const raw = (await ctx.params).customerE164;
    const { customerE164 } = paramsSchema.parse({
      customerE164: await decodePathParam(raw)
    });

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireOwner(businessId);

    const limiter = rateLimit(`customer-email:${businessId}:${customerE164}`, SEND_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many emails, slow down.", 429);
    }

    const { subject, bodyText } = bodySchema.parse(await request.json());

    const memory = await getCustomerMemory(businessId, customerE164);
    if (!memory) return errorResponse("NOT_FOUND", "Customer not found");
    if (!memory.email) {
      return errorResponse(
        "VALIDATION_ERROR",
        "This profile has no linked email. Add one first."
      );
    }

    const result = await sendFromOwnerMailbox(businessId, {
      toEmail: memory.email,
      subject,
      bodyText
    });
    if (!result.ok) {
      return errorResponse(
        "FORBIDDEN",
        "No mailbox connected. Connect Gmail or Outlook in Integrations to send email."
      );
    }

    await recordOutboundAssistantEmail({
      businessId,
      toEmail: memory.email,
      subject,
      bodyText,
      source: "dashboard_chat",
      providerMessageId: result.messageId
    });

    logger.info("dashboard/customers email sent", { businessId, provider: result.provider });
    return successResponse({ ok: true, provider: result.provider, messageId: result.messageId });
  } catch (err) {
    return handleRouteError(err);
  }
}
