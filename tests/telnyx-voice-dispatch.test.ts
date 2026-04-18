import { describe, expect, it } from "vitest";
import {
  buildForwardHeaders,
  buildTargetUrl,
  decideTelnyxVoiceRoute,
  TELNYX_VOICE_ROUTES
} from "../supabase/functions/_shared/telnyx_voice_dispatch";

describe("telnyx_voice_dispatch route table", () => {
  it("maps Telnyx call event types to the matching Edge function", () => {
    expect(TELNYX_VOICE_ROUTES["call.initiated"]).toBe("telnyx-voice-inbound");
    expect(TELNYX_VOICE_ROUTES["call.hangup"]).toBe("telnyx-voice-call-end");
    expect(TELNYX_VOICE_ROUTES["call.ended"]).toBe("telnyx-voice-call-end");
  });

  it("is frozen so test + runtime share the same mapping", () => {
    expect(Object.isFrozen(TELNYX_VOICE_ROUTES)).toBe(true);
  });
});

describe("decideTelnyxVoiceRoute", () => {
  function envelope(eventType: string) {
    return JSON.stringify({ data: { id: "evt_1", event_type: eventType, payload: {} } });
  }

  it("routes call.initiated → inbound", () => {
    expect(decideTelnyxVoiceRoute(envelope("call.initiated"))).toEqual({
      kind: "route",
      target: "telnyx-voice-inbound",
      eventType: "call.initiated"
    });
  });

  it("routes call.hangup and call.ended → call-end", () => {
    expect(decideTelnyxVoiceRoute(envelope("call.hangup"))).toEqual({
      kind: "route",
      target: "telnyx-voice-call-end",
      eventType: "call.hangup"
    });
    expect(decideTelnyxVoiceRoute(envelope("call.ended"))).toEqual({
      kind: "route",
      target: "telnyx-voice-call-end",
      eventType: "call.ended"
    });
  });

  it("returns skip for unknown event types so Telnyx does not retry", () => {
    expect(decideTelnyxVoiceRoute(envelope("call.answered"))).toEqual({
      kind: "skip",
      eventType: "call.answered"
    });
    expect(decideTelnyxVoiceRoute(envelope("call.recording.saved"))).toEqual({
      kind: "skip",
      eventType: "call.recording.saved"
    });
  });

  it("skips when event_type is missing or wrong type", () => {
    expect(decideTelnyxVoiceRoute(JSON.stringify({ data: {} }))).toEqual({
      kind: "skip",
      eventType: ""
    });
    expect(decideTelnyxVoiceRoute(JSON.stringify({ data: { event_type: 123 } }))).toEqual({
      kind: "skip",
      eventType: ""
    });
    expect(decideTelnyxVoiceRoute(JSON.stringify({}))).toEqual({
      kind: "skip",
      eventType: ""
    });
  });

  it("returns bad_json for malformed body", () => {
    expect(decideTelnyxVoiceRoute("{not json")).toEqual({ kind: "bad_json" });
    expect(decideTelnyxVoiceRoute("")).toEqual({ kind: "bad_json" });
  });
});

describe("buildForwardHeaders", () => {
  it("preserves Telnyx signature + timestamp so downstream verify still matches", () => {
    const h = new Headers({
      "content-type": "application/json",
      "telnyx-signature-ed25519": "sig-abc",
      "telnyx-timestamp": "1700000000",
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "203.0.113.9, 10.0.0.1",
      "x-real-ip": "203.0.113.9"
    });
    const out = buildForwardHeaders(h);
    expect(out.get("telnyx-signature-ed25519")).toBe("sig-abc");
    expect(out.get("telnyx-timestamp")).toBe("1700000000");
    expect(out.get("cf-connecting-ip")).toBe("203.0.113.9");
    expect(out.get("x-forwarded-for")).toBe("203.0.113.9, 10.0.0.1");
    expect(out.get("x-real-ip")).toBe("203.0.113.9");
    expect(out.get("content-type")).toBe("application/json");
  });

  it("strips hop-by-hop + request-line headers that must not be reused on the outbound fetch", () => {
    const h = new Headers({
      "host": "example.supabase.co",
      "content-length": "123",
      "connection": "keep-alive",
      "transfer-encoding": "chunked",
      "te": "trailers",
      "upgrade": "websocket",
      "keep-alive": "timeout=5",
      "proxy-authorization": "basic zzz",
      "proxy-connection": "keep-alive",
      "telnyx-signature-ed25519": "sig"
    });
    const out = buildForwardHeaders(h);
    ["host", "content-length", "connection", "transfer-encoding", "te", "upgrade", "keep-alive", "proxy-authorization", "proxy-connection"].forEach(
      (k) => expect(out.get(k)).toBeNull()
    );
    expect(out.get("telnyx-signature-ed25519")).toBe("sig");
  });

  it("drops incoming Authorization (would otherwise leak Telnyx-side auth or confuse downstream JWT)", () => {
    const h = new Headers({ authorization: "Bearer spoofed" });
    const out = buildForwardHeaders(h);
    expect(out.get("authorization")).toBeNull();
  });

  it("injects Authorization when a forward bearer is configured", () => {
    const h = new Headers({ authorization: "Bearer spoofed" });
    const out = buildForwardHeaders(h, { bearerToken: "anon.key.value" });
    expect(out.get("authorization")).toBe("Bearer anon.key.value");
  });
});

describe("buildTargetUrl", () => {
  it("joins without double slashes", () => {
    expect(buildTargetUrl("https://abc.supabase.co", "telnyx-voice-inbound")).toBe(
      "https://abc.supabase.co/functions/v1/telnyx-voice-inbound"
    );
    expect(buildTargetUrl("https://abc.supabase.co/", "telnyx-voice-inbound")).toBe(
      "https://abc.supabase.co/functions/v1/telnyx-voice-inbound"
    );
    expect(buildTargetUrl("https://abc.supabase.co///", "telnyx-voice-call-end")).toBe(
      "https://abc.supabase.co/functions/v1/telnyx-voice-call-end"
    );
  });
});
