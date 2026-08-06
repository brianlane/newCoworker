/**
 * Pre-dial guards for `place_ai_call`: may this business ring this number,
 * right now?
 *
 * Until this existed the only things standing between a flow and a stranger's
 * phone were "is there a number" and "does the plan allow outbound calls".
 * That was survivable while calls were a manual or weekly-cadence feature. It
 * is not once a lead flow dials automatically on arrival and retries, because
 * two gaps become reachable in ordinary use:
 *
 *   - a lead who texted STOP could still be CALLED. The opt-out check was
 *     wired into send_sms only, so the quietest signal a person can give was
 *     honored on one channel and ignored on the more intrusive one.
 *   - nothing counted dials ACROSS flows. Per-(flow, step) dedupe stops a
 *     crashed worker re-ringing for one step; it says nothing about two flows
 *     holding the same lead, which is exactly the shape of a tenant running a
 *     first-contact ladder and a weekly follow-up at once.
 *
 * Both fail CLOSED. An opt-out lookup that errors throws rather than
 * returning "not opted out", so the step fails and retries instead of dialing
 * someone who may have asked us to stop. The cap query is the one place that
 * degrades: see countRecentDials.
 */
import { isRecipientOptedOut } from "./compliance.ts";
import { CALL_REASON, type CallOutcomeReason } from "./call_outcome_meta.ts";

// Minimal structural client (matches the _shared convention in reentry.ts and
// call_outcome.ts): this module needs both an .rpc() and a query builder, and
// spelling either out structurally buys nothing over the real client's types.
// deno-lint-ignore no-explicit-any
export type CallGuardClient = any;

/**
 * Default ceiling on dials to ONE number, per business, inside
 * DEFAULT_DIAL_WINDOW_HOURS. Sized as a backstop, not the primary control: a
 * first-contact ladder is three attempts by design, so this only bites when
 * something unplanned is also dialing (a second flow, a replayed run). Set
 * high enough that a legitimate ladder plus one follow-up call never trips it.
 */
export const DEFAULT_MAX_DIALS_PER_LEAD = 4;

/** Rolling window the cap counts over. */
export const DEFAULT_DIAL_WINDOW_HOURS = 24;

/** Dial-log statuses that count as "we rang this person". */
const COUNTED_STATUSES = ["placed", "failed"] as const;

export type CallDialGuardVerdict =
  | { allowed: true }
  | { allowed: false; reason: CallOutcomeReason };

export type CallDialGuardOptions = {
  businessId: string;
  toE164: string;
  nowMs: number;
  maxDials?: number;
  windowHours?: number;
};

/**
 * Count dials to this number in the window.
 *
 * Returns null when the count cannot be read. The caller treats that as
 * "allow", which is the one deliberate fail-OPEN in this module: the cap is a
 * backstop against duplicate automation, not a consent or safety control, and
 * refusing every call because a count query hiccuped would take out the whole
 * feature to prevent a second dial. Consent (opt-out) fails closed instead,
 * which is the asymmetry that matters.
 */
async function countRecentDials(
  client: CallGuardClient,
  opts: { businessId: string; toE164: string; sinceIso: string }
): Promise<number | null> {
  try {
    const { count, error } = await client
      .from("voice_outbound_dial_log")
      .select("id", { count: "exact", head: true })
      .eq("business_id", opts.businessId)
      .eq("to_e164", opts.toE164)
      .in("status", COUNTED_STATUSES)
      .gte("created_at", opts.sinceIso);
    if (error) {
      console.error("call_guards: dial count failed", error);
      return null;
    }
    return count ?? 0;
  } catch (err) {
    console.error("call_guards: dial count threw", err);
    return null;
  }
}

/**
 * May we dial `toE164` for `businessId` right now?
 *
 * Call this AFTER the plan/tier check and BEFORE the exactly-once dial ledger
 * insert. Order matters both ways: after the tier check so a plan refusal does
 * not spend an opt-out RPC, and before the ledger insert so a refused attempt
 * leaves no row claiming the occurrence already dialed.
 */
export async function callDialGuard(
  client: CallGuardClient,
  opts: CallDialGuardOptions
): Promise<CallDialGuardVerdict> {
  const toE164 = opts.toE164.trim();
  // No number is not this module's refusal to make: the planner already
  // resolves that to the not-placed sentinel with a clearer reason.
  if (!toE164) return { allowed: true };

  // Throws on RPC error by design (see isRecipientOptedOut): a consent check
  // that cannot be answered must not resolve to "go ahead".
  if (await isRecipientOptedOut(client, opts.businessId, toE164)) {
    return { allowed: false, reason: CALL_REASON.OPTED_OUT };
  }

  const maxDials = opts.maxDials ?? DEFAULT_MAX_DIALS_PER_LEAD;
  const windowHours = opts.windowHours ?? DEFAULT_DIAL_WINDOW_HOURS;
  // A non-positive cap disables it rather than blocking every call, so a
  // misconfigured env var degrades to today's behavior instead of silencing
  // a tenant's outbound calling entirely.
  if (maxDials <= 0) return { allowed: true };

  const sinceIso = new Date(opts.nowMs - windowHours * 3_600_000).toISOString();
  const recent = await countRecentDials(client, {
    businessId: opts.businessId,
    toE164,
    sinceIso
  });
  if (recent !== null && recent >= maxDials) {
    return { allowed: false, reason: CALL_REASON.DIAL_CAP };
  }
  return { allowed: true };
}
