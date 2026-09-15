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
 *
 * Operator copy is a separate concern from permanence. HTTP 400 code 10015
 * is request-schema validation (including `/header/Idempotency-Key`). It
 * is still a 4xx that will not change on retry of the same header, but it
 * is NOT a destination/carrier reject: telling PO/ops "the number isn't a
 * real dialable line" made them retire good NANP leads (2026-09-15).
 */

/** Telnyx "Unprocessable Entity" / request-schema validation. */
export const TELNYX_SCHEMA_ERROR_CODE = "10015";

type TelnyxErrorItem = {
  code?: string | number;
  title?: string;
  detail?: string;
  source?: { pointer?: string; parameter?: string };
};

function parseTelnyxErrors(body: string): TelnyxErrorItem[] {
  try {
    const parsed = JSON.parse(body) as { errors?: unknown };
    if (!Array.isArray(parsed.errors)) return [];
    return parsed.errors.filter(
      (item): item is TelnyxErrorItem => Boolean(item) && typeof item === "object"
    );
  } catch {
    return [];
  }
}

function telnyxErrorCode(err: TelnyxErrorItem): string {
  return String(err.code ?? "");
}

function telnyxErrorHaystack(err: TelnyxErrorItem): string {
  return [
    err.source?.pointer ?? "",
    err.source?.parameter ?? "",
    err.title ?? "",
    err.detail ?? ""
  ].join(" ");
}

export function isPermanentTelnyxSmsFailure(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * True when Telnyx rejected the `Idempotency-Key` header itself
 * (pointer `/header/Idempotency-Key`, or 10015 whose detail names it).
 */
export function isTelnyxIdempotencyHeaderFailure(status: number, body: string): boolean {
  if (!isPermanentTelnyxSmsFailure(status)) return false;
  if (body.toLowerCase().includes("/header/idempotency-key")) return true;
  for (const err of parseTelnyxErrors(body)) {
    const haystack = telnyxErrorHaystack(err);
    if (/idempotency-key/i.test(haystack)) return true;
    if (telnyxErrorCode(err) === TELNYX_SCHEMA_ERROR_CODE && /idempotency/i.test(haystack)) {
      return true;
    }
  }
  return false;
}

/**
 * True when Telnyx 10015'd the request as schema validation, including
 * header problems. Not a destination/carrier reject (40310 et al.).
 */
export function isTelnyxSmsSchemaFailure(status: number, body: string): boolean {
  if (isTelnyxIdempotencyHeaderFailure(status, body)) return true;
  if (!isPermanentTelnyxSmsFailure(status)) return false;
  return parseTelnyxErrors(body).some((err) => telnyxErrorCode(err) === TELNYX_SCHEMA_ERROR_CODE);
}

/**
 * Operator-facing reason for a permanent Telnyx SMS 4xx. `target` is the
 * already-phrased object, e.g. `the text to +16025551212` or `the group text`.
 */
export function telnyxSmsRejectedOperatorCopy(args: {
  target: string;
  status: number;
  body: string;
}): string {
  const detail = `telnyx ${args.status}: ${args.body.slice(0, 200)}`;
  if (isTelnyxIdempotencyHeaderFailure(args.status, args.body)) {
    return (
      `Telnyx rejected the Idempotency-Key request header and a retry of the same ` +
      `header cannot fix it. This is a platform request-header problem, not an ` +
      `undialable destination. ${args.target} was not rejected as a phone number. (${detail})`
    );
  }
  if (isTelnyxSmsSchemaFailure(args.status, args.body)) {
    return (
      `Telnyx rejected the send as a malformed request (code ${TELNYX_SCHEMA_ERROR_CODE}), ` +
      `not as an undialable destination. ${args.target} was not classified as a ` +
      `bad phone number. (${detail})`
    );
  }
  return (
    `the carrier rejected ${args.target} and a retry can't fix it, ` +
    `usually the number isn't a real dialable line. (${detail})`
  );
}
