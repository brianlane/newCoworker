/**
 * Hardware-escalation advisor, pure signal evaluation + email shaping.
 *
 * The daily `hardware-escalation-advisor` cron watches every active
 * starter/standard tenant, then emails the OPS inbox. Escalation itself
 * stays a human decision; nothing here moves hardware.
 *
 * ## Two kinds of signal, and why they are kept apart
 *
 * This module used to treat every signal as a reason to buy a bigger box.
 * That was wrong for half of them. A tenant approaching their INCLUDED voice
 * minutes is approaching a Stripe entitlement, not a machine limit, and
 * reloadable packs and auto-reload cover it without the hardware changing at
 * all: the advisor was recommending a KVM 4 to a tenant whose box was 99.9%
 * idle and whose card was already armed to top them up. Worse, running OUT
 * of voice minutes makes a box do LESS work, since the calls are refused.
 *
 * So signals now carry a category:
 *
 * - **hardware** signals describe the machine, and only these produce a size
 *   recommendation and the migrate-size link.
 * - **usage** signals describe a plan limit, and link to billing instead.
 *   They are suppressed entirely for a tenant whose auto-reload is armed
 *   with a live card, because that tenant cannot run out.
 *
 * ## Hardware signals
 *
 *   - concurrency_saturation: the per-day peak of simultaneously-open calls
 *     (from transcript start/end overlap via {@link dailyPeakConcurrency})
 *     reached the tier's advertised cap on >= CONCURRENCY_DAYS days. NOT
 *     `daily_usage.peak_concurrent_calls`: that column has no live
 *     production writer, so reading it meant this signal could never fire.
 *   - cpu_saturation: the box's own load average, per core, from the
 *     heartbeat's hourly `vps_posture_reports.metrics` aggregate. This is
 *     the signal the module previously had no way to compute, and it is the
 *     only one that directly answers "is this box too small".
 *   - memory_pressure: available memory under a floor, or swap genuinely in
 *     use, from the same aggregate.
 *   - local_model_fallback: turns actually generated on the box's own Ollama
 *     model. This is the AI budget's REAL hardware consequence: over cap,
 *     `pickSmsTurn` routes SMS, owner chat, and webchat to the local twin
 *     agents, so work moves from Google's hardware onto 2 shared vCPUs.
 *     Both surfaces were moved OFF that model for being too slow (owner chat
 *     measured ~100s+ a turn, SMS routinely >20s), so this fires on ONE
 *     occurrence: it means a tenant is living in the configuration we
 *     abandoned. On kvm1 there is no local model and the turn is refused
 *     outright, which is an outage rather than a slowdown.
 *   - system_errors: >= ERROR_COUNT error-level `system_logs` rows from the
 *     on-box sources (rowboat / ollama / voice), the "this box is actually
 *     choking" signal (OOM, container crashes).
 *
 * ## Usage signals
 *
 *   - voice_volume: 7-day settled voice seconds
 *     (`voice_settlements.billable_seconds`, the billing ground truth)
 *     extrapolated to 30 days, against the included pool PLUS unexpired
 *     `voice_bonus_grants`. Counting packs is not a refinement: without it
 *     this fires at a tenant sitting on 600 purchased minutes, which is the
 *     same defect `20260822061519_voice_low_balance_counts_bonus.sql` fixed
 *     for the low-balance email.
 *   - sms_volume: month-to-date SMS against the monthly cap plus unexpired
 *     `sms_bonus_grants`. Denominated in TEXT UNITS
 *     (`daily_usage.sms_text_units`), which is what Postgres actually
 *     enforces. It previously summed `daily_usage.sms_sent`, a count of
 *     MESSAGES, against a cap denominated in units: the fleet averages ~2.5
 *     parts per message, so the signal fired ~2.5x too late and the email
 *     compared two different things to the operator's face.
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

/**
 * Fleet-scan gate for the hardware-escalation advisor cron. Paused tenants
 * cannot generate load; boxless tenants (`hostinger_vps_id` null/empty) have
 * nothing to escalate: recommending kvmN -> kvmM for them is always wrong
 * (cancel/handoff grace tenants like Truly after a box cutover).
 */
