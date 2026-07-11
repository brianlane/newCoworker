/**
 * Gemini spend-velocity alert — pure logic shared by the
 * `chat-spend-velocity-alerts` Edge cron (compute + email copy) and the
 * Next.js admin settings route (config parsing/clamping), so the two
 * surfaces can never disagree about what the knobs mean.
 *
 * The period cap (owner_chat_model_spend vs base+credit) bounds TOTAL
 * monthly spend; this watchdog bounds the RATE: "more than $X within Y
 * minutes" across any single business, computed from rolling snapshots the
 * cron takes each tick — no hot-path writes.
 */

export const SPEND_VELOCITY_SETTINGS_KEY = "chat_spend_velocity_alert";

export type SpendVelocityConfig = {
  enabled: boolean;
  /** Rolling-window spend delta that triggers the alert (micro-USD). */
  thresholdMicros: number;
  /** Rolling window length in minutes. */
  windowMinutes: number;
};

/** Requested launch defaults: on, $3 per 2 hours. */
export const DEFAULT_SPEND_VELOCITY_CONFIG: SpendVelocityConfig = {
  enabled: true,
  thresholdMicros: 3_000_000,
  windowMinutes: 120
};

export const MIN_WINDOW_MINUTES = 10;
export const MAX_WINDOW_MINUTES = 24 * 60;
export const MIN_THRESHOLD_MICROS = 100_000; // $0.10 — below this it's all noise

/**
 * Parse a stored settings jsonb defensively. Missing row / legacy shape ⇒
 * the defaults; out-of-range numbers are clamped rather than rejected so a
 * hand-edited row can never wedge the cron.
 */
export function parseSpendVelocityConfig(value: unknown): SpendVelocityConfig {
  if (value === null || typeof value !== "object") {
    return { ...DEFAULT_SPEND_VELOCITY_CONFIG };
  }
  const o = value as Record<string, unknown>;
  const enabled =
    typeof o.enabled === "boolean" ? o.enabled : DEFAULT_SPEND_VELOCITY_CONFIG.enabled;
  const rawThreshold = Number(o.threshold_micros);
  const thresholdMicros =
    Number.isFinite(rawThreshold) && rawThreshold > 0
      ? Math.max(MIN_THRESHOLD_MICROS, Math.floor(rawThreshold))
      : DEFAULT_SPEND_VELOCITY_CONFIG.thresholdMicros;
  const rawWindow = Number(o.window_minutes);
  const windowMinutes =
    Number.isFinite(rawWindow) && rawWindow > 0
      ? Math.min(MAX_WINDOW_MINUTES, Math.max(MIN_WINDOW_MINUTES, Math.floor(rawWindow)))
      : DEFAULT_SPEND_VELOCITY_CONFIG.windowMinutes;
  return { enabled, thresholdMicros, windowMinutes };
}

/** The jsonb shape persisted in admin_platform_settings. */
export function serializeSpendVelocityConfig(config: SpendVelocityConfig): {
  enabled: boolean;
  threshold_micros: number;
  window_minutes: number;
} {
  return {
    enabled: config.enabled,
    threshold_micros: config.thresholdMicros,
    window_minutes: config.windowMinutes
  };
}

export type SpendRow = {
  business_id: string;
  period_start: string;
  spend_micros: number;
};

export type SnapshotRow = SpendRow & { captured_at: string };

export type AlertRow = {
  business_id: string;
  alerted_at: string;
};

export type VelocityBreach = {
  businessId: string;
  /** Spend accrued inside the window (micro-USD). */
  deltaMicros: number;
  /** The baseline snapshot value the delta was measured against. */
  baselineMicros: number;
  periodStart: string;
};

/**
 * A business can hold spend rows for multiple periods (month windows);
 * velocity is only meaningful against the CURRENT one — the row with the
 * latest period_start per business.
 */
export function latestSpendPerBusiness(rows: SpendRow[]): SpendRow[] {
  const byBusiness = new Map<string, SpendRow>();
  for (const row of rows) {
    const existing = byBusiness.get(row.business_id);
    if (!existing || row.period_start > existing.period_start) {
      byBusiness.set(row.business_id, row);
    }
  }
  return [...byBusiness.values()];
}

