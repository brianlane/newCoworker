/**
 * Prospecting: the send-as alias, normalised one way for every writer.
 *
 * `outreach_settings.send_as_email` is the address cold email carries as its
 * From and Reply-To when the tenant's mailbox corresponds from a verified alias
 * rather than the account it signs in as. The dashboard save, the one-shot
 * that sets it for HQ, and the DB check constraint have to agree on what
 * counts as one address, so the rule lives here with no imports.
 */

/**
 * One address, and only the shape of one: no spaces, no angle brackets, no
 * list separators, so a pasted "Name <addr>" or "a@x.com, b@x.com" is refused
 * rather than stored as a From header it would corrupt. Mirrors the DB check
 * (`outreach_settings_send_as_email_shape`) so the readable refusal is what the
 * owner sees, never the constraint violation behind it.
 */
export const SEND_AS_EMAIL_SHAPE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/**
 * The send-as address as stored: trimmed and lowercased, null for blank, and
 * `invalid` for anything that is not shaped like one address. Lowercased
 * because mail domains are case-insensitive and Gmail matches the alias
 * without regard to case, so one spelling is one setting.
 */
export function normalizeSendAsEmail(raw: string): string | null | "invalid" {
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return null;
  return SEND_AS_EMAIL_SHAPE.test(cleaned) ? cleaned : "invalid";
}
