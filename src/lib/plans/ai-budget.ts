import type { PlanTier } from "@/lib/plans/tier";

/**
 * Monthly AI spend included with each tier for agentic tasks (tool-calling
 * work the coworker does on its own: browsing, prospecting, image
 * generation, flow runs), denominated in cents so it formats through the
 * same `formatPriceCents` helper as every other price on the page.
 *
 * Previously this lived as a bare "$5" / "$10" in three places: the Starter
 * and Standard feature bullets and the pricing comparison table. Pulling it
 * here keeps the plan cards, the strip, and the table reading one number.
 *
 * Enterprise is quoted per deployment, so it carries no fixed budget and the
 * public surfaces show "Custom" instead.
 */
export const AI_BUDGET_MONTHLY_CENTS: Record<Exclude<PlanTier, "enterprise">, number> = {
  starter: 500,
  standard: 1000
};