export type AdvisorFleetRow = {
  is_paused: boolean | null;
  hostinger_vps_id: string | number | null;
};

export function isAdvisorFleetCandidate(row: AdvisorFleetRow): boolean {
  if (row.is_paused) return false;
  if (row.hostinger_vps_id == null || row.hostinger_vps_id === "") return false;
  return true;
}

export type DailyUsageRow = {
  business_id: string;
  usage_date: string;
  /**
   * Carrier PARTS, weighted (MMS counts 2.2). This is the ledger the caps
   * are denominated in and the one `try_reserve_sms_outbound_slot` refuses
   * against. The sibling `sms_sent` column counts messages and must not be
   * compared to a cap.
   */
  sms_text_units: number;
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
 * nothing, acceptable, real calls are minutes long.
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
  /** Fraction of the monthly voice allowance (included + packs), extrapolated. */
  voiceUtilization: number;
  /** Fraction of the monthly SMS allowance (cap + packs), month-to-date. */
  smsUtilization: number;
  /** Error-level on-box system_logs rows in the window. */
  systemErrorCount: number;
  /** Mean load PER CORE, over an hourly report, that counts as saturated. */
  cpuLoadPerCore: number;
  /** Saturated hourly reports in the window before cpu_saturation fires. */
  cpuSaturatedReports: number;
  /** Available-memory fraction, at an hourly low, that counts as pressure. */
  memoryAvailableFloor: number;
  /** Swap in use (MiB), at an hourly high, that counts as pressure. */
  swapUsedMib: number;
  /** Pressured hourly reports in the window before memory_pressure fires. */
  memoryPressuredReports: number;
};

export const DEFAULT_THRESHOLDS: AdvisorThresholds = {
  concurrencySaturationDays: 2,
  voiceUtilization: 0.8,
  smsUtilization: 0.8,
  systemErrorCount: 25,
  // 0.8 mean load per core over an hour means the box spent that hour with
  // most of its cores busy. Anchored against what the fleet actually reads
  // when idle: Amy's KVM 2 sits at 0.07 total across 2 cores, so 0.8/core is
  // more than an order of magnitude above baseline, not a tight tolerance.
  cpuLoadPerCore: 0.8,
  // 6 saturated hours out of the window's ~168 hourly reports. One busy hour
  // is a backup or a burst; six is a pattern.
  cpuSaturatedReports: 6,
  // Below 10% available. The posture check's own floor is 8% and it is a
  // pass/fail alarm; this is the earlier, softer capacity reading.
  memoryAvailableFloor: 0.1,
  // Swap is the honest early signal on these boxes, but never zero-tolerance:
  // Amy's box idles with 15 MiB in use, so a floor well above that is needed
  // for "genuinely swapping" rather than "has ever swapped".
  swapUsedMib: 512,
  memoryPressuredReports: 6
};

/** On-box log sources that indicate hardware pressure (not app bugs). */
export const ON_BOX_ERROR_SOURCES = ["rowboat", "ollama", "voice"] as const;

export type EscalationSignal =
  // --- hardware: these describe the machine ---
  | { kind: "concurrency_saturation"; daysAtCap: number; capCalls: number }
  | {
      kind: "cpu_saturation";
      saturatedReports: number;
      totalReports: number;
      worstMeanLoadPerCore: number;
      cpuCount: number;
    }
  | {
      kind: "memory_pressure";
      pressuredReports: number;
      totalReports: number;
      lowestAvailableFraction: number;
      highestSwapUsedMib: number;
    }
  | { kind: "local_model_fallback"; localTurns: number; refusedTurns: number; hasLocalModel: boolean }
  | { kind: "system_errors"; errorCount: number }
  // --- usage: these describe a plan limit ---
  | {
      kind: "voice_volume";
      projectedMonthlyMinutes: number;
      includedMinutes: number;
      packMinutes: number;
    }
  | { kind: "sms_volume"; monthToDateUnits: number; capUnits: number; packUnits: number };

