/**
 * What is still unfinished in a tenant's onboarding.
 *
 * One source of truth for two surfaces that must never disagree: the admin
 * business page lists these as the reasons a nudge would be sent, and
 * POST /api/admin/nudge emails the same list to the owner. Before this was
 * shared, the reasons only existed inside the route, so an operator had to
 * send an email to find out whether there was anything to send.
 *
 * Pure: every input is passed in, nothing is read from the database here.
 * The pay links come from the offer/deal rows' durable public tokens.
 */

import type { SubscriptionRow } from "@/lib/db/subscriptions";
import {
  whiteGloveOfferPayUrl,
  type WhiteGloveOfferRow
} from "@/lib/db/white-glove-offers";
import { enterpriseDealPayUrl, type EnterpriseDealRow } from "@/lib/db/enterprise-deals";

export type NudgeItem = {
  /** Owner-facing sentence. Also rendered verbatim as the admin-side reason. */
  label: string;
  href?: string;
};

export type OnboardingNudgeInputs = {
  subscription: Pick<SubscriptionRow, "status"> | null;
  /** `business_configs.website_md`; blank means no website knowledge yet. */
  websiteMd: string | null | undefined;
  /** The tenant's DID from `telnyx_voice_routes`; null means none assigned. */
  didE164: string | null | undefined;
  offers: Array<Pick<WhiteGloveOfferRow, "name" | "status" | "pay_token">>;
  deals: Array<Pick<EnterpriseDealRow, "status" | "pay_token">>;
};

/**
 * The open onboarding items for a tenant, in the order they are shown and
 * emailed. An empty array means onboarding is complete and no nudge should
 * be sent.
 *
 * Every link resolves against {@link nudgeAppUrl}, including the offer and
 * deal pay links (whose canonical builders read the same env var). Taking a
 * caller-supplied base URL instead would let the dashboard links and the pay
 * links point at different hosts.
 */
export function computeOnboardingNudgeItems(inputs: OnboardingNudgeInputs): NudgeItem[] {
  const items: NudgeItem[] = [];
  const appUrl = nudgeAppUrl();

  if (!inputs.subscription || inputs.subscription.status === "pending") {
    items.push({
      label: "Finish checkout to bring your coworker online",
      href: `${appUrl}/pricing`
    });
  }
  if (!inputs.websiteMd?.trim()) {
    items.push({
      label: "Add your website so your coworker can answer customer questions",
      href: `${appUrl}/dashboard/memory`
    });
  }
  if (!inputs.didE164) {
    items.push({
      label:
        "Your coworker doesn't have a phone number yet. Reply to this email and we'll sort it out."
    });
  }
  for (const offer of inputs.offers) {
    if (offer.status === "open") {
      items.push({
        label: `Complete payment for "${offer.name}"`,
        href: whiteGloveOfferPayUrl(offer)
      });
    }
  }
  for (const deal of inputs.deals) {
    if (deal.status === "open") {
      items.push({
        label: "Complete your enterprise plan payment",
        href: enterpriseDealPayUrl(deal)
      });
    }
  }

  return items;
}

/** Base URL used by the nudge links. Shared so page and route agree. */
export function nudgeAppUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}
