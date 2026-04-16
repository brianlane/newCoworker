/**
 * Telnyx programmable voice sends JSON text frames: `{ event, media: { payload } }`
 * with base64-encoded RTP payload (raw codec bytes).
 */

export function tryParseTelnyxMediaPayloadBase64(raw: string): string | null {
  try {
    const msg = JSON.parse(raw) as { event?: string; media?: { payload?: string } };
    if (msg.event === "media" && typeof msg.media?.payload === "string" && msg.media.payload.length > 0) {
      return msg.media.payload;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function telnyxMediaMessageFromPcmBase64(base64Pcm: string): string {
  return JSON.stringify({
    event: "media",
    media: { payload: base64Pcm }
  });
}