export type SignalCategory = "hardware" | "usage";

/**
 * Which section of the digest a signal belongs to. The split is the whole
 * point of this module: only `hardware` produces a size recommendation, and
 * a `usage` signal must never carry one, because buying a bigger box does
 * nothing about a plan limit.
 */
export function signalCategory(kind: EscalationSignal["kind"]): SignalCategory {
  return kind === "voice_volume" || kind === "sms_volume" ? "usage" : "hardware";
}

export type BusinessAdvice = {
  businessId: string;
  businessName: string;
  tier: AdvisorTier;
  currentSize: AdvisorVpsSize;
  /**
   * Next rung up, or null. Null both when the box is already the largest AND
   * whenever no hardware signal fired: a tenant flagged only for usage has
   * no hardware advice to give, and printing one anyway is the bug this
   * module was rewritten to remove.
   */
  recommendedSize: AdvisorVpsSize | null;
  /** Every signal, in the order evaluated. */
  signals: EscalationSignal[];
  hardwareSignals: EscalationSignal[];
  usageSignals: EscalationSignal[];
};

/** Hourly host-metrics aggregate as the advisor consumes it. */
export type AdvisorHostMetrics = {
  cpuCount: number;
  load1Max: number;
  load1Mean: number;
  memAvailableMinMib: number;
  memTotalMib: number;
  swapUsedMaxMib: number;
  samples: number;
};

/**
 * Sample floor before an hourly aggregate counts. Mirrors
 * MIN_METRIC_SAMPLES in src/lib/vps/host-metrics.ts (Edge cannot import
 * src/lib). 10 of the ~30 samples in an hour: enough that a quiet reading
 * means the box was quiet, not that we only looked twice.
 */
export const ADVISOR_MIN_METRIC_SAMPLES = 10;

/**
 * Auto-reload posture for one tenant, per usage category. A tenant who is
 * armed with a live card cannot run out of that category, so a "you are
 * approaching your limit" line is noise: billing is already handling it.
 */
export type AdvisorAutoReload = {
  /** A rule row exists, is enabled, and is not paused or disabled. */
  voiceArmed: boolean;
  smsArmed: boolean;
  /** An un-revoked card is on file. Without one no rule can charge. */
  hasCard: boolean;
};

export function autoReloadCovers(
  reload: AdvisorAutoReload | null,
  category: "voice" | "sms"
): boolean {
  if (!reload || !reload.hasCard) return false;
  return category === "voice" ? reload.voiceArmed : reload.smsArmed;
}

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
 * this constant, NOT by the number of `daily_usage` rows, because rows
 * only exist on days with activity: a 2-day burst divided by 2 rows would
 * masquerade as a sustained month-long pace.
 */
export const ADVISOR_WINDOW_DAYS = 7;

/** ISO date (UTC) of the Monday of `now`'s week, once-per-week dedupe key. */
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
  /**
   * Month-to-date SMS in TEXT UNITS (`daily_usage.sms_text_units`), the
   * ledger `try_reserve_sms_outbound_slot` actually enforces. NOT
   * `sms_sent`: that counts messages, the caps count carrier parts, and the
   * fleet averages ~2.5 parts per message.
   */
  monthToDateSmsUnits: number;
  /** Error-level on-box system_logs count in the window. */
  onBoxErrorCount: number;
  /**
   * Hourly host aggregates in the window, from `vps_posture_reports.metrics`.
   * Empty for a box whose heartbeat predates the metrics block, which must
   * read as "not measured" and fire nothing, never as a quiet box.
   */
  hostMetrics?: AdvisorHostMetrics[];
  /**
   * Replies actually generated on the box's own model in the window
   * (`ai_reply_reasoning` where model = 'local').
   */
  localModelTurns?: number;
  /**
   * Inbound turns REFUSED for lack of a local model in the window
   * (`sms_reply_suppressed_over_ai_budget`). kvm1 only, and an outage rather
   * than a slowdown: the customer got silence.
   */
  refusedOverBudgetTurns?: number;
  /** Unexpired, unvoided voice pack seconds (voice_bonus_grants). */
  voiceBonusSeconds?: number;
  /** Unexpired, unvoided SMS pack text units (sms_bonus_grants). */
  smsBonusUnits?: number;
  /** Auto-reload posture, or null when it could not be read. */
  autoReload?: AdvisorAutoReload | null;
  /** Tier entitlements (lockstep with VOICE_RES_LIMITS / SMS caps). */
  limits: {
    maxConcurrentCalls: number;
    voiceIncludedSecondsPerStripePeriod: number;
    smsPerMonth: number;
  };
  thresholds?: AdvisorThresholds;
};

