/**
 * International SMS gateway (Node side).
 *
 * The platform's tenant DIDs are A2P long codes, which cannot originate
 * international SMS (Telnyx number-level block, confirmed Aug 2026), and
 * A2P is the right classification for their automated domestic traffic.
 * International destinations route through ONE dedicated P2P long code
 * instead: P2P numbers may send internationally but drop MMS, so the
 * gateway carries text-only traffic and tenant numbers keep domestic MMS.
 *
 * The gateway substitutes only the visible from-number. Metering, the
 * destination gate, cost multipliers, and logging all stay keyed to the
 * TENANT, a Hong Kong alert still reserves the tenant's units with the
 * destination's multiplier applied.
 *
 * Configured via TELNYX_INTL_GATEWAY_E164; unset means no gateway (sends
 * keep the tenant from-number and fail at Telnyx exactly as before, so
 * rollout is safe in any env order). Mirror of
 * `supabase/functions/_shared/sms_international_gateway.ts` (edge functions
 * cannot import src/).
 */

/**
 * Domestic = the NANP countries our A2P long codes can actually originate
 * to (US + CA). Caribbean +1 territories are separate countries on
 * international routes, and an unresolvable country is never treated as
 * domestic (the destination gate refuses those sends anyway).
 */
export function isInternationalSmsDestination(country: string | null): boolean {
  return country !== "US" && country !== "CA";
}

/** The dedicated P2P gateway from-number, or null when not configured. */
export function internationalGatewayFrom(
  env: Record<string, string | undefined> = process.env
): string | null {
  const v = (env.TELNYX_INTL_GATEWAY_E164 ?? "").trim();
  return v.length > 0 ? v : null;
}

/**
 * User-facing refusal for media to an international destination: the P2P
 * gateway cannot carry MMS and the tenant's A2P number cannot reach the
 * destination, so the send is refused BEFORE any metering (zero units,
 * zero Telnyx calls) instead of silently stripping the image or bouncing.
 */
export const INTERNATIONAL_MMS_ERROR =
  "Picture messages cannot be sent to international numbers. Send the message as text only.";
