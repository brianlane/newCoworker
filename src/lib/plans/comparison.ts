import type { PlanTier } from "@/lib/plans/tier";
import { TIER_LIMITS } from "@/lib/plans/limits";
import { concurrentCallsLine, imageGenerationLine, voiceMinutesLine } from "@/lib/plans/usage-copy";
import { AI_BUDGET_MONTHLY_CENTS } from "@/lib/plans/ai-budget";
import { formatPriceCents } from "@/lib/pricing";
import type { PlanCopyLocale } from "@/lib/plans/tier-display";

/**
 * The plan comparison table, lifted out of the pricing page so it can be
 * unit tested.
 *
 * It exists because the plan CARDS are deliberately short: Standard genuinely
 * carries 24 feature bullets and rendering all of them produced a wall nobody
 * read, so each card now shows only the handful that differentiate it. That
 * is only honest if the full list is still on the page, always open, which is
 * what this table is. Baymard's testing found users overlook "show all
 * features" links entirely and conclude the missing feature does not exist,
 * so the complete record must never sit behind a click.
 *
 * `covers` is what keeps that promise enforceable rather than aspirational:
 * every row declares which feature-array positions it accounts for, and
 * `tests/pricing-comparison.test.ts` fails if any bullet on any tier has no
 * row. Add a bullet without a row here and CI tells you.
 */

export type ComparisonCell =
  /** Included. */
  | { kind: "check" }
  /** Not included on this tier. */
  | { kind: "dash" }
  /** Quoted per deployment; renders the shared "Custom" label. */
  | { kind: "custom" }
  /** Already-resolved text computed from TIER_LIMITS. */
  | { kind: "text"; value: string }
  /** Resolved by the page through `t(key)` on the marketing.pricing namespace. */
  | { kind: "key"; key: string };

export type FeatureCoverage = Partial<Record<PlanTier, number[]>>;

export type ComparisonRow = {
  /** Key under `marketing.pricing` holding this row's label. */
  labelKey: string;
  starter: ComparisonCell;
  standard: ComparisonCell;
  enterprise: ComparisonCell;
  /** Feature-array positions this row accounts for, per tier. */
  covers: FeatureCoverage;
};

export type ComparisonGroup = {
  /** Key under `marketing.pricing` holding this group's heading. */
  headingKey: string;
  rows: ComparisonRow[];
};

/**
 * Feature-array positions that are not features and so need no row: the
 * "Everything in Starter, plus:" lead-in that frames the list rather than
 * naming a capability.
 */
export const COVERAGE_EXEMPT_INDICES: Record<PlanTier, number[]> = {
  starter: [],
  standard: [0],
  enterprise: [0]
};

const SMS_CAP_FORMAT = new Intl.NumberFormat("en-US");

const CHECK: ComparisonCell = { kind: "check" };
const DASH: ComparisonCell = { kind: "dash" };
const CUSTOM: ComparisonCell = { kind: "custom" };

const text = (value: string): ComparisonCell => ({ kind: "text", value });
const key = (k: string): ComparisonCell => ({ kind: "key", key: k });

/** Included on every tier, so all three columns are a check. */
function universalRow(labelKey: string, covers: FeatureCoverage): ComparisonRow {
  return { labelKey, starter: CHECK, standard: CHECK, enterprise: CHECK, covers };
}

/** Standard and Enterprise only, the most common shape in this table. */
function standardUpRow(labelKey: string, covers: FeatureCoverage): ComparisonRow {
  return { labelKey, starter: DASH, standard: CHECK, enterprise: CHECK, covers };
}

/** Enterprise only. */
function enterpriseOnlyRow(labelKey: string, covers: FeatureCoverage): ComparisonRow {
  return { labelKey, starter: DASH, standard: DASH, enterprise: CHECK, covers };
}