/** Hourly aggregates worth reasoning about (enough samples to be evidence). */
function usableMetrics(
  rows: AdvisorHostMetrics[],
  minSamples: number = ADVISOR_MIN_METRIC_SAMPLES
): AdvisorHostMetrics[] {
  return rows.filter((m) => m.samples >= minSamples && m.cpuCount >= 1 && m.memTotalMib > 0);
}

/**
 * Evaluate one tenant. Returns null when no signal fires (the common case),
 * otherwise the advice block for the ops digest.
 */
export function evaluateEscalationSignals(input: EvaluateInput): BusinessAdvice | null {
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const signals: EscalationSignal[] = [];

  // ---- hardware ----------------------------------------------------------

  const capCalls = input.limits.maxConcurrentCalls;
  let daysAtCap = 0;
  for (const [day, peak] of dailyPeakConcurrency(input.callIntervals)) {
    if (day < input.windowStartYmd || day > input.windowEndYmd) continue;
    if (peak >= capCalls) daysAtCap += 1;
  }
  if (capCalls > 0 && daysAtCap >= t.concurrencySaturationDays) {
    signals.push({ kind: "concurrency_saturation", daysAtCap, capCalls });
  }

  const metrics = usableMetrics(input.hostMetrics ?? []);
  if (metrics.length > 0) {
    let saturatedReports = 0;
    let worstMeanLoadPerCore = 0;
    let worstCpuCount = metrics[0].cpuCount;
    for (const m of metrics) {
      const perCore = m.load1Mean / m.cpuCount;
      if (perCore >= t.cpuLoadPerCore) saturatedReports += 1;
      if (perCore > worstMeanLoadPerCore) {
        worstMeanLoadPerCore = perCore;
        worstCpuCount = m.cpuCount;
      }
    }
    if (saturatedReports >= t.cpuSaturatedReports) {
      signals.push({
        kind: "cpu_saturation",
        saturatedReports,
        totalReports: metrics.length,
        worstMeanLoadPerCore,
        cpuCount: worstCpuCount
      });
    }

    let pressuredReports = 0;
    let lowestAvailableFraction = 1;
    let highestSwapUsedMib = 0;
    for (const m of metrics) {
      const availableFraction = m.memAvailableMinMib / m.memTotalMib;
      // Either symptom counts on its own: a box can be starved without
      // swapping (no swap configured) and can swap while nominally having
      // available memory (a burst that already spilled).
      if (availableFraction < t.memoryAvailableFloor || m.swapUsedMaxMib >= t.swapUsedMib) {
        pressuredReports += 1;
      }
      if (availableFraction < lowestAvailableFraction) lowestAvailableFraction = availableFraction;
      if (m.swapUsedMaxMib > highestSwapUsedMib) highestSwapUsedMib = m.swapUsedMaxMib;
    }
    if (pressuredReports >= t.memoryPressuredReports) {
      signals.push({
        kind: "memory_pressure",
        pressuredReports,
        totalReports: metrics.length,
        lowestAvailableFraction,
        highestSwapUsedMib
      });
    }
  }

  const localTurns = input.localModelTurns ?? 0;
  const refusedTurns = input.refusedOverBudgetTurns ?? 0;
  if (localTurns > 0 || refusedTurns > 0) {
    // No count threshold. Both surfaces were moved off the local model for
    // being unusable, so a single turn means a tenant is living in the
    // configuration we abandoned, and a single refusal means a customer got
    // silence. Either is worth the operator's morning.
    signals.push({
      kind: "local_model_fallback",
      localTurns,
      refusedTurns,
      hasLocalModel: localTurns > 0
    });
  }

  if (input.onBoxErrorCount >= t.systemErrorCount) {
    signals.push({ kind: "system_errors", errorCount: input.onBoxErrorCount });
  }

  // ---- usage -------------------------------------------------------------

  const windowMinutes = input.windowVoiceSeconds / 60;
  const projectedMonthlyMinutes = Math.round((windowMinutes / ADVISOR_WINDOW_DAYS) * 30);
  const includedMinutes = Math.round(input.limits.voiceIncludedSecondsPerStripePeriod / 60);
  const packMinutes = Math.round((input.voiceBonusSeconds ?? 0) / 60);
  const voiceAllowance = includedMinutes + packMinutes;
  if (
    voiceAllowance > 0 &&
    projectedMonthlyMinutes >= voiceAllowance * t.voiceUtilization &&
    !autoReloadCovers(input.autoReload ?? null, "voice")
  ) {
    signals.push({ kind: "voice_volume", projectedMonthlyMinutes, includedMinutes, packMinutes });
  }

  const capUnits = input.limits.smsPerMonth;
  const packUnits = input.smsBonusUnits ?? 0;
  const smsAllowance = capUnits + packUnits;
  if (
    Number.isFinite(capUnits) &&
    smsAllowance > 0 &&
    input.monthToDateSmsUnits >= smsAllowance * t.smsUtilization &&
    !autoReloadCovers(input.autoReload ?? null, "sms")
  ) {
    signals.push({
      kind: "sms_volume",
      monthToDateUnits: input.monthToDateSmsUnits,
      capUnits,
      packUnits
    });
  }

  if (signals.length === 0) return null;

  const hardwareSignals = signals.filter((sig) => signalCategory(sig.kind) === "hardware");
  const usageSignals = signals.filter((sig) => signalCategory(sig.kind) === "usage");
  const currentSize = advisorDeployedSize(input.business.tier, input.business.vps_size);
  return {
    businessId: input.business.id,
    businessName: input.business.name,
    tier: input.business.tier,
    currentSize,
    // A size recommendation ONLY when the machine is the problem.
    recommendedSize: hardwareSignals.length > 0 ? nextSizeUp(currentSize) : null,
    signals,
    hardwareSignals,
    usageSignals
  };
}

