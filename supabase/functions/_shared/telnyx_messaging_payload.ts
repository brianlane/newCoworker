/**
 * Telnyx Messaging webhooks send `to` / `from` as a string, a single object with `phone_number`,
 * or an array of such objects. Normalize to a single phone string for E.164 parsing.
 */
export function telnyxMessagingPhoneString(
  payload: Record<string, unknown>,
  field: "to" | "from"
): string | undefined {
  const raw = payload[field];
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const pn = (raw as { phone_number?: unknown }).phone_number;
    if (typeof pn === "string") return pn;
  }
  if (Array.isArray(raw) && raw.length > 0) {
    const first = raw[0];
    if (first && typeof first === "object") {
      const pn = (first as { phone_number?: unknown }).phone_number;
      if (typeof pn === "string") return pn;
    }
  }
  return undefined;
}
