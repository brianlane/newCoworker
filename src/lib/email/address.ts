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
