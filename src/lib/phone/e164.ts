/**
 * Client-bundle-safe E.164 coercion for owner-typed phone numbers.
 *
 * Lives in its own dependency-free module (rather than
 * src/lib/telnyx/assign-did.ts, its original home, which re-exports it for
 * existing importers) so CLIENT components — the onboarding questionnaire's
 * Step-1 validation — can run the exact same coercion the server routes
 * enforce, without dragging server-only Supabase imports into the browser
 * bundle. Mirrors the Edge-side normalizer in
 * `supabase/functions/_shared/normalize_e164.ts`.
 *
 * Accepts a leading `+`, otherwise assumes NANP for bare 10-digit /
 * `1`-prefixed 11-digit inputs and refuses the rest. Returns `null` on
 * anything that can't be safely coerced; never throws. Use this when the
 * source data is "owner-typed phone" and a wrong guess would route SMS or
 * calls to the wrong country.
 */
export function coerceOwnerPhoneToE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[^\d+]/g, "");
  if (!cleaned) return null;
  let candidate: string;
  if (cleaned.startsWith("+")) {
    candidate = cleaned;
  } else if (cleaned.length === 10) {
    candidate = `+1${cleaned}`;
  } else if (cleaned.length === 11 && cleaned.startsWith("1")) {
    candidate = `+${cleaned}`;
  } else {
    return null;
  }
  return /^\+[1-9]\d{7,14}$/.test(candidate) ? candidate : null;
}
