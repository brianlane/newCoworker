/**
 * Host CPU/memory metrics reported by the box heartbeat.
 *
 * WHY these numbers exist. "Is this box too small" had no measurement behind
 * it. The escalation advisor answered it from billing entitlements (voice
 * minutes as a fraction of the tier's included pool), which describes a
 * Stripe plan rather than a machine, and reloadable packs make that reading
 * wrong outright: a tenant can buy past the pool without the hardware
 * changing at all. Meanwhile the posture report carried memory only as a
 * boolean against a floor, with the number inside a prose detail string, and
 * carried no CPU at all.
 *
 * WHY an aggregate rather than a reading. Posture reports arrive hourly, but
 * heartbeat.sh runs every 2 minutes. A single instantaneous `/proc/loadavg`
 * sampled once an hour covers under 2% of the wall clock and would miss
 * every burst. The box therefore accumulates one sample per tick and reports
 * the summary, so `load1Max` means "the worst minute we saw in this hour",
 * not "the minute we happened to look".
 *
 * `samples` is part of the contract, not decoration: a report built from 3
 * samples covers 6 minutes of the hour and must not be read as evidence
 * about the other 54. Consumers should require a sample floor before
 * concluding anything.
 */

/** One box's CPU/memory summary for the interval since its previous report. */
export type VpsHostMetrics = {
  /** Cores the box has, so load can be normalized. Always >= 1. */
  cpuCount: number;
  /** Worst 1-minute load average seen across the interval. */
  load1Max: number;
  /** Mean of the sampled 1-minute load averages. */
  load1Mean: number;
  /** Lowest MemAvailable seen, in MiB. */
  memAvailableMinMib: number;
  /** MemTotal, in MiB. */
  memTotalMib: number;
  /** Highest swap-in-use seen, in MiB. */
  swapUsedMaxMib: number;
  /** How many 2-minute samples went into this aggregate. */
  samples: number;
};

/**
 * Sample floor before an aggregate is worth reasoning about. 10 samples is
 * 20 minutes of a 60-minute interval: enough that a quiet reading means the
 * box was actually quiet, rather than that we only looked twice.
 */
export const MIN_METRIC_SAMPLES = 10;

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Validate an untrusted metrics object (it arrives over HTTP from a box, and
 * lands in jsonb, so nothing downstream can assume shape). Returns null when
 * any field is missing or non-finite: a partial aggregate is worse than
 * none, because a missing `cpuCount` would silently turn load-per-core into
 * load-per-nothing.
 */
export function parseHostMetrics(raw: unknown): VpsHostMetrics | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const cpuCount = finiteNumber(r.cpuCount);
  const load1Max = finiteNumber(r.load1Max);
  const load1Mean = finiteNumber(r.load1Mean);
  const memAvailableMinMib = finiteNumber(r.memAvailableMinMib);
  const memTotalMib = finiteNumber(r.memTotalMib);
  const swapUsedMaxMib = finiteNumber(r.swapUsedMaxMib);
  const samples = finiteNumber(r.samples);
  if (
    cpuCount === null ||
    load1Max === null ||
    load1Mean === null ||
    memAvailableMinMib === null ||
    memTotalMib === null ||
    swapUsedMaxMib === null ||
    samples === null
  ) {
    return null;
  }
  // A box reporting zero cores would make every per-core ratio infinite, and
  // a box reporting zero total memory would make every percentage NaN.
  if (cpuCount < 1 || memTotalMib <= 0 || samples < 1) return null;
  return {
    cpuCount,
    load1Max,
    load1Mean,
    memAvailableMinMib,
    memTotalMib,
    swapUsedMaxMib,
    samples
  };
}

/**
 * Peak load per core. This, not raw load, is what compares across box sizes:
 * a load of 3 is idle-ish on 8 cores and badly oversubscribed on 2. 1.0 means
 * the box had exactly as much runnable work as it has cores.
 */
export function peakLoadPerCore(metrics: VpsHostMetrics): number {
  return metrics.load1Max / metrics.cpuCount;
}

/** Mean load per core over the interval. */
export function meanLoadPerCore(metrics: VpsHostMetrics): number {
  return metrics.load1Mean / metrics.cpuCount;
}

/** Lowest available memory as a fraction of total, 0..1. */
export function minMemoryAvailableFraction(metrics: VpsHostMetrics): number {
  return metrics.memAvailableMinMib / metrics.memTotalMib;
}

/** Whether this aggregate covers enough of its interval to reason about. */
export function hasEnoughSamples(
  metrics: VpsHostMetrics,
  floor: number = MIN_METRIC_SAMPLES
): boolean {
  return metrics.samples >= floor;
}
