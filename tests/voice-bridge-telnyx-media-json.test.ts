import { describe, expect, it } from "vitest";
import {
  parseTelnyxFrame,
  telnyxMediaMessageFromPcmBase64,
  tryParseTelnyxMediaPayloadBase64
} from "../vps/voice-bridge/src/telnyx-media-json";

describe("parseTelnyxFrame", () => {
  it("classifies a compact `event: media` frame", () => {
    const result = parseTelnyxFrame(
      JSON.stringify({ event: "media", media: { payload: "AAA=" } })
    );
    expect(result.kind).toBe("media");
    if (result.kind === "media") {
      expect(result.event).toBe("media");
      expect(result.payload).toBe("AAA=");
    }
  });

  it("classifies a whitespace-padded `event: media` frame as media", () => {
    // Regression for Cursor bugbot finding (May 2026): the previous
    // `rawUtf8.includes('"event":"media"')` fast-path would route this
    // frame to the non-media branch and silently drop every audio packet.
    const padded = '{"event": "media", "media": { "payload": "AAA=" } }';
    const result = parseTelnyxFrame(padded);
    expect(result.kind).toBe("media");
    if (result.kind === "media") {
      expect(result.payload).toBe("AAA=");
    }
  });

  it("classifies a non-media event with the event name preserved", () => {
    const result = parseTelnyxFrame(
      JSON.stringify({ event: "start", start: { call_control_id: "x" } })
    );
    expect(result).toEqual({ kind: "non-media", event: "start" });
  });

  it("returns kind=non-media with event=unknown when the event field is missing", () => {
    const result = parseTelnyxFrame(JSON.stringify({ media: { payload: "AAA=" } }));
    expect(result).toEqual({ kind: "non-media", event: "unknown" });
  });

  it("returns kind=non-media when payload is empty (avoids forwarding zero-length media)", () => {
    const result = parseTelnyxFrame(
      JSON.stringify({ event: "media", media: { payload: "" } })
    );
    expect(result).toEqual({ kind: "non-media", event: "media" });
  });

  it("returns kind=unparseable for non-JSON input without throwing", () => {
    expect(parseTelnyxFrame("not json").kind).toBe("unparseable");
    expect(parseTelnyxFrame("").kind).toBe("unparseable");
  });
});

describe("tryParseTelnyxMediaPayloadBase64 (back-compat shim)", () => {
  it("returns the payload string for a media frame", () => {
    expect(
      tryParseTelnyxMediaPayloadBase64(
        JSON.stringify({ event: "media", media: { payload: "Zm9v" } })
      )
    ).toBe("Zm9v");
  });

  it("returns null for non-media events and unparseable input", () => {
    expect(
      tryParseTelnyxMediaPayloadBase64(JSON.stringify({ event: "start" }))
    ).toBeNull();
    expect(tryParseTelnyxMediaPayloadBase64("garbage")).toBeNull();
  });
});

describe("telnyxMediaMessageFromPcmBase64", () => {
  it("round-trips through parseTelnyxFrame", () => {
    const wire = telnyxMediaMessageFromPcmBase64("Zm9v");
    const parsed = parseTelnyxFrame(wire);
    expect(parsed.kind).toBe("media");
    if (parsed.kind === "media") expect(parsed.payload).toBe("Zm9v");
  });
});
