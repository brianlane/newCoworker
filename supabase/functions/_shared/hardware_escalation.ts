/**
 * Hardware-escalation advisor — pure signal evaluation + email shaping.
 *
 * The daily `hardware-escalation-advisor` cron watches every active
 * starter/standard tenant for sustained load that suggests their box is (or
 * soon will be) too small, then emails the OPS inbox recommending a manual
 * escalation (the admin panel's migrate-size flow — escalation itself stays
 * a human decision; nothing here moves hardware).
 *
 * Signals (rolling 7-day window over `daily_usage` + `system_logs`):
 *   - concurrency_saturation: peak_concurrent_calls reached the tier's
 *     advertised cap on ≥ CONCURRENCY_DAYS days. The tenant is bouncing off
 *     their concurrency ceiling — the strongest "needs bigger box / plan"
 *     indicator we collect.
 *   - voice_volume: 7-day voice minutes, extrapolated to a 30-day month,
 *     ≥ VOICE_UTILIZATION of the tier's included pool. Voice-heavy tenants
 *     are the ones that stress CPU (Gemini Live bridging).
 *   - sms_volume: month-to-date SMS ≥ SMS_UTILIZATION of the monthly cap.
 *     More an upsell signal than hardware pressure, but the operator wants
 *     to see it in the same digest.
 *   - system_errors: ≥ ERROR_COUNT error-level `system_logs` rows from the
 *     on-box sources (rowboat / ollama / voice) in the window — the "this
 *     box is actually choking" signal (OOM, container crashes).
 *
 * Dependency-free (caller injects rows) so vitest covers it under the
 * shared 100% gate, mirroring cap_alerts.ts / voice_bridge_health.ts.
 */

export type AdvisorTier = "starter" | "standard";

/** Hardware ladder used for the recommendation line. */
export type AdvisorVpsSize = "kvm1" | "kvm2" | "kvm4" | "kvm8";

export type AdvisorBusiness = {
  id: string;
  name: string;
  tier: AdvisorTier;
  /** Raw businesses.vps_size pin (may be null / corrupt). */
  vps_size: string | null;
};

export type DailyUsageRow = {
  business_id: string;
  usage_date: string;
  voice_minutes_used: number;
  sms_sent: number;
  peak_concurrent_calls: number;
};

export type AdvisorThresholds = {
  /** Days (out of the window) at the concurrency cap before firing. */
  concurrencySaturationDays: number;
  /** Fraction of the included monthly voice pool (extrapolated). */
  voiceUtilization: number;
  /** Fraction of the monthly SMS cap (month-to-date). */
  smsUtilization: number;
  /** Error-level on-box system_logs rows in the window. */
  systemErrorCount: number;
};

export const DEFAULT_THRESHOLDS: AdvisorThresholds = {
  concurrencySaturationDays: 2,
  voiceUtilization: 0.8,
  smsUtilization: 0.8,
  systemErrorCount: 25
};

/** On-box log sources that indicate hardware pressure (not app bugs). */
export const ON_BOX_ERROR_SOURCES = ["rowboat", "ollama", "voice"] as const;

export type EscalationSignal =
  | { kind: "concurrency_saturation"; daysAtCap: number; capCalls: number }
  | { kind: "voice_volume"; projectedMonthlyMinutes: number; includedMinutes: number }
  | { kind: "sms_volume"; monthToDateSms: number; capSms: number }
  | { kind: "system_errors"; errorCount: number };

export type BusinessAdvice = {
  businessId: string;
  businessName: string;
  tier: AdvisorTier;
  currentSize: AdvisorVpsSize;
  recommendedSize: AdvisorVpsSize | null;
  signals: EscalationSignal[];
};

/**
 * Deployed-box semantics, duplicated from src/lib/vps/size.ts
 * (`resolveDeployedVpsSize`) because Edge code cannot import src/lib: an
 * unpinned starter is legacy KVM2 hardware, an unpinned standard is legacy
 * KVM8. Keep in lockstep.
 */
export function advisorDeployedSize(tier: AdvisorTier, pin: string | null): AdvisorVpsSize {
  if (pin === "kvm1" || pin === "kvm2" || pin === "kvm4" || pin === "kvm8") return pin;
  return tier === "starter" ? "kvm2" : "kvm8";
}

/** Next rung on the ladder; null when already on the biggest box. */
export function nextSizeUp(size: AdvisorVpsSize): AdvisorVpsSize | null {
  if (size === "kvm1") return "kvm2";
  if (size === "kvm2") return "kvm4";
  if (size === "kvm4") return "kvm8";
  return null;
}

/** ISO date (UTC) of the Monday of `now`'s week — once-per-week dedupe key. */
export function weeklyPeriodKey(now: Date = new Date()): string {
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = utc.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? 6 : day - 1;
  utc.setUTCDate(utc.getUTCDate() - diff);
  return utc.toISOString().slice(0, 10);
}

