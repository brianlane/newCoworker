/**
 * Permanent-vs-transient classification for a Telnyx /v2/messages response.
 *
 * A Telnyx 4xx is PERMANENT for this exact payload (invalid 'to' number,
 * blocked destination, rejected content): retrying resends the same
 * rejected request. A Privyr digest email once yielded lead_phone
 * "+11459337300" (not a dialable NANP number) and a run spent five retries
 * on guaranteed 40310s before dying with a raw error blob. 408 (timeout)
 * and 429 (rate limit) are transient and keep the retry path, as do
 * 5xx/network errors.
 *
 * Extracted from the send_sms step so notify_owner (and any future owner
 * send) applies the identical rule instead of burning its retry budget on
 * a rejection that cannot change.
 */
export function isPermanentTelnyxSmsFailure(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
