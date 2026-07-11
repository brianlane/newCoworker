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

/** Pull every phone string out of a `to`/`from` value (string | object | array). */
function phoneStringsFromField(raw: unknown): string[] {
  const out: string[] = [];
  if (typeof raw === "string") {
    if (raw) out.push(raw);
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === "object") {
        const pn = (item as { phone_number?: unknown }).phone_number;
        if (typeof pn === "string" && pn) out.push(pn);
      } else if (typeof item === "string" && item) {
        out.push(item);
      }
    }
  } else if (raw && typeof raw === "object") {
    const pn = (raw as { phone_number?: unknown }).phone_number;
    if (typeof pn === "string" && pn) out.push(pn);
  }
  return out;
}

/**
 * Every distinct participant phone number in a Telnyx messaging webhook: the
 * sender (`from`) plus all `to` recipients AND any `cc` participants. On an
 * inbound group MMS Telnyx lists the OTHER group members in `cc` (with our own
 * DID in `to`), so reading `cc` too is what lets a group reply reach everyone
 * in the thread, not just whoever happened to land in `to`. Order: `from`,
 * then `to[]`, then `cc[]`; de-duped, preserving first-seen order. NOT
 * E.164-normalized — the caller normalizes (the inbound handler has normalizeE164).
 */
export function telnyxMessagingParticipants(payload: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of [
    ...phoneStringsFromField(payload["from"]),
    ...phoneStringsFromField(payload["to"]),
    ...phoneStringsFromField(payload["cc"])
  ]) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export type TelnyxInboundImage = { url: string; contentType: string };

/** Image content types the AI image tools can consume as an edit source. */
const INBOUND_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Hosts Telnyx serves inbound MMS media from — the ONLY hosts the platform
 * will ever download inbound media from (SSRF guard: the URL comes from a
 * signature-verified webhook, but pin the host anyway). */
export function isTelnyxMediaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "telnyx.com" || u.hostname.endsWith(".telnyx.com"));
  } catch {
    return false;
  }
}

/**
 * Usable image attachments on an inbound Telnyx MMS: `media[]` entries whose
 * content type the image tools accept and whose URL is a Telnyx media host.
 * Empty for plain SMS, non-image media (video/vcard), and malformed entries.
 */
export function telnyxInboundImages(payload: Record<string, unknown>): TelnyxInboundImage[] {
  const raw = payload["media"];
  if (!Array.isArray(raw)) return [];
  const out: TelnyxInboundImage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const url = (item as { url?: unknown }).url;
    const contentType = (item as { content_type?: unknown }).content_type;
    if (typeof url !== "string" || typeof contentType !== "string") continue;
    const normalizedType = contentType.trim().toLowerCase();
    if (!INBOUND_IMAGE_TYPES.has(normalizedType)) continue;
    if (!isTelnyxMediaUrl(url)) continue;
    out.push({ url, contentType: normalizedType });
  }
  return out;
}
