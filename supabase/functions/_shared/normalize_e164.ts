/** Strip formatting and coerce to E.164 (US-centric +1 default for 10/11-digit inputs). */
export function normalizeE164(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return `+${d}`;
}
