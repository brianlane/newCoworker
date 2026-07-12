/**
 * Margin alert — the ops watchdog for tenants whose ACTUAL monthly margin
 * (src/lib/admin/margin.ts, vendor actuals where synced) drops below a
 * configurable floor. Runs piggybacked on the daily platform cost sync
 * (the moment the freshest vendor numbers exist), emails the ops inbox a
 * digest, and is configured from the Costs page through
 * POST /api/admin/margin-alert — same admin_platform_settings pattern as
 * the Gemini spend-velocity watchdog.
 *
 * Only PAYING tenants alert (revenueSource !== "none"): idle pilots and
 * smoke clones always run at a loss by design and live on the Costs page's
 * burn views instead.
 */

import type { BusinessMarginEconomics } from "@/lib/admin/margin";

export const MARGIN_ALERT_SETTINGS_KEY = "margin_alert_config";

/** Alert when a paying tenant's margin falls below $0/mo unless configured otherwise. */
export const DEFAULT_MARGIN_ALERT_THRESHOLD_CENTS = 0;
export const MIN_THRESHOLD_CENTS = -100_000; // -$1,000
export const MAX_THRESHOLD_CENTS = 100_000; // $1,000

export type MarginAlertConfig = {
  enabled: boolean;
  /** Alert when marginCents < thresholdCents. */
  thresholdCents: number;
};

export function parseMarginAlertConfig(raw: unknown): MarginAlertConfig {
  const defaults: MarginAlertConfig = {
    enabled: false,
    thresholdCents: DEFAULT_MARGIN_ALERT_THRESHOLD_CENTS
  };
  if (raw === null || typeof raw !== "object") return defaults;
  const r = raw as Record<string, unknown>;
  const threshold =
    typeof r.thresholdCents === "number" && Number.isFinite(r.thresholdCents)
      ? Math.round(
          Math.min(MAX_THRESHOLD_CENTS, Math.max(MIN_THRESHOLD_CENTS, r.thresholdCents))
        )
      : defaults.thresholdCents;
  return {
    enabled: r.enabled === true,
    thresholdCents: threshold
  };
}

export function serializeMarginAlertConfig(config: MarginAlertConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    thresholdCents: config.thresholdCents
  };
}

export type MarginAlertBreach = {
  businessId: string;
  businessName: string;
  revenueCents: number;
  costCents: number;
  marginCents: number;
};

/** Paying tenants below the floor, worst margin first. */
export function findMarginBreaches(params: {
  economics: BusinessMarginEconomics[];
  businessNames: Map<string, string>;
  config: MarginAlertConfig;
}): MarginAlertBreach[] {
  return params.economics
    .filter(
      (e) => e.revenueSource !== "none" && e.marginCents < params.config.thresholdCents
    )
    .map((e) => ({
      businessId: e.businessId,
      businessName:
        params.businessNames.get(e.businessId) ?? `${e.businessId.slice(0, 8)}…`,
      revenueCents: e.revenueCents,
      costCents: e.costCents,
      marginCents: e.marginCents
    }))
    .sort((a, b) => a.marginCents - b.marginCents);
}

export type MarginAlertRunResult = {
  enabled: boolean;
  thresholdCents: number;
  breaches: MarginAlertBreach[];
  emailed: boolean;
};

export type MarginAlertDeps = {
  getConfigRaw: () => Promise<unknown>;
  loadEconomics: () => Promise<{
    economics: BusinessMarginEconomics[];
    businessNames: Map<string, string>;
  }>;
  sendAlertEmail: (input: {
    breaches: MarginAlertBreach[];
    thresholdCents: number;
  }) => Promise<void>;
};

/** Check the fleet and email the digest; disabled or clean runs send nothing. */
export async function runMarginAlert(deps: MarginAlertDeps): Promise<MarginAlertRunResult> {
  const config = parseMarginAlertConfig(await deps.getConfigRaw());
  if (!config.enabled) {
    return {
      enabled: false,
      thresholdCents: config.thresholdCents,
      breaches: [],
      emailed: false
    };
  }
  const { economics, businessNames } = await deps.loadEconomics();
  const breaches = findMarginBreaches({ economics, businessNames, config });
  if (breaches.length > 0) {
    await deps.sendAlertEmail({ breaches, thresholdCents: config.thresholdCents });
  }
  return {
    enabled: true,
    thresholdCents: config.thresholdCents,
    breaches,
    emailed: breaches.length > 0
  };
}