function describeSignal(sig: EscalationSignal): string {
  if (sig.kind === "concurrency_saturation") {
    return `hit the ${sig.capCalls}-concurrent-call cap on ${sig.daysAtCap} of the last 7 days`;
  }
  if (sig.kind === "cpu_saturation") {
    return (
      `averaged ${sig.worstMeanLoadPerCore.toFixed(2)} load per core at its worst hour ` +
      `(${sig.cpuCount} cores), across ${sig.saturatedReports} busy hours of ` +
      `${sig.totalReports} measured`
    );
  }
  if (sig.kind === "memory_pressure") {
    const pct = Math.round(sig.lowestAvailableFraction * 100);
    const swap = sig.highestSwapUsedMib > 0 ? `, peak swap ${sig.highestSwapUsedMib} MiB` : "";
    return (
      `memory down to ${pct}% available${swap}, across ${sig.pressuredReports} hours of ` +
      `${sig.totalReports} measured`
    );
  }
  if (sig.kind === "local_model_fallback") {
    if (sig.localTurns > 0 && sig.refusedTurns > 0) {
      return (
        `${sig.localTurns} replies generated on the box's own model and ` +
        `${sig.refusedTurns} refused outright, AI budget exhausted`
      );
    }
    if (sig.localTurns > 0) {
      return `${sig.localTurns} replies generated on the box's own model, AI budget exhausted`;
    }
    return (
      `${sig.refusedTurns} inbound replies REFUSED, AI budget exhausted and this box ` +
      `has no local model (customers got silence)`
    );
  }
  if (sig.kind === "system_errors") {
    return `${sig.errorCount} on-box error logs in the last 7 days (rowboat/ollama/voice)`;
  }
  if (sig.kind === "voice_volume") {
    const pool =
      sig.packMinutes > 0
        ? `${sig.includedMinutes} included + ${sig.packMinutes} from packs`
        : `${sig.includedMinutes} included, no packs held`;
    return `on pace for ~${sig.projectedMonthlyMinutes} voice min/month (${pool})`;
  }
  const cap =
    sig.packUnits > 0
      ? `cap ${sig.capUnits} + ${sig.packUnits} from packs`
      : `cap ${sig.capUnits}, no packs held`;
  return `${sig.monthToDateUnits} SMS text units month-to-date (${cap})`;
}

