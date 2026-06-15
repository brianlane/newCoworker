/**
 * Shared cc/bcc recipient normalization for every owner-facing email path
 * (voice/SMS/dashboard tool adapters and the AiFlow owner-mailbox adapter).
 *
 * The model/UI may hand us a comma/semicolon-separated string OR an array of
 * strings; we normalize to a de-duplicated array of valid, lowercased email
 * addresses, capped so a runaway model can't blast an unbounded recipient list.
 * Invalid entries are dropped rather than throwing — cc/bcc are best-effort
 * additions to a send, never the reason a requested email fails.
 */

/** Max cc (and, separately, max bcc) recipients accepted on a single send. */
export const MAX_CC_BCC_RECIPIENTS = 10;

// Same strictness class as zod's z.string().email() and the chat-worker regex.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalize a raw cc/bcc value into a capped array of valid email addresses.
 * Accepts `string` (comma/semicolon/whitespace separated), `string[]`, or
 * nullish. Returns `[]` when there is nothing usable.
 */
export function normalizeRecipients(
  input: unknown,
  cap: number = MAX_CC_BCC_RECIPIENTS
): string[] {
  const raw: string[] = Array.isArray(input)
    ? input.flatMap((v) => (typeof v === "string" ? v.split(/[,;\s]+/) : []))
    : typeof input === "string"
      ? input.split(/[,;\s]+/)
      : [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const addr = entry.trim().toLowerCase();
    if (!addr || seen.has(addr) || !EMAIL_RE.test(addr)) continue;
    seen.add(addr);
    out.push(addr);
    if (out.length >= cap) break;
  }
  return out;
}
