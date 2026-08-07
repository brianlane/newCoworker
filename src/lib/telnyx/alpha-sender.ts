/**
 * Platform alphanumeric sender routing for OWNER alerts to international
 * phones. Node twin of supabase/functions/_shared/alpha_sender.ts; the
 * parity test keeps the two in step. See the Deno copy's module doc for
 * the full rationale (Telnyx ticket #557577; RCS-derived constraints:
 * owner alerts only, explicit no-reply line, dormant until
 * TELNYX_INTL_ALPHA_PROFILE_ID is set post-approval).
 */
import { isInternationalSmsDestination } from "./international-gateway";

/**
 * Appended to every alpha-sent alert. The sender has no inbound path, so
 * without this line a reply vanishes silently, the exact failure mode the
 * RCS testing phase surfaced.
 */
export const ALPHA_NO_REPLY_LINE =
  "Sent one-way by New Coworker. Replies to this text are not received; use WhatsApp or your dashboard.";

/** The dedicated alpha-sender messaging profile id, or null when unset. */
export function intlAlphaProfileId(env?: Record<string, string | undefined>): string | null {
  const v =
    (env ? env.TELNYX_INTL_ALPHA_PROFILE_ID : process.env.TELNYX_INTL_ALPHA_PROFILE_ID)?.trim() ??
    "";
  return v.length > 0 ? v : null;
}

/**
 * The messaging profile an OWNER alert to `destinationCountry` should ride,
 * or null to keep the caller's normal path. Non-null only when the
 * destination is outside US/CA (domestic alerts keep the tenant's own
 * number and two-way thread) and the alpha profile is configured. Callers
 * that get a profile id must drop their from-number (the profile's alpha
 * sender is the identity) and append ALPHA_NO_REPLY_LINE via
 * withAlphaNoReplyLine.
 */
export function alphaOwnerAlertProfile(
  destinationCountry: string | null,
  env?: Record<string, string | undefined>
): string | null {
  if (!isInternationalSmsDestination(destinationCountry)) return null;
  return intlAlphaProfileId(env);
}

/** Idempotent: appending twice yields one no-reply line. */
export function withAlphaNoReplyLine(text: string): string {
  if (text.endsWith(ALPHA_NO_REPLY_LINE)) return text;
  return `${text}\n\n${ALPHA_NO_REPLY_LINE}`;
}
