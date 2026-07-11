/**
 * Admin: onboarding reminder nudge (BizBlasts "Stripe Connect reminder"
 * analog). Computes what the tenant hasn't finished — checkout, website
 * knowledge, coworker phone number, unpaid white-glove offers / enterprise
 * deals — and emails the owner a friendly checklist with links.
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
import { listWhiteGloveOffers, whiteGloveOfferPayUrl } from "@/lib/db/white-glove-offers";
import { listEnterpriseDeals, enterpriseDealPayUrl } from "@/lib/db/enterprise-deals";
import { sendOwnerEmail } from "@/lib/email/client";
import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = z.object({
  businessId: z.string().uuid()
});

type NudgeItem = { label: string; href?: string };

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const { businessId } = schema.parse(await request.json());

    const business = await getBusiness(businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found", 404);
    if (!business.owner_email || business.owner_email.includes("pending")) {
      return errorResponse("CONFLICT", "Business has no reachable owner email", 409);
    }

    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

    const [config, subscription, didRoute, offers, deals] = await Promise.all([
      getBusinessConfig(businessId),
      getSubscription(businessId),
      getTelnyxVoiceRouteForBusiness(businessId).catch(() => null),
      listWhiteGloveOffers(businessId).catch(() => []),
      listEnterpriseDeals(businessId).catch(() => [])
    ]);

    const items: NudgeItem[] = [];
    if (!subscription || subscription.status === "pending") {
      items.push({
        label: "Finish checkout to bring your coworker online",
        href: `${appUrl}/pricing`
      });
    }
    if (!config?.website_md?.trim()) {
      items.push({
        label: "Add your website so your coworker can answer customer questions",
        href: `${appUrl}/dashboard/memory`
      });
    }
    if (!didRoute?.to_e164) {
      items.push({
        label: "Your coworker doesn't have a phone number yet — reply to this email and we'll sort it out"
      });
    }
    for (const offer of offers) {
      if (offer.status === "open") {
        items.push({
          label: `Complete payment for "${offer.name}"`,
          href: whiteGloveOfferPayUrl(offer)
        });
      }
    }
    for (const deal of deals) {
      if (deal.status === "open") {
        items.push({
          label: "Complete your enterprise plan payment",
          href: enterpriseDealPayUrl(deal)
        });
      }
    }

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
      "Your AI coworker is almost ready — a few steps are still open:",
      "",
      ...textLines,
      "",
      `Open your dashboard: ${appUrl}/dashboard`,
      "",
      "Reply to this email if you're stuck — happy to help."
    ].join("\n");

    const html = buildBrandedEmailHtml({
      siteUrl: appUrl,
      documentTitle: subject,
      heading: "You're a few steps from done",
      bodyBlocks: [
        {
          kind: "text" as const,
          text: `Hi${business.owner_name ? ` ${business.owner_name}` : ""}, your AI coworker is almost ready — a few steps are still open:`
        },
        ...items.map((item) => ({
          kind: "text" as const,
          text: `• ${item.label}${item.href ? ` — ${item.href}` : ""}`
        })),
        { kind: "text" as const, text: "Reply to this email if you're stuck — happy to help." }
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
      // Resend accepted the call but returned no id — treat as undelivered
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