/**
 * Compute which businesses breached the velocity threshold.
 *
 * Per business (current-period spend row `current`):
 *   * baseline = the OLDEST snapshot inside the window with the SAME
 *     period_start (so a month/billing rollover never yields a negative or
 *     cross-period delta).
 *   * If the period itself started inside the window, baseline is 0 — all
 *     of the row's spend happened within the window by definition.
 *   * No usable baseline (brand-new spend row, first tick after enabling)
 *     ⇒ skipped; the snapshot taken this tick makes the next tick
 *     computable. Detection latency is therefore one cron tick, bounded.
 *   * Deduped: a business alerted within the last window is skipped.
 *
 * Breach condition is strictly MORE THAN the threshold, matching the
 * admin-facing copy ("alert if it spends more than $X in Y minutes").
 */
export function computeVelocityBreaches(args: {
  current: SpendRow[];
  snapshots: SnapshotRow[];
  recentAlerts: AlertRow[];
  config: SpendVelocityConfig;
  now?: Date;
}): VelocityBreach[] {
  const now = args.now ?? new Date();
  const windowStartMs = now.getTime() - args.config.windowMinutes * 60_000;

  const alertedRecently = new Set<string>();
  for (const alert of args.recentAlerts) {
    if (new Date(alert.alerted_at).getTime() >= windowStartMs) {
      alertedRecently.add(alert.business_id);
    }
  }

  const breaches: VelocityBreach[] = [];
  for (const current of latestSpendPerBusiness(args.current)) {
    if (alertedRecently.has(current.business_id)) continue;

    let baseline: number | null = null;
    if (new Date(current.period_start).getTime() >= windowStartMs) {
      // The whole period lives inside the window.
      baseline = 0;
    } else {
      let oldestInWindow: SnapshotRow | null = null;
      for (const snap of args.snapshots) {
        if (snap.business_id !== current.business_id) continue;
        if (snap.period_start !== current.period_start) continue;
        const at = new Date(snap.captured_at).getTime();
        if (at < windowStartMs) continue;
        if (
          !oldestInWindow ||
          at < new Date(oldestInWindow.captured_at).getTime()
        ) {
          oldestInWindow = snap;
        }
      }
      if (oldestInWindow) baseline = oldestInWindow.spend_micros;
    }

    if (baseline === null) continue;
    const delta = current.spend_micros - baseline;
    if (delta > args.config.thresholdMicros) {
      breaches.push({
        businessId: current.business_id,
        deltaMicros: delta,
        baselineMicros: baseline,
        periodStart: current.period_start
      });
    }
  }
  return breaches;
}

export function microsToUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/** Admin alert email copy. Plain text, mirrors the other ops alerts. */
export function formatSpendVelocityEmail(args: {
  breach: VelocityBreach;
  config: SpendVelocityConfig;
  businessName: string | null;
}): { subject: string; text: string } {
  const name = args.businessName?.trim() || args.breach.businessId;
  const subject = `AI spend velocity alert: ${name} burned ${microsToUsd(args.breach.deltaMicros)} in ${args.config.windowMinutes} min`;
  const text = [
    `Business "${name}" (${args.breach.businessId}) spent ${microsToUsd(args.breach.deltaMicros)} of shared Gemini budget`,
    `within the last ${args.config.windowMinutes} minutes — over the configured ${microsToUsd(args.config.thresholdMicros)} alert threshold.`,
    "",
    `Period spend is now ${microsToUsd(args.breach.baselineMicros + args.breach.deltaMicros)} (was ${microsToUsd(args.breach.baselineMicros)} at the start of the window).`,
    "",
    "If this is unexpected, check the business's chat/webchat activity and consider",
    "pausing the surface or lowering its credit. Configure this alert under Admin → System.",
    "",
    "You will not be re-alerted for this business until the current window passes."
  ].join("\n");
  return { subject, text };
}
