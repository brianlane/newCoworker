/**
 * Telnyx programmable voice sends JSON text frames: `{ event, media: { payload } }`
 * with base64-encoded RTP payload (raw codec bytes).
 */

export type TelnyxParsedFrame =
  | { kind: "media"; event: "media"; payload: string }
  | { kind: "non-media"; event: string }
  | { kind: "unparseable" };

/**
 * Parse a single Telnyx text frame once and route by event name.
 *
 * Why this exists: a previous fast-path used `rawUtf8.includes('"event":"media"')`
 * to short-circuit non-media branches, but that substring check breaks if
 * Telnyx ever serializes JSON with whitespace (`"event": "media"`) — every
 * audio frame would then be misclassified as non-media and silently
 * dropped. JSON.parse is the only correct gate.
 */
export function parseTelnyxFrame(raw: string): TelnyxParsedFrame {
  // JSON.parse legitimately returns any JSON value — including `null`,
  // numbers, strings, booleans, and arrays — so the result is NOT
  // necessarily a `{ event, media }` object. Reading `.event` off `null`
  // throws TypeError, and `onTelnyxMessage` in gemini-telnyx-bridge.ts
  // calls this without a surrounding try-catch (and is itself wired
  // straight into ws.on("message", …)). An unguarded throw there would
  // become an unhandled exception on the WS event emitter and tear down
  // the call. Validate the shape before any property access — only plain
  // (non-null, non-array) objects are valid Telnyx frames; anything else
  // is treated as unparseable, matching the old defensive behavior of
  // `tryParseTelnyxMediaPayloadBase64` which had the property reads
  // inside its own try-catch.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unparseable" };
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return { kind: "unparseable" };
  }
  const msg = parsed as { event?: unknown; media?: { payload?: unknown } };
  const event = typeof msg.event === "string" ? msg.event : "";
  if (
    event === "media" &&
    typeof msg.media?.payload === "string" &&
    msg.media.payload.length > 0
  ) {
    return { kind: "media", event: "media", payload: msg.media.payload };
  }
  return { kind: "non-media", event: event || "unknown" };
}

export function tryParseTelnyxMediaPayloadBase64(raw: string): string | null {
  const parsed = parseTelnyxFrame(raw);
  return parsed.kind === "media" ? parsed.payload : null;
}

export function telnyxMediaMessageFromPcmBase64(base64Pcm: string): string {
  return JSON.stringify({
    event: "media",
    media: { payload: base64Pcm }
  });
}
