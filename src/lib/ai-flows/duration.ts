/**
 * Human display of minute durations (pure, display-only).
 *
 * AiFlow settings store durations as MINUTES (sleep.minutes, timeoutMinutes,
 * everyMinutes, leadMinutes, ...), but "1440 min before a calendar event"
 * reads terribly — display copy converts to the largest exact units:
 * years → months → weeks → days → hours → minutes ("1 day", "5 hours",
 * "1 hour 30 minutes"). The stored definition is never touched; every editor
 * input still reads/writes raw minutes.
 */

const DURATION_UNITS: ReadonlyArray<readonly [singular: string, minutes: number]> = [
  ["year", 525_600], // 365 days
  ["month", 43_200], // 30 days
  ["week", 10_080],
  ["day", 1_440],
  ["hour", 60],
  ["minute", 1]
];

/**
 * "90" → "1 hour 30 minutes"; "1440" → "1 day"; "43200" → "1 month".
 * Every non-zero unit is included so an exact configured value never displays
 * rounded. Non-positive / non-finite input degrades to "0 minutes".
 */
export function formatDurationMinutes(totalMinutes: number): string {
  const mins = Math.round(totalMinutes);
  if (!Number.isFinite(mins) || mins <= 0) return "0 minutes";
  const parts: string[] = [];
  let rest = mins;
  for (const [name, size] of DURATION_UNITS) {
    const n = Math.floor(rest / size);
    if (n === 0) continue;
    parts.push(`${n} ${name}${n === 1 ? "" : "s"}`);
    rest -= n * size;
  }
  return parts.join(" ");
}
