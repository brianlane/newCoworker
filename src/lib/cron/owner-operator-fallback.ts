/**
 * The owner-operator fallback vocabulary, shared by everything that READS it.
 *
 * An owner text runs on the platform inline engine, which carries the
 * operator tool surface and the owner-ask classifier. When that call cannot
 * be made or fails, the turn falls through to the Rowboat staff persona on
 * the tenant's box, which has neither: the owner still gets an answer, just a
 * materially smaller one, and nothing in the reply says so. Every give-up
 * records `sms_owner_operator_fallback` with a reason (PR #1605).
 *
 * The WRITER is Deno (`supabase/functions/sms-inbound-worker/index.ts`) and
 * cannot import this module, so the two lists are pinned equal by
 * `tests/owner-operator-fallback-lockstep.test.ts` rather than by an import.
 * A reason added on one side and not the other is a test failure, not a
 * silently unclassified row.
 */

/** Every reason the worker can record. Lockstep with the worker's union. */
export const OWNER_FALLBACK_REASONS = [
  "disabled",
  "not_configured",
  "over_cap",
  "http_error",
  "bad_payload",
  "request_failed"
] as const;

export type OwnerFallbackReason = (typeof OWNER_FALLBACK_REASONS)[number];

/**
 * Which of three groups a reason belongs to, and only one is an alarm.
 *
 * - `config`: the path was never ATTEMPTED on this deployment (kill switch
 *   off, or no platform URL / gateway token). A steady stream means someone
 *   should fix the deployment, not that the platform is unwell.
 * - `deliberate`: attempted and refused ON PURPOSE. `over_cap` is the tenant
 *   past its AI spend cap, which is the system working as designed; counting
 *   it as breakage would make a billing state look like an outage.
 * - `failed`: attempted and failed. This is the only group worth paging on.
 *
 * An UNKNOWN reason counts as `failed` on purpose: a row this code does not
 * recognize is either a worker ahead of the reader or a corrupted payload,
 * and both deserve a human look rather than silent exclusion from the alarm.
 */
export type OwnerFallbackKind = "config" | "deliberate" | "failed";

export function ownerFallbackKind(reason: string): OwnerFallbackKind {
  if (reason === "disabled" || reason === "not_configured") return "config";
  if (reason === "over_cap") return "deliberate";
  return "failed";
}

/** Human label for the group, used by both the report and the alert. */
export const OWNER_FALLBACK_KIND_LABEL: Record<OwnerFallbackKind, string> = {
  config: "config",
  deliberate: "deliberate degrade",
  failed: "attempted and failed"
};

/**
 * How many `failed` fallbacks inside the watchdog window before it pages.
 *
 * Measured baseline on 2026-08-24: ZERO fallbacks of any kind across 30 days
 * and 30 owner turns, so this is not tuned against noise, it is tuned against
 * silence. The bar is 2 rather than 1 for the same reason the HTTP layer
 * suppresses a lone anomaly and pages a burst: one transient 5xx on a single
 * owner text is survivable and self-heals on their next message, while two
 * inside a day is a pattern on a surface that only sees about one turn a day.
 */
export const OWNER_FALLBACK_PAGE_AT = 2;

/**
 * Ceiling on rows the watchdog reads. Far above the measured baseline of
 * zero, and hitting it is itself decisive: anything at this volume is past
 * the pager bar many times over, so the alert does not need an exact count
 * to be correct. Bounded because an un-limited PostgREST select silently
 * truncates at 1000 and would read as a smaller problem than it is.
 */
export const OWNER_FALLBACK_ROW_CAP = 500;

export type OwnerFallbackRow = {
  reason: string;
  created_at: string;
  business_id?: string | null;
};

export type OwnerFallbackTally = {
  /** Counts per reason, every reason present in the window. */
  byReason: Record<string, number>;
  /** Counts per group. */
  byKind: Record<OwnerFallbackKind, number>;
  /** Distinct businesses that hit a `failed` fallback. */
  failedBusinesses: string[];
  total: number;
};

/** Group and count fallback rows. Pure; the caller does the reading. */
export function tallyOwnerFallbacks(rows: readonly OwnerFallbackRow[]): OwnerFallbackTally {
  const byReason: Record<string, number> = {};
  const byKind: Record<OwnerFallbackKind, number> = { config: 0, deliberate: 0, failed: 0 };
  const failedBusinesses = new Set<string>();
  for (const row of rows) {
    const reason = typeof row.reason === "string" && row.reason ? row.reason : "unknown";
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    const kind = ownerFallbackKind(reason);
    byKind[kind] += 1;
    if (kind === "failed" && row.business_id) failedBusinesses.add(row.business_id);
  }
  return {
    byReason,
    byKind,
    failedBusinesses: [...failedBusinesses].sort(),
    total: rows.length
  };
}

/** The per-reason breakdown as one readable line, densest first. */
export function formatOwnerFallbackReasons(tally: OwnerFallbackTally): string {
  return Object.entries(tally.byReason)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${reason} x${n} (${OWNER_FALLBACK_KIND_LABEL[ownerFallbackKind(reason)]})`)
    .join(", ");
}
