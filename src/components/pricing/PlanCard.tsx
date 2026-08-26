"use client";

import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import type { BillingPeriod } from "@/lib/plans/tier";
import type { TierCard } from "@/lib/plans/tier-display";

/**
 * Number of stacked rows a card lays out. Kept next to the markup because
 * `PlanCards` has to declare the same count on the grid container for the
 * subgrid alignment below to work: change one, change both.
 */
export const PLAN_CARD_ROWS = 11;

/**
 * One plan tier.
 *
 * The layout answers a specific problem: Standard genuinely includes far more
 * than Starter (24 bullets against 12), and rendering both in full stretched
 * the grid to Standard's height, leaving Starter with a column of dead space
 * and Standard with a wall of checkmarks nobody read.
 *
 * Three things fix it, in order of how much they do:
 *
 *  1. The highlight strip. The four metered numbers sit in the same four
 *     slots on every card, directly under the price, so the capacity jump
 *     that justifies the price jump is readable at a glance instead of buried
 *     mid-list.
 *  2. `leadIn` ("Everything in Starter, plus:") framing the bullets rather
 *     than sitting among them, which lets a card show six differentiating
 *     features instead of restating the twenty it inherits.
 *  3. The CTA ABOVE the feature list, so ragged bullet counts cannot push the
 *     buttons out of alignment with each other.
 *
 * What is deliberately NOT here is an in-card "show more" expander. Baymard's
 * moderated testing found users overlook those links regardless of prominence
 * and conclude the feature does not exist, so the complete list lives in the
 * always-open comparison table on /pricing instead, and a test proves every
 * bullet has a row there.
 *
 * ROW ALIGNMENT: the card is a CSS subgrid of the card container, so all
 * three cards share one set of row heights and every band (price, strip,
 * button, bullets) lines up across the row no matter how much text each tier
 * puts in it. An earlier pass reserved `min-h` on the variable rows instead
 * and it did not hold: Standard's multiplier line wraps to two lines at some
 * widths and Enterprise carries no renewal or billed-today line, so the three
 * buttons landed at three different heights. Every direct child below is one
 * grid row, which is why the empty placeholders are here rather than being
 * conditionally omitted.
 *
 * `gap-y-0` here is deliberate and load-bearing. A subgrid inherits the
 * parent's gutters by default, and the card container carries `gap-6` for the
 * space BETWEEN cards; without this override that 24px would also open up
 * between all 11 bands inside every card. Per CSS Grid Level 2 a subgrid's own
 * gap wins in the subgridded axis, so the bands are spaced only by the `mt-*`
 * margins below (measured 12/4/12/4/16/8/16/20/10/20px at 1440, 900, and
 * 390 wide, with the 24px between-card gutter intact at each).
 */