export type EvaluateInput = {
  business: AdvisorBusiness;
  /** This business's daily_usage rows for the window (any order). */
  usageRows: DailyUsageRow[];
  /** This business's month-to-date SMS total (cap is a calendar month). */
  monthToDateSms: number;
  /** Error-level on-box system_logs count in the window. */
  onBoxErrorCount: number;
  /** Tier entitlements (lockstep with VOICE_RES_LIMITS / SMS caps). */
  limits: {
    maxConcurrentCalls: number;
    voiceIncludedSecondsPerStripePeriod: number;
    smsPerMonth: number;
  };
  thresholds?: AdvisorThresholds;
};

/**
 * Evaluate one tenant. Returns null when no signal fires (the common case),
 * otherwise the advice block for the ops digest.
 */
export function evaluateEscalationSignals(input: EvaluateInput): BusinessAdvice | null {
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const signals: EscalationSignal[] = [];

  const capCalls = input.limits.maxConcurrentCalls;
  const daysAtCap = input.usageRows.filter((r) => r.peak_concurrent_calls >= capCalls).length;
  if (capCalls > 0 && daysAtCap >= t.concurrencySaturationDays) {
    signals.push({ kind: "concurrency_saturation", daysAtCap, capCalls });
  }

  const windowMinutes = input.usageRows.reduce((sum, r) => sum + r.voice_minutes_used, 0);
  const windowDays = Math.max(input.usageRows.length, 1);
  const projectedMonthlyMinutes = Math.round((windowMinutes / windowDays) * 30);
  const includedMinutes = Math.round(input.limits.voiceIncludedSecondsPerStripePeriod / 60);
  if (includedMinutes > 0 && projectedMonthlyMinutes >= includedMinutes * t.voiceUtilization) {
    signals.push({ kind: "voice_volume", projectedMonthlyMinutes, includedMinutes });
  }

  const capSms = input.limits.smsPerMonth;
  if (Number.isFinite(capSms) && capSms > 0 && input.monthToDateSms >= capSms * t.smsUtilization) {
    signals.push({ kind: "sms_volume", monthToDateSms: input.monthToDateSms, capSms });
  }

  if (input.onBoxErrorCount >= t.systemErrorCount) {
    signals.push({ kind: "system_errors", errorCount: input.onBoxErrorCount });
  }

  if (signals.length === 0) return null;

  const currentSize = advisorDeployedSize(input.business.tier, input.business.vps_size);
  return {
    businessId: input.business.id,
    businessName: input.business.name,
    tier: input.business.tier,
    currentSize,
    recommendedSize: nextSizeUp(currentSize),
    signals
  };
}

function describeSignal(s: EscalationSignal): string {
  if (s.kind === "concurrency_saturation") {
    return `hit the ${s.capCalls}-concurrent-call cap on ${s.daysAtCap} of the last 7 days`;
  }
  if (s.kind === "voice_volume") {
    return `on pace for ~${s.projectedMonthlyMinutes} voice min/month (${s.includedMinutes} included)`;
  }
  if (s.kind === "sms_volume") {
    return `${s.monthToDateSms} SMS month-to-date (cap ${s.capSms})`;
  }
  return `${s.errorCount} on-box error logs in the last 7 days (rowboat/ollama/voice)`;
}

/**
 * Ops digest email for every flagged tenant in one send (one email per run,
 * not per business — the operator wants a single morning digest).
 */
export function buildEscalationAdviceEmail(
  advices: BusinessAdvice[],
  siteUrl: string
): { subject: string; text: string } {
  const subject =
    advices.length === 1
      ? `[ops] Hardware escalation candidate — ${advices[0].businessName} (${advices[0].currentSize})`
      : `[ops] ${advices.length} hardware escalation candidates`;

  const blocks = advices.map((a) => {
    const rec = a.recommendedSize
      ? `Recommended: escalate ${a.currentSize} → ${a.recommendedSize} from the admin panel.`
      : `Already on the largest box (${a.currentSize}) — consider a plan/entitlement conversation instead.`;
    return [
      `${a.businessName} (${a.tier}/${a.currentSize})`,
      ...a.signals.map((s) => `  - ${describeSignal(s)}`),
      `  ${rec}`,
      `  ${siteUrl}/admin/${a.businessId}`
    ].join("\n");
  });

  const text = [
    "Sustained-load review (rolling 7 days). These tenants tripped at least one escalation signal.",
    "Escalation is manual by design: use the Infrastructure card on each admin page to migrate hardware.",
    "",
    blocks.join("\n\n"),
    "",
    "You'll be reminded at most once per week per tenant while the condition persists."
  ].join("\n");

  return { subject, text };
}
