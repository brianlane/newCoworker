/**
 * The Telnyx destination allowlist the widen one-shot applies, extracted
 * pure so tests can pin its membership.
 *
 * Why this is not just `Object.values(SMS_DIAL_CODES)`: the dial table
 * exists to classify destinations by prefix, and bare +1 maps to "US".
 * Every other NANP region is reachable from a prefix override (+1787 PR,
 * +1876 JM, and so on), but Canada shares plain +1 with the US and so can
 * NEVER appear among the table's values. Telnyx, meanwhile, treats CA as
 * its own whitelist region. On Aug 5 2026 the widen run replaced the
 * profiles' explicit US+CA lists with the table-derived list, silently
 * dropping Canada; every SMS and (potentially) call to a Canadian number
 * then failed with Telnyx 40309 "Invalid destination region 'CA'" until
 * the profiles were re-patched on Aug 6. KYP Ads, the one tenant with
 * Canadian traffic, lost owner notifies and a lead follow-up for a day.
 *
 * Hence two defenses here: regions Telnyx knows but the dial table cannot
 * express are added explicitly, and `assertContainsLiveTrafficRegions`
 * refuses to produce a list that lacks a region the fleet actually texts
 * or calls today.
 */
import {
  SMS_DIAL_CODES,
  SMS_DESTINATION_DENYLIST
} from "../../supabase/functions/_shared/sms_destination_rates";

/**
 * Telnyx whitelist regions with no dial-code prefix of their own. Canada
 * is the only known member: it shares bare +1 with the US.
 */
export const REGIONS_WITHOUT_OWN_DIAL_PREFIX = ["CA"] as const;

/** Regions with live fleet traffic; the allowlist must never omit these. */
export const LIVE_TRAFFIC_REGIONS = ["US", "CA", "MX"] as const;

/** Every ISO the dial table can resolve, plus the prefixless regions, minus the gate's denylist. */
export function allowedCountries(): string[] {
  const isos = new Set<string>(Object.values(SMS_DIAL_CODES));
  for (const extra of REGIONS_WITHOUT_OWN_DIAL_PREFIX) isos.add(extra);
  for (const blocked of SMS_DESTINATION_DENYLIST) isos.delete(blocked);
  const allowed = [...isos].sort();
  assertContainsLiveTrafficRegions(allowed);
  return allowed;
}

export function assertContainsLiveTrafficRegions(allowed: string[]): void {
  const missing = LIVE_TRAFFIC_REGIONS.filter((c) => !allowed.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `allowlist is missing live-traffic region(s) ${missing.join(",")}; ` +
        "refusing to widen (this exact gap caused the Aug 6 2026 Canada outage)"
    );
  }
}