export function PlanCard({
  tier,
  period,
  savingsPercent,
  compareHref,
  compareCount
}: {
  tier: TierCard;
  period: BillingPeriod;
  /** Percent saved versus monthly, omitted for enterprise and monthly. */
  savingsPercent?: number;
  compareHref: string;
  compareCount: number;
}) {
  const t = useTranslations("marketing.planCards");
  const isEnterprise = tier.id === "enterprise";

  return (
    <Card
      className={[
        "row-span-11 grid min-w-0 grid-rows-subgrid gap-y-0",
        tier.highlight ? "border-signal-teal/50 ring-1 ring-signal-teal/30" : ""
      ].join(" ")}
    >
      {/* 1: badge, or nothing when the tier has none this period. */}
      <div>{tier.badge && <Badge variant="pending">{tier.badge}</Badge>}</div>

      {/* 2: name */}
      <h2 className="mt-3 text-lg font-bold text-parchment">{tier.name}</h2>

      {/* 3: who it is for */}
      <p className="mt-1 text-sm leading-snug text-parchment/55">{tier.tagline}</p>

      {/* 4: headline price */}
      <div className="mt-3 flex min-w-0 flex-wrap items-end gap-x-3 gap-y-1">
        <p className="min-w-0 text-2xl font-bold text-claw-green sm:text-3xl">{tier.price}</p>
        {tier.originalPrice && (
          <p className="pb-1 text-sm font-semibold text-parchment/35 line-through break-words">
            {tier.originalPrice}
          </p>
        )}
      </div>

      {/* 5: billing detail, the most variable row between tiers and periods */}
      <div key={`${tier.id}-${period}`} className="animate-fade-slide-up mt-1 min-w-0 space-y-1.5">
        {tier.introOffer && (
          <div className="inline-flex max-w-full items-center rounded-full border border-spark-orange/25 bg-spark-orange/10 px-2.5 py-1 text-center text-[11px] font-semibold leading-snug text-spark-orange">
            {tier.introOffer}
          </div>
        )}
        {savingsPercent !== undefined && (
          <div className="inline-flex max-w-full items-center rounded-full border border-claw-green/25 bg-claw-green/10 px-2.5 py-1 text-center text-[11px] font-semibold leading-snug text-claw-green">
            {t("saveVersusMonthly", { percent: savingsPercent })}
          </div>
        )}
        {tier.renewal && <p className="text-xs text-parchment/58">{tier.renewal}</p>}
        {tier.total && <p className="text-xs font-medium text-parchment/80">{tier.total}</p>}
        <p className="text-xs text-parchment/52">{tier.setup}</p>
      </div>

      {/* 6: the four metered numbers, same slots on every card */}
      <div className="mt-4 grid grid-cols-2 gap-px self-start overflow-hidden rounded-xl border border-parchment/12 bg-parchment/12">
        {tier.highlights.map((highlight) => (
          <div key={highlight.label} className="min-w-0 bg-deep-ink px-3 py-2.5">
            <p className="text-base font-bold leading-tight break-words text-claw-green sm:text-lg">
              {highlight.value}
            </p>
            <p className="mt-0.5 text-[10px] uppercase leading-tight tracking-[0.12em] text-parchment/45">
              {highlight.label}
            </p>
          </div>
        ))}
      </div>

      {/* 7: why the price step is earned. Standard only, but the row exists on
          every card so the buttons below stay level. */}
      <div className="mt-2">
        {tier.multiplierLine && (
          <p className="text-center text-xs font-semibold text-signal-teal">
            {tier.multiplierLine}
          </p>
        )}
      </div>

      {/* 8: CTA, above the bullets so bullet counts cannot move it */}
      <div className="mt-4 self-end">
        <a
          href={isEnterprise ? "/contact" : `/onboard/questionnaire?tier=${tier.id}&period=${period}`}
          className={[
            // `border` on all three, transparent on the filled ones: only
            // Enterprise's button is outlined, and without a matching border
            // box the filled buttons come out 2px shorter and sit 2px off.
            "block w-full rounded-lg border px-4 py-2.5 text-center text-sm font-semibold transition-colors",
            isEnterprise
              ? "border-parchment/20 text-parchment hover:bg-parchment/10"
              : tier.highlight
                ? "border-transparent bg-signal-teal text-deep-ink hover:bg-signal-teal/90"
                : "border-transparent bg-claw-green text-deep-ink hover:bg-claw-green/90"
          ].join(" ")}
        >
          {tier.cta}
        </a>
      </div>

      {/* 9: "Everything in Starter, plus:" */}
      <div className="mt-5">
        {tier.leadIn && <p className="text-sm font-semibold text-parchment">{tier.leadIn}</p>}
      </div>

      {/* 10: the differentiating bullets. Starter has only two of these, so
          the row it shares with Standard's six leaves a hole underneath it;
          the upgrade note fills that with the one thing worth saying there
          rather than with features every tier already includes. */}
      <div className="mt-2.5 flex flex-col">
        <ul className="space-y-2">
          {tier.cardFeatures.map((feature) => (
            <li key={feature} className="flex items-start gap-2 text-sm text-parchment/70">
              <span className="mt-0.5 text-claw-green">✓</span>
              {feature}
            </li>
          ))}
        </ul>
        {tier.upgradeNote && (
          <p className="mt-auto rounded-xl border border-signal-teal/25 bg-signal-teal/5 px-3 py-2.5 pt-2.5 text-xs leading-relaxed text-parchment/70">
            {tier.upgradeNote}
          </p>
        )}
      </div>

      {/* 11: the way into the complete list */}
      <a
        href={compareHref}
        className="mt-5 self-end text-xs font-semibold text-signal-teal transition-colors hover:text-claw-green"
      >
        {t("compareLink", { count: compareCount })}
      </a>
    </Card>
  );
}
