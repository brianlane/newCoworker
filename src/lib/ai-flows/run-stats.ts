/**
 * Pure helpers for presenting AiFlow run statistics (admin card + owner runs
 * page). Kept out of the components so both server and client bundles can
 * share them and they sit under the lib coverage gate.
 */

/**
 * One-line routing summary from a run's context.routing: how many employees
 * were offered the lead and who (if anyone) claimed it. `tried` holds retired
 * offers; the employee currently offered / the claimer is one more on top.
 */
export function routingSummary(context: Record<string, unknown>): string | null {
  const routing = context.routing as Record<string, unknown> | undefined;
  if (!routing || typeof routing !== "object") return null;
  const tried = Array.isArray(routing.tried) ? routing.tried.length : 0;
  const hasCurrentOffer = typeof routing.offered === "string" && routing.offered !== "";
  const claimedName = typeof routing.claimed_name === "string" ? routing.claimed_name : "";
  const claimedBy = typeof routing.claimed_by === "string" ? routing.claimed_by : "";
  const claimed = claimedName || claimedBy;
  const offers = tried + (hasCurrentOffer || claimed ? 1 : 0);
  if (offers === 0) return null;
  const offersPart = `offered to ${offers} employee${offers === 1 ? "" : "s"}`;
  if (claimed) return `${offersPart} · claimed by ${claimed}`;
  if (hasCurrentOffer) return `${offersPart} · awaiting reply`;
  return `${offersPart} · no claim (owner fallback)`;
}

/** "3 retries" / "1 retry" / null — error retries only, never benign re-claims. */
export function retrySummary(errorRetryCount: number): string | null {
  if (!Number.isFinite(errorRetryCount) || errorRetryCount <= 0) return null;
  return `${errorRetryCount} ${errorRetryCount === 1 ? "retry" : "retries"}`;
}

/** One displayable key/value from a run's context (trigger field or var). */
export type RunDataEntry = { key: string; value: string };

/**
 * Display form of one context value. Strings pass through UNTRIMMED —
 * an empty or whitespace value is often the whole story behind a failure
 * ("lead_phone" was ""), so it must render as visibly empty, not vanish.
 * Arrays join, objects JSON-stringify, everything else String()s.
 */
export function formatRunValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => formatRunValue(v)).join(", ");
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value ?? "");
}

/**
 * The trigger data a run started from (context.trigger), as ordered display
 * entries. `channel` is dropped (the flow header already says how it starts)
 * and empty values are dropped — the trigger scope pads absent cross-channel
 * keys with "" by design, which is noise here (unlike vars, where an empty
 * value is usually the bug being investigated).
 */
export function runTriggerEntries(context: Record<string, unknown>): RunDataEntry[] {
  const trigger = context.trigger;
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) return [];
  const out: RunDataEntry[] = [];
  for (const [key, value] of Object.entries(trigger as Record<string, unknown>)) {
    if (key === "channel") continue;
    const formatted = formatRunValue(value);
    if (formatted === "") continue;
    out.push({ key, value: formatted });
  }
  return out;
}

/**
 * The variables a run's steps produced so far (context.vars), as ordered
 * display entries. Engine-internal bookkeeping (underscore-prefixed markers:
 * branch choices, sleep/wait markers, quiet-hour bypass) is hidden;
 * `claimed_agent`'s pre-routing "none" seed is kept — it reads fine and
 * matters once routing ran. Empty values are KEPT: "lead_phone: (empty)" is
 * exactly what explains an upsert/send failure.
 */
export function runVarEntries(context: Record<string, unknown>): RunDataEntry[] {
  const vars = context.vars;
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) return [];
  const out: RunDataEntry[] = [];
  for (const [key, value] of Object.entries(vars as Record<string, unknown>)) {
    if (key.startsWith("_")) continue;
    out.push({ key, value: formatRunValue(value) });
  }
  return out;
}
