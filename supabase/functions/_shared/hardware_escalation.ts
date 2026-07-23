/**
 * Hardware-escalation advisor — pure signal evaluation + email shaping.
 *
 * The daily `hardware-escalation-advisor` cron watches every active
 * starter/standard tenant for sustained load that suggests their box is (or
 * soon will be) too small, then emails the OPS inbox recommending a manual
 * escalation (the admin panel's migrate-size flow — escalation itself stays
 * a human decision; nothing here moves hardware).
 *
 * Signals (rolling 7-day window over `voice_call_transcripts`,
 * `voice_settlements`, `daily_usage`, and `system_logs`):
 *   - concurrency_saturation: the per-day peak of simultaneously-open calls
 *     (derived from transcript started_at/ended_at overlap via
 *     {@link dailyPeakConcurrency}) reached the tier's advertised cap on
 *     ≥ CONCURRENCY_DAYS days. The tenant is bouncing off their concurrency
 *     ceiling — the strongest "needs bigger box / plan" indicator we
 *     collect. NOT `daily_usage.peak_concurrent_calls`: that column has no
 *     live production writer (the SMS reserve path inserts it as zero), so
 *     reading it meant this signal could never fire.
 *   - voice_volume: 7-day settled voice seconds
 *     (`voice_settlements.billable_seconds`, the billing ground truth),
 *     extrapolated to a 30-day month, ≥ VOICE_UTILIZATION of the tier's
 *     included pool. Voice-heavy tenants are the ones that stress CPU
 *     (Gemini Live bridging). NOT `daily_usage.voice_minutes_used` — dead
 *     for the same reason as `peak_concurrent_calls`.
 *   - sms_volume: month-to-date SMS ≥ SMS_UTILIZATION of the monthly cap
 *     (`daily_usage.sms_sent` — the one column the SMS reserve functions DO
 *     write). More an upsell signal than hardware pressure, but the
 *     operator wants to see it in the same digest.
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
  sms_sent: number;
};

/** One call's [start, end) wall-clock interval (epoch ms). */
export type CallInterval = {
  startMs: number;
  endMs: number;
};

/**
 * Per-UTC-day peak of simultaneously-open calls from [start, end)
 * intervals: sweep the +1/-1 events in time order (ends sort before starts
 * at the same instant, so back-to-back calls never count as overlap) and
 * record each day's maximum live-call count at its event times. A call
 * crossing midnight contributes to its end day via the end event's
 * pre-close count; a day a call spans END TO END with no events records
 * nothing — acceptable, real calls are minutes long.
 */
export function dailyPeakConcurrency(intervals: CallInterval[]): Map<string, number> {
  const events: Array<{ atMs: number; delta: 1 | -1 }> = [];
  for (const { startMs, endMs } of intervals) {
    events.push({ atMs: startMs, delta: 1 });
    events.push({ atMs: endMs, delta: -1 });
  }
  events.sort((a, b) => a.atMs - b.atMs || a.delta - b.delta);
  const peaks = new Map<string, number>();
  let open = 0;
  for (const event of events) {
    // Live calls at this instant: a start includes itself; an end is still
    // live just before it closes (so a cross-midnight call marks its end day).
    const live = event.delta === 1 ? open + 1 : open;
    open += event.delta;
    const day = new Date(event.atMs).toISOString().slice(0, 10);
    if (live > (peaks.get(day) ?? 0)) peaks.set(day, live);
  }
  return peaks;
}

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

/**
 * Fixed rolling window (days) for every signal. Extrapolations divide by
 * this constant — NOT by the number of `daily_usage` rows — because rows
 * only exist on days with activity: a 2-day burst divided by 2 rows would
 * masquerade as a sustained month-long pace.
 */
export const ADVISOR_WINDOW_DAYS = 7;

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
  /** This business's window call intervals from voice_call_transcripts (any order). */
  callIntervals: CallInterval[];
  /**
   * Inclusive UTC day bounds (YYYY-MM-DD) of the rolling window. Only peak
   * days inside these bounds count toward `daysAtCap`, so a stray interval
   * with a corrupt out-of-window timestamp can neither fire the signal nor
   * inflate the "N of the last 7 days" wording past the window length.
   */
  windowStartYmd: string;
  windowEndYmd: string;
  /** This business's settled billable voice seconds in the window (voice_settlements). */
  windowVoiceSeconds: number;
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
  let daysAtCap = 0;
  for (const [day, peak] of dailyPeakConcurrency(input.callIntervals)) {
    if (day < input.windowStartYmd || day > input.windowEndYmd) continue;
    if (peak >= capCalls) daysAtCap += 1;
  }
  if (capCalls > 0 && daysAtCap >= t.concurrencySaturationDays) {
    signals.push({ kind: "concurrency_saturation", daysAtCap, capCalls });
  }

  const windowMinutes = input.windowVoiceSeconds / 60;
  const projectedMonthlyMinutes = Math.round((windowMinutes / ADVISOR_WINDOW_DAYS) * 30);
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
      ? `[ops] Hardware escalation candidate, ${advices[0].businessName} (${advices[0].currentSize})`
      : `[ops] ${advices.length} hardware escalation candidates`;

  const blocks = advices.map((a) => {
    const rec = a.recommendedSize
      ? `Recommended: escalate ${a.currentSize} → ${a.recommendedSize} from the admin panel.`
      : `Already on the largest box (${a.currentSize}), consider a plan/entitlement conversation instead.`;
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
