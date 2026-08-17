/**
 * Re-export shim: the canonical allowlist moved to
 * src/lib/telnyx/voice-destinations.ts so tenant-profile CREATION
 * (src/lib/telnyx/tenant-voice-infra.ts) and this one-shot's widen path
 * share one source. Membership history and the Canada-outage rationale live
 * on the canonical module; tests pin both through this shim so the move
 * cannot silently fork the lists.
 */
export {
  REGIONS_WITHOUT_OWN_DIAL_PREFIX,
  LIVE_TRAFFIC_REGIONS,
  allowedCountries,
  assertContainsLiveTrafficRegions
} from "../../src/lib/telnyx/voice-destinations";
