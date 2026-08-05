/**
 * Save-time deliverability check for the OWNER phone.
 *
 * The platform's Telnyx messaging profiles whitelist destination countries
 * (verified live Aug 2026): the default profile covers US only, the CA
 * profile US+CA, the MX profile US+CA+MX, and every DID additionally has
 * international outbound disabled. A number outside the tenant's profile
 * coverage saves cleanly everywhere and then every SMS to it fails at
 * Telnyx with 40309, the silent outage the July KYP incident documented.
 * This helper turns that into a visible warning at the moment the owner
 * types the number.
 *
 * A WARNING, not a rejection: the owner may be mid-migration (Phase 2
 * international support widens the whitelists), and email/dashboard alerts
 * keep working regardless.
 *
 * Pure and dependency-free; callers pass the tenant's stored messaging
 * profile id plus the platform env ids so this stays unit-testable.
 */

import { CANADIAN_AREA_CODES, nanpNpaFromPhone } from "@/lib/plans/business-country";

export type PlatformProfileIds = {
  /** TELNYX_MESSAGING_PROFILE_ID (US-only whitelist). */
  us?: string | null;
  /** TELNYX_MESSAGING_PROFILE_ID_CA (US+CA). */
  ca?: string | null;
  /** TELNYX_MESSAGING_PROFILE_ID_MX (US+CA+MX). */
  mx?: string | null;
};

/**
 * Null when SMS to `e164` should deliver on the tenant's profile; otherwise
 * a short user-facing warning. Unknown/custom profile ids get the benefit
 * of the doubt for NANP and +52 (they are at least as wide as the defaults
 * for the tenant's own country) but still warn for other country codes,
 * which no platform profile covers today.
 */
export function ownerPhoneDeliverabilityWarning(
  e164: string,
  tenantMessagingProfileId: string | null | undefined,
  platform: PlatformProfileIds
): string | null {
  const profile = (tenantMessagingProfileId ?? "").trim();
  const usOnly = profile.length === 0 || profile === (platform.us ?? "").trim();
  const coversMx = profile === (platform.mx ?? "").trim() && profile.length > 0;

  if (e164.startsWith("+1")) {
    // A Canadian +1 number on the US-only profile fails exactly like an
    // international one (CA is not whitelisted there).
    const npa = nanpNpaFromPhone(e164);
    if (usOnly && npa !== null && CANADIAN_AREA_CODES.has(npa)) {
      return (
        "This looks like a Canadian number, and this account's texting line " +
        "currently covers US numbers only. SMS alerts, call forwarding and " +
        "Safe Mode may not reach it; email alerts keep working."
      );
    }
    return null;
  }

  if (e164.startsWith("+52")) {
    if (coversMx) return null;
    return (
      "This looks like a Mexican number, and this account's texting line " +
      "does not currently cover Mexico. SMS alerts, call forwarding and " +
      "Safe Mode may not reach it; email alerts keep working."
    );
  }

  return (
    "This number's country is not covered by this account's texting line " +
    "yet, so SMS alerts, call forwarding and Safe Mode will not reach it. " +
    "Email and dashboard alerts keep working."
  );
}
