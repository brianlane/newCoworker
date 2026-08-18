/**
 * Automatic logoff for HIPAA tenants, 45 CFR 164.312(a)(2)(iii): "implement
 * electronic procedures that terminate an electronic session after a
 * predetermined time of inactivity."
 *
 * WHY THIS IS NOT A SUPABASE SETTING. Supabase can time-box sessions, but
 * those controls are PROJECT-WIDE: switching one on would log out every tenant
 * on the project, not the one under a BAA. The HIPAA lane is per-tenant and
 * enterprise-only, so a clinic's idle policy must not become a real estate
 * agent's. The policy therefore lives here, gated on businesses.hipaa_mode.
 *
 * For the record, the project's current token settings do NOT provide
 * automatic logoff on their own: a 3600s access token is silently refreshed,
 * so an unattended dashboard stays signed in indefinitely. That is the gap
 * this closes.
 *
 * HONEST LIMITATION. The timer runs in the browser, which is how essentially
 * every web-based clinical system implements this control, and it is not
 * tamper-proof: a client with scripting disabled never arms it. What makes it
 * more than cosmetic is that firing it calls supabase.auth.signOut(), which
 * REVOKES the session server-side rather than merely hiding the UI, so the
 * credential is genuinely dead afterwards. Treat it as the automatic-logoff
 * control it is, not as an access-control boundary; authorization is enforced
 * server-side on every request regardless.
 */

/**
 * Idle window before sign-out. 30 minutes, chosen deliberately: long enough
 * that a front desk taking a call or walking a patient back does not lose its
 * session mid-task, and the general office-application norm. A stricter
 * customer can be tightened per deal; that is a product decision, not a code
 * change to this constant.
 */
export const HIPAA_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How long before the deadline the warning appears. Two minutes is enough to
 * notice and move the mouse, and short enough that it is not on screen for a
 * meaningful slice of the window.
 */
export const HIPAA_IDLE_WARNING_MS = 2 * 60 * 1000;

/** The `?error=` value /login renders as "you were signed out for inactivity". */
export const SESSION_TIMEOUT_ERROR = "session_timeout";

/**
 * Milliseconds of inactivity, floored at zero. A lastActivity in the future
 * (clock adjustment, a restored tab) reads as "just active" rather than as a
 * negative age that would never expire.
 */
export function idleMsSince(lastActivityMs: number, nowMs: number): number {
  return Math.max(0, nowMs - lastActivityMs);
}

export type IdleState = "active" | "warning" | "expired";

/**
 * Which phase the session is in. Pure so the policy is testable without a DOM
 * or a timer.
 */
export function idleState(
  lastActivityMs: number,
  nowMs: number,
  timeoutMs: number = HIPAA_IDLE_TIMEOUT_MS,
  warningMs: number = HIPAA_IDLE_WARNING_MS
): IdleState {
  const idle = idleMsSince(lastActivityMs, nowMs);
  if (idle >= timeoutMs) return "expired";
  if (idle >= timeoutMs - warningMs) return "warning";
  return "active";
}

/** Whole seconds left before sign-out, floored at zero. For the countdown. */
export function secondsUntilLogout(
  lastActivityMs: number,
  nowMs: number,
  timeoutMs: number = HIPAA_IDLE_TIMEOUT_MS
): number {
  const remaining = timeoutMs - idleMsSince(lastActivityMs, nowMs);
  return Math.max(0, Math.ceil(remaining / 1000));
}
