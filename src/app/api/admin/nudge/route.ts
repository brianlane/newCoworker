/**
 * Admin: onboarding reminder nudge (BizBlasts "Stripe Connect reminder"
 * analog). Computes what the tenant hasn't finished, checkout, website
 * knowledge, coworker phone number, unpaid white-glove offers / enterprise
 * deals, and emails the owner a friendly checklist with links.
 *
 * POST { businessId } → { sent, items } (items also returned when nothing
 * is missing so the admin UI can say "nothing to nudge about").
 */
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getBusiness } from "@/lib/db/businesses";
import { getBusinessConfig } from "@/lib/db/configs";
import { getSubscription } from "@/lib/db/subscriptions";
import { getTelnyxVoiceRouteForBusiness } from "@/lib/db/telnyx-routes";
import { listWhiteGloveOffers } from "@/lib/db/white-glove-offers";
import { listEnterpriseDeals } from "@/lib/db/enterprise-deals";
import {
  computeOnboardingNudgeItems,
  nudgeAppUrl
} from "@/lib/admin/onboarding-nudge";
import { sendOwnerEmail } from "@/lib/email/client";
import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = z.object({
  businessId: z.string().uuid()
});

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const { businessId } = schema.parse(await request.json());

    const business = await getBusiness(businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found", 404);
    if (!business.owner_email || business.owner_email.includes("pending")) {
      return errorResponse("CONFLICT", "Business has no reachable owner email", 409);
    }

    const appUrl = nudgeAppUrl();

    // Every read is unguarded ON PURPOSE. These used to be wrapped in
    // `.catch(() => null | [])`, which quietly turned a transient failure
    // into wrong CUSTOMER-FACING copy: an unreadable `telnyx_voice_routes`
    // row became "your coworker doesn't have a phone number yet" in a real
    // email, and an unreadable offer list silently dropped a payment
    // request. There is no honest checklist to send when we cannot read
    // what is done, so fail the request (the operator retries) instead of
    // guessing. This also keeps the route in step with the admin page's
    // preview, which loads the same five inputs unguarded.
    const [config, subscription, didRoute, offers, deals] = await Promise.all([
      getBusinessConfig(businessId),
      getSubscription(businessId),
      getTelnyxVoiceRouteForBusiness(businessId),
      listWhiteGloveOffers(businessId),
      listEnterpriseDeals(businessId)
    ]);

    // Same computation the admin page renders as the nudge reasons, so the
    // operator's preview and this email can never disagree.
    const items = computeOnboardingNudgeItems({
      subscription,
      websiteMd: config?.website_md,
      didE164: didRoute?.to_e164,
      offers,
      deals
    });

    if (items.length === 0) {
      return successResponse({ sent: false, items: [] });
    }

    const subject = `Finish setting up ${business.name} on New Coworker`;
    const textLines = items.map(
      (item) => `- ${item.label}${item.href ? `: ${item.href}` : ""}`
    );
    const text = [
      `Hi${business.owner_name ? ` ${business.owner_name}` : ""},`,
      "",
      "Your AI coworker is almost ready. A few steps are still open:",
      "",
      ...textLines,
      "",
      `Open your dashboard: ${appUrl}/dashboard`,
      "",
      "Reply to this email if you're stuck. Happy to help."
    ].join("\n");

    const html = buildBrandedEmailHtml({
      siteUrl: appUrl,
      documentTitle: subject,
      heading: "You're a few steps from done",
      bodyBlocks: [
        {
          kind: "text" as const,
          text: `Hi${business.owner_name ? ` ${business.owner_name}` : ""}, your AI coworker is almost ready. A few steps are still open:`
        },
        ...items.map((item) => ({
          kind: "text" as const,
          text: `• ${item.label}${item.href ? `: ${item.href}` : ""}`
        })),
        { kind: "text" as const, text: "Reply to this email if you're stuck. Happy to help." }
      ],
      cta: { label: "Open dashboard", href: `${appUrl}/dashboard` },
      recipientEmail: business.owner_email
    });

    const apiKey = process.env.RESEND_API_KEY?.trim();
    if (!apiKey) {
      return errorResponse("CONFLICT", "RESEND_API_KEY is not configured; nudge not sent", 409);
    }

    let messageId: string | null = null;
    try {
      messageId = await sendOwnerEmail(apiKey, business.owner_email, subject, { text, html });
    } catch (err) {
      logger.error("admin.nudge: send failed", {
        adminEmail: admin.email,
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      return errorResponse("INTERNAL_SERVER_ERROR", "Email send failed; nudge not sent", 502);
    }
    if (!messageId) {
      // Resend accepted the call but returned no id, treat as undelivered
      // rather than telling the operator the reminder went out.
      return errorResponse("INTERNAL_SERVER_ERROR", "Email provider returned no message id", 502);
    }

    logger.info("admin.nudge: onboarding reminder sent", {
      adminEmail: admin.email,
      businessId,
      ownerEmail: business.owner_email,
      itemCount: items.length,
      messageId
    });

    return successResponse({ sent: true, items });
  } catch (err) {
    return handleRouteError(err);
  }
}