function hardwareBlock(a: BusinessAdvice, siteUrl: string): string {
  const rec = a.recommendedSize
    ? `Recommended: escalate ${a.currentSize} → ${a.recommendedSize} from the admin panel.`
    : `Already on the largest box (${a.currentSize}), consider a plan/entitlement conversation instead.`;
  return [
    `${a.businessName} (${a.tier}/${a.currentSize})`,
    ...a.hardwareSignals.map((sig) => `  - ${describeSignal(sig)}`),
    `  ${rec}`,
    `  ${siteUrl}/admin/${a.businessId}`
  ].join("\n");
}

function usageBlock(a: BusinessAdvice, siteUrl: string): string {
  return [
    `${a.businessName} (${a.tier})`,
    ...a.usageSignals.map((sig) => `  - ${describeSignal(sig)}`),
    `  ${siteUrl}/admin/${a.businessId}`
  ].join("\n");
}

/**
 * Ops digest email for every flagged tenant in one send (one email per run,
 * not per business, the operator wants a single morning digest).
 *
 * Two sections, and the separation is load-bearing. The hardware section is
 * the only one that carries a size recommendation and the migrate-size
 * instruction. The usage section deliberately does not: a tenant near their
 * plan's voice minutes needs a pack or a plan change, and telling an
 * operator to buy a bigger box for it is how this advisor spent months
 * recommending a KVM 4 to tenants whose boxes were idle.
 */
export function buildEscalationAdviceEmail(
  advices: BusinessAdvice[],
  siteUrl: string
): { subject: string; text: string } {
  const hardware = advices.filter((a) => a.hardwareSignals.length > 0);
  const usage = advices.filter((a) => a.usageSignals.length > 0);

  let subject: string;
  if (hardware.length === 1) {
    subject = `[ops] Hardware escalation candidate, ${hardware[0].businessName} (${hardware[0].currentSize})`;
  } else if (hardware.length > 1) {
    subject = `[ops] ${hardware.length} hardware escalation candidates`;
  } else if (usage.length === 1) {
    // No hardware finding at all, so the subject must not say "escalation":
    // the operator reads the subject line and acts on it.
    subject = `[ops] Usage review, ${usage[0].businessName}`;
  } else {
    subject = `[ops] Usage review, ${usage.length} tenants`;
  }

  const parts: string[] = ["Sustained-load review (rolling 7 days)."];

  if (hardware.length > 0) {
    parts.push(
      "",
      "HARDWARE. These boxes are showing real load. Escalation is manual by design:",
      "use the Infrastructure card on each admin page to migrate hardware.",
      "",
      hardware.map((a) => hardwareBlock(a, siteUrl)).join("\n\n")
    );
  }

  if (usage.length > 0) {
    parts.push(
      "",
      "USAGE. These tenants are near a plan limit. This is a billing conversation,",
      "not a hardware one: packs and auto-reload cover it without touching the box.",
      "Tenants with auto-reload already armed on a live card are not listed here.",
      "",
      usage.map((a) => usageBlock(a, siteUrl)).join("\n\n")
    );
  }

  parts.push("", "You'll be reminded at most once per week per tenant while the condition persists.");

  return { subject, text: parts.join("\n") };
}
