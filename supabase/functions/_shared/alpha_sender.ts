/**
 * Platform alphanumeric sender routing for OWNER alerts to international
 * phones. Deno lockstep copy of src/lib/telnyx/alpha-sender.ts; the parity
 * test keeps the two in step.
 *
 * Telnyx's verdict (ticket #557577, Aug 2026): US/CA long codes are
 * domestic-only, and the supported path for international notifications is
 * a registered alphanumeric sender ID (NEWCOWORKER), which is ONE-WAY. The
 * sender lives on a dedicated messaging profile
 * ("New Coworker International Alerts", created by
 * scripts/oneshot/create-intl-alpha-profile.ts) with no numbers attached,
 * and only code that calls these helpers ever targets it.
 *
 * Constraints inherited from the RCS record (Jul 18 2026 decision):
 * platform-branded shared senders carry PLATFORM-authored traffic only, so
 * this routes OWNER alerts exclusively, never customer-facing messages;
 * and because an alpha sender has no inbound path at all, every message it
 * carries must say so (ALPHA_NO_REPLY_LINE), the explicit version of the
 * silent reply loss that killed multi-tenant RCS.
 *
 * Dormant until TELNYX_INTL_ALPHA_PROFILE_ID is set, which happens only
 * after Telnyx approves the sender registration AND confirms fees
 * (PRDs/alpha-sender-rollout.md). Env unset = every helper returns
 * null/unchanged and no behavior differs.
 */
import { isInternationalSmsDestination } from "./sms_international_gateway.ts";

/**
 * Appended to every alpha-sent alert. The sender has no inbound path, so
 * without this line a reply vanishes silently, the exact failure mode the
 * RCS testing phase surfaced.
 */
export const ALPHA_NO_REPLY_LINE =
  "Sent one-way by New Coworker. Replies to this text are not received; use WhatsApp or your dashboard.";

function readEnvVar(name: string): string | undefined {
  const deno = (globalThis as { Deno?: { env?: { get?: (n: string) => string | undefined } } })
    .Deno;
  if (deno?.env?.get) return deno.env.get(name);
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    name
  ];
}

/** The dedicated alpha-sender messaging profile id, or null when unset. */
export function intlAlphaProfileId(env?: Record<string, string | undefined>): string | null {
  const v =
    (env ? env.TELNYX_INTL_ALPHA_PROFILE_ID : readEnvVar("TELNYX_INTL_ALPHA_PROFILE_ID"))?.trim() ??
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
