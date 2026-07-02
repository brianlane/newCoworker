/**
 * Pull the bare address out of an RFC-ish recipient string. Email logs mostly
 * store plain addresses, but forwarded/inbound rows can carry
 * `Display Name <addr@host>` — link resolution needs just the addr part.
 * Returns the trimmed lowercase address, or null when there is none.
 *
 * Pure + dependency-free: imported by both server code (contact-emails
 * resolution) and the client Emails view (map lookups).
 */
export function extractEmailAddress(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const angled = raw.match(/<([^<>\s]+@[^<>\s]+)>/);
  const candidate = (angled ? angled[1] : raw).trim().toLowerCase();
  return candidate.includes("@") ? candidate : null;
}

/**
 * Extract every address from a possibly comma-separated recipient list
 * (`a@x.com, Name <b@y.com>`), deduplicated, lowercase, in order. Segments
 * without an address (e.g. the name half of a quoted `"Last, First" <addr>`)
 * are skipped — the `<addr>` half still resolves on its own.
 */
export function extractEmailAddresses(value: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (value ?? "").split(",")) {
    const addr = extractEmailAddress(part);
    if (addr && !out.includes(addr)) out.push(addr);
  }
  return out;
}
