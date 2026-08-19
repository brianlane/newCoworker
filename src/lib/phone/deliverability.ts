/**
 * Save-time deliverability check for the OWNER phone.
 *
 * The block is at the NUMBER level, not the profile level. Since
 * scripts/oneshot/widen-telnyx-destinations.ts ran (Aug 2026), every
 * platform messaging profile whitelists the full 222-country allowlist, so
 * profile identity no longer predicts deliverability at all. What actually
 * blocks international SMS is the numbers themselves: Telnyx support
 * confirmed (Aug 6 2026) that our long-code numbers cannot originate
 * international, meaning non-NANP, SMS at all. Every DID reports
 * `features.sms.international_outbound: false`, and Telnyx derives that
 * from the number type; no profile widening changes it. Hong Kong (+852)
 * additionally requires a registered alphanumeric sender, which is one-way
 * and so not a fix for us. A non-NANP number therefore saves cleanly and
 * then every SMS to it fails at Telnyx with 40309, the silent outage the
 * July KYP incident documented. This helper turns that into a visible
 * warning at the moment the owner types the number.
 *
 * NANP (+1) destinations, Canada and the Caribbean territories included,
 * originate fine from our long codes and are fully whitelisted, so any +1
 * number passes without a warning.
 *
 * Mexico (+52) gets its own message but the same verdict. Mexico v1 priced
 * +52 SMS from US DIDs (surcharge plus the 100-unit cap), but the account's
 * message detail records show zero +52 sends ever (checked Aug 5 2026), so
 * the number-level block has never been disproven for MX and support's
 * "not at all" includes it. If a number type with international outbound
 * ships (Telnyx suggests toll-free), this helper regains a real condition.
 *
 * A WARNING, not a rejection: the block may lift per number type later,
 * and email/dashboard alerts keep working regardless. The messages scope
 * themselves to SMS: the widen one-shot also widened the outbound voice
 * profiles, so calls to these destinations are not known to be blocked.
 *
 * Pure and dependency-free, so this stays unit-testable.
 */

/**
 * Where the platform's SMS can and cannot deliver, as a category the UI can
 * map to localized copy. "nanp" means no warning: either the input is a +1
 * destination our long codes originate to, or it is not (yet) a complete
 * international-format number, which covers local-format input the save
 * path coerces to +1 and partial input mid-keystroke. "mx" and
 * "international" are both unreachable by SMS; Mexico is split out so its
 * copy can point at WhatsApp, the only working MX customer channel.
 */
export type SmsReachability = "nanp" | "mx" | "international";

/**
 * Tolerant of raw user input: formatting characters are stripped, and only
 * a string that is a full international-format number (+ followed by 7 to
 * 15 digits) can classify as unreachable, so as-you-type surfaces never
 * flash a warning on a half-typed prefix.
 */
export function smsReachability(rawPhone: string): SmsReachability {
  const cleaned = rawPhone.replace(/[^+0-9]/g, "");
  if (!/^\+[0-9]{7,15}$/.test(cleaned)) return "nanp";
  if (cleaned.startsWith("+1")) return "nanp";
  if (cleaned.startsWith("+52")) return "mx";
  return "international";
}

/**
 * Null when SMS to `e164` can deliver from the platform's long-code
 * numbers (any NANP +1 destination); otherwise a short user-facing
 * warning naming the SMS gap. Number-level: the tenant's messaging
 * profile plays no part (see module doc). English-only: this string rides
 * the API response; the dashboard renders its own localized equivalent
 * from the same smsReachability classification.
 */
export function ownerPhoneDeliverabilityWarning(e164: string): string | null {
  const reachability = smsReachability(e164);
  if (reachability === "nanp") return null;

  if (reachability === "mx") {
    return (
      "This looks like a Mexican number. Our texting lines can only send " +
      "SMS to +1 (US and Canada) numbers, so SMS alerts will not reach it. " +
      "WhatsApp, email, and dashboard alerts keep working."
    );
  }

  // WhatsApp is named here for the same reason the MX copy names it: since
  // the alert stand-in shipped (PR #1318), connecting WhatsApp restores a
  // real two-way channel for a number SMS can never reach. The localized
  // dashboard copy (dashboard.settings.smsUnreachable) already says so.
  return (
    "This number's country is not reachable by SMS from our texting lines, " +
    "which can only send to +1 (US and Canada) numbers. SMS alerts will " +
    "not reach it. WhatsApp, email, and dashboard alerts keep working."
  );
}