export function buildComparisonGroups(locale: PlanCopyLocale = "en"): ComparisonGroup[] {
  const aiBudget = (tier: Exclude<PlanTier, "enterprise">) =>
    text(formatPriceCents(AI_BUDGET_MONTHLY_CENTS[tier]));

  return [
    {
      headingKey: "groupEveryPlan",
      rows: [
        universalRow("rowVoiceCoworker", { starter: [0] }),
        universalRow("rowDedicated", { starter: [1] }),
        universalRow("rowChatAccess", { starter: [2] }),
        universalRow("rowMemory", { starter: [7] }),
        universalRow("rowBooking", { starter: [8] }),
        universalRow("rowIntegrations", { starter: [6] }),
        // Not in any tier's feature array: promised by the pricing hero
        // rather than by a bullet, and carried here since the separate "in
        // every plan" band above the table went away. The 30-day guarantee
        // deliberately has no row: every card's setup line already states it,
        // and the FAQ covers the carve-outs a bare check mark would hide.
        universalRow("rowPrivateServer", {})
      ]
    },
    {
      headingKey: "groupEveryMonth",
      rows: [
        {
          labelKey: "rowVoiceMinutes",
          starter: text(voiceMinutesLine("starter", undefined, locale)),
          standard: text(voiceMinutesLine("standard", undefined, locale)),
          enterprise: CUSTOM,
          covers: { starter: [9], standard: [1] }
        },
        {
          labelKey: "rowSmsPerMonth",
          // Thousands-separated to match the card's highlight strip: the two
          // sit a screen apart showing the same cap, so "5000" here against
          // "5,000" there reads as two different numbers.
          starter: text(SMS_CAP_FORMAT.format(TIER_LIMITS.starter.smsPerMonth)),
          standard: text(SMS_CAP_FORMAT.format(TIER_LIMITS.standard.smsPerMonth)),
          enterprise: CUSTOM,
          covers: { starter: [10], standard: [2] }
        },
        {
          labelKey: "rowConcurrentCalls",
          starter: text(concurrentCallsLine(TIER_LIMITS.starter.maxConcurrentCalls, locale)),
          standard: text(concurrentCallsLine(TIER_LIMITS.standard.maxConcurrentCalls, locale)),
          enterprise: CUSTOM,
          covers: { starter: [11], standard: [3] }
        },
        {
          labelKey: "rowAiBudget",
          starter: aiBudget("starter"),
          standard: aiBudget("standard"),
          enterprise: CUSTOM,
          covers: { starter: [3], standard: [19] }
        },
        {
          labelKey: "rowImageGen",
          starter: text(imageGenerationLine("starter", undefined, locale)),
          standard: text(imageGenerationLine("standard", undefined, locale)),
          enterprise: CUSTOM,
          covers: { starter: [4], standard: [20] }
        }
      ]
    },
    {
      headingKey: "groupReach",
      rows: [
        standardUpRow("rowWidget", {}),
        standardUpRow("rowByon", { standard: [4] }),
        standardUpRow("rowSocialReplies", { standard: [9] }),
        standardUpRow("rowTextsDuringCalls", { standard: [12, 13] }),
        standardUpRow("rowWarmHandoff", { standard: [18] })
      ]
    },
    {
      headingKey: "groupGoGet",
      rows: [
        standardUpRow("rowProspecting", { standard: [7] }),
        standardUpRow("rowOutboundCalls", { standard: [11] }),
        standardUpRow("rowScheduledCampaigns", { standard: [10] }),
        standardUpRow("rowScheduledTexts", { standard: [14] })
      ]
    },
    {
      headingKey: "groupKnow",
      rows: [
        standardUpRow("rowSummaries", { standard: [15] }),
        standardUpRow("rowAnalytics", { standard: [16, 17] })
      ]
    },
    {
      headingKey: "groupConnect",
      rows: [
        standardUpRow("rowZapier", { standard: [5] }),
        standardUpRow("rowWebhooks", { standard: [6] })
      ]
    },
    {
      headingKey: "groupSharperAi",
      rows: [
        {
          labelKey: "rowBrowserSkills",
          starter: key("browserStarter"),
          standard: key("browserStandard"),
          enterprise: key("browserStandard"),
          covers: { starter: [5], standard: [23] }
        },
        standardUpRow("rowTranslator", { standard: [8] }),
        enterpriseOnlyRow("rowDesignatedModels", { enterprise: [7] }),
        enterpriseOnlyRow("rowVoices", { enterprise: [8] })
      ]
    },
    {
      headingKey: "groupSupport",
      rows: [
        {
          labelKey: "rowSupport",
          starter: key("supportStarter"),
          standard: key("supportStandard"),
          enterprise: key("supportEnterprise"),
          covers: { standard: [22], enterprise: [4] }
        },
        standardUpRow("rowConfigTraining", { standard: [21] }),
        enterpriseOnlyRow("rowQuarterlyReviews", { enterprise: [11] })
      ]
    },
    {
      headingKey: "groupAgency",
      rows: [
        enterpriseOnlyRow("rowAgencyDashboard", { enterprise: [1] }),
        enterpriseOnlyRow("rowTeamRoles", { enterprise: [2] }),
        enterpriseOnlyRow("rowWhiteLabel", { enterprise: [3] }),
        enterpriseOnlyRow("rowRcs", { enterprise: [6] }),
        enterpriseOnlyRow("rowCompliance", { enterprise: [5] }),
        enterpriseOnlyRow("rowCustomLimits", { enterprise: [9] }),
        enterpriseOnlyRow("rowHardware", { enterprise: [10] }),
        enterpriseOnlyRow("rowEarlyAccess", { enterprise: [12] })
      ]
    }
  ];
}

/** Every row across every group, flattened, in render order. */
export function listComparisonRows(locale: PlanCopyLocale = "en"): ComparisonRow[] {
  return buildComparisonGroups(locale).flatMap((g) => g.rows);
}

/** Feature-array positions covered by the table, per tier. */
export function coveredIndices(tier: PlanTier): Set<number> {
  const covered = new Set<number>();
  for (const row of listComparisonRows()) {
    for (const index of row.covers[tier] ?? []) covered.add(index);
  }
  return covered;
}
