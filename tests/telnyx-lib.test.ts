import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { verifyTelnyxWebhookSignature } from "@/lib/telnyx/webhook-verify";
import { signStreamUrlPayload, verifyStreamUrlPayload, newStreamNonce } from "@/lib/telnyx/stream-url";
import {
  answerThenSpeak,
  rejectIncomingCall,
  telnyxAnswerPlain,
  telnyxAnswerWithStream,
  telnyxHangupCall,
  telnyxSendDtmf,
  telnyxSpeak,
  telnyxStreamingStart,
  telnyxTransferCall
} from "../supabase/functions/_shared/telnyx_call_actions";

describe("telnyx webhook-verify", () => {
  it("rejects missing signature", () => {
    const r = verifyTelnyxWebhookSignature("{}", null, "123", "dGVzdA==");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });

  it("rejects non-numeric timestamp", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const pubB64 = spki.toString("base64");
    const r = verifyTelnyxWebhookSignature("{}", "e30=", "not-a-number", pubB64);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });

  it("accepts valid Ed25519 signature with full SPKI public key", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const pubB64 = spki.toString("base64");
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{"x":1}';
    const sig = sign(null, Buffer.from(`${ts}|${body}`, "utf8"), privateKey).toString("base64");
    expect(verifyTelnyxWebhookSignature(body, sig, ts, pubB64)).toEqual({ ok: true });
  });

  it("rejects malformed public key der", () => {
    const junk = Buffer.alloc(31, 7).toString("base64");
    const r = verifyTelnyxWebhookSignature("{}", "e30=", String(Math.floor(Date.now() / 1000)), junk);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });

  it("rejects stale timestamp", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const raw32 = spki.subarray(spki.length - 32);
    const pubB64 = raw32.toString("base64");
    const ts = String(Math.floor(Date.now() / 1000) - 99999);
    const body = "{}";
    const sig = sign(null, Buffer.from(`${ts}|${body}`, "utf8"), privateKey).toString("base64");
    const r = verifyTelnyxWebhookSignature(body, sig, ts, pubB64);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("crypto_mismatch");
  });

  it("rejects wrong message for signature", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const raw32 = spki.subarray(spki.length - 32);
    const pubB64 = raw32.toString("base64");
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(null, Buffer.from(`${ts}|other`, "utf8"), privateKey).toString("base64");
    const r = verifyTelnyxWebhookSignature("{}", sig, ts, pubB64);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("crypto_mismatch");
  });
});

describe("telnyx stream-url", () => {
  const secret = "test-secret";
  const payload = {
    v: 1 as const,
    call_control_id: "cc1",
    business_id: "b1",
    to_e164: "+15550001111",
    exp: 2000000000,
    nonce: newStreamNonce()
  };

  it("sign and verify roundtrip", () => {
    const mac = signStreamUrlPayload(payload, secret);
    expect(verifyStreamUrlPayload(payload, mac, secret)).toBe(true);
    expect(verifyStreamUrlPayload(payload, "wrong", secret)).toBe(false);
  });

  it("verify handles length mismatch safely", () => {
    const p = { ...payload, nonce: "n" };
    const mac = signStreamUrlPayload(p, secret);
    expect(verifyStreamUrlPayload(p, mac.slice(0, 4), secret)).toBe(false);
  });

  const v2Payload = {
    v: 2 as const,
    call_control_id: "cc1",
    business_id: "b1",
    to_e164: "+15550001111",
    from_e164: "+15557654321",
    exp: 2000000000,
    nonce: newStreamNonce()
  };

  it("v2 sign and verify roundtrip (signed caller number)", () => {
    const mac = signStreamUrlPayload(v2Payload, secret);
    expect(verifyStreamUrlPayload(v2Payload, mac, secret)).toBe(true);
    expect(verifyStreamUrlPayload(v2Payload, "wrong", secret)).toBe(false);
  });

  it("v2 mac is bound to from_e164 (tampering the caller fails verify)", () => {
    const mac = signStreamUrlPayload(v2Payload, secret);
    const spoofed = { ...v2Payload, from_e164: "+19998887777" };
    expect(verifyStreamUrlPayload(spoofed, mac, secret)).toBe(false);
  });

  it("v1 and v2 macs differ for the same core fields", () => {
    const v1Mac = signStreamUrlPayload(payload, secret);
    const v2Mac = signStreamUrlPayload({ ...v2Payload, nonce: payload.nonce }, secret);
    expect(v1Mac).not.toBe(v2Mac);
  });
});

describe("telnyx call-control", () => {
  it("telnyxAnswerWithStream posts answer payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await telnyxAnswerWithStream("key", "call-ctrl-1", { streamUrl: "wss://x/stream" }, fetchMock as typeof fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telnyx.com/v2/calls/call-ctrl-1/actions/answer",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer key" })
      })
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.stream_url).toBe("wss://x/stream");
    expect(body.stream_track).toBe("both_tracks");
  });

  it("telnyxAnswerWithStream pins L16 codec + 16 kHz on both directions", async () => {
    // Regression: the legacy `stream_sampling_rate` field is NOT in the
    // Telnyx schema and was silently ignored, leaving outbound at the 8 kHz
    // default while the bridge generates 16 kHz frames. The inbound stream
    // also has to be `L16` — without `stream_codec` Telnyx defaults to the
    // call's PSTN codec (PCMU 8 kHz µ-law), and the bridge feeds those
    // bytes to Gemini Live as `audio/pcm;rate=16000`, producing speech-
    // recognition garbage. See `_shared/telnyx_call_actions.ts` header
    // for the full root-cause writeup.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    await telnyxAnswerWithStream(
      "key",
      "c-rate",
      { streamUrl: "wss://x" },
      fetchMock as typeof fetch
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.stream_codec).toBe("L16");
    expect(body.stream_bidirectional_mode).toBe("rtp");
    expect(body.stream_bidirectional_codec).toBe("L16");
    expect(body.stream_bidirectional_sampling_rate).toBe(16000);
    expect(body.stream_sampling_rate).toBeUndefined();
  });

  it("telnyxAnswerWithStream includes client_state when set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    await telnyxAnswerWithStream(
      "key",
      "c3",
      { streamUrl: "wss://x", clientState: "abc" },
      fetchMock as typeof fetch
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.client_state).toBe("abc");
  });

  it("telnyxSpeak posts speak payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    await telnyxSpeak("key", "cc2", "Hello", "female", fetchMock as typeof fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telnyx.com/v2/calls/cc2/actions/speak",
      expect.anything()
    );
  });

  it("telnyxAnswerPlain posts empty answer body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await telnyxAnswerPlain("key", "cc-plain", fetchMock as typeof fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telnyx.com/v2/calls/cc-plain/actions/answer",
      expect.objectContaining({
        method: "POST",
        body: "{}"
      })
    );
  });

  it("answerThenSpeak returns early when answer fails", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () => Promise.resolve("bad")
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await answerThenSpeak("k", "cc", "hi", fetchMock as typeof fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("answerThenSpeak logs when speak fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve("") })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("nope")
      });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await answerThenSpeak("k", "cc", "hi", fetchMock as typeof fetch);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("answerThenSpeak completes when answer and speak succeed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("") });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await answerThenSpeak("k", "cc", "hi", fetchMock as typeof fetch);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("telnyxTransferCall posts /actions/transfer with to payload", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("") });
    const res = await telnyxTransferCall(
      "key",
      "cc3",
      "+15551234567",
      {},
      fetchMock as typeof fetch
    );
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telnyx.com/v2/calls/cc3/actions/transfer");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer key");
    expect(JSON.parse(init.body as string)).toEqual({ to: "+15551234567" });
  });

  it("telnyxTransferCall includes timeout_secs and base64 client_state when provided", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("") });
    await telnyxTransferCall(
      "key",
      "cc-tf",
      "+15551234567",
      { timeoutSecs: 20, clientState: "hl:cc-a:0" },
      fetchMock as typeof fetch
    );
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.to).toBe("+15551234567");
    expect(body.timeout_secs).toBe(20);
    // client_state must be base64 of the plain text we passed.
    expect(typeof body.client_state).toBe("string");
    expect(Buffer.from(body.client_state as string, "base64").toString("utf8")).toBe(
      "hl:cc-a:0"
    );
  });

  it("telnyxTransferCall omits timeout_secs when it is not positive", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("") });
    await telnyxTransferCall(
      "key",
      "cc-tf0",
      "+15551234567",
      { timeoutSecs: 0 },
      fetchMock as typeof fetch
    );
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.timeout_secs).toBeUndefined();
    expect(body.client_state).toBeUndefined();
  });

  it("telnyxStreamingStart base64-encodes client_state when provided", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("") });
    await telnyxStreamingStart(
      "key",
      "cc-ss2",
      { streamUrl: "wss://b/voice/stream", clientState: "hl:cc-a:2" },
      fetchMock as typeof fetch
    );
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(Buffer.from(body.client_state as string, "base64").toString("utf8")).toBe("hl:cc-a:2");
  });

  it("telnyxStreamingStart posts /actions/streaming_start with the bridge stream contract", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("") });
    await telnyxStreamingStart(
      "key",
      "cc-ss",
      { streamUrl: "wss://bridge.example/voice/stream?x=1" },
      fetchMock as typeof fetch
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telnyx.com/v2/calls/cc-ss/actions/streaming_start");
    const body = JSON.parse(init.body as string);
    expect(body.stream_url).toBe("wss://bridge.example/voice/stream?x=1");
    expect(body.stream_track).toBe("both_tracks");
    expect(body.stream_codec).toBe("L16");
    expect(body.stream_bidirectional_mode).toBe("rtp");
    expect(body.stream_bidirectional_codec).toBe("L16");
    expect(body.stream_bidirectional_sampling_rate).toBe(16000);
  });

  it("telnyxSendDtmf posts /actions/send_dtmf with the digits", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("") });
    await telnyxSendDtmf("key", "cc-dtmf", "1", fetchMock as typeof fetch);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telnyx.com/v2/calls/cc-dtmf/actions/send_dtmf");
    expect(JSON.parse(init.body as string)).toEqual({ digits: "1" });
  });

  it("telnyxTransferCall uses default global fetch when fetchImpl omitted", async () => {
    // Exercises the default-parameter branch on `fetchImpl = fetch`. We stub
    // globalThis.fetch so we don't make a real network call and can assert the
    // same URL/body contract.
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    try {
      const res = await telnyxTransferCall("k", "cc4", "+15550000001");
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(
        "https://api.telnyx.com/v2/calls/cc4/actions/transfer",
        expect.objectContaining({ method: "POST" })
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("telnyxHangupCall posts /actions/hangup with empty body", async () => {
    // Used as the Safe Mode recovery step after a failed transfer — the call
    // has already been answered, so we need a real /actions/hangup, not
    // /actions/reject (which only works pre-answer).
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("") });
    const res = await telnyxHangupCall("key", "cc-hup", fetchMock as typeof fetch);
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telnyx.com/v2/calls/cc-hup/actions/hangup");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer key");
    expect(init.body).toBe("{}");
  });

  it("telnyxHangupCall uses default global fetch when fetchImpl omitted", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    try {
      const res = await telnyxHangupCall("k", "cc-default");
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(
        "https://api.telnyx.com/v2/calls/cc-default/actions/hangup",
        expect.objectContaining({ method: "POST" })
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("rejectIncomingCall logs when Telnyx returns error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve("err")
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await rejectIncomingCall("k", "cc", "USER_BUSY", fetchMock as typeof fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telnyx.com/v2/calls/cc/actions/reject",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ cause: "USER_BUSY" })
      })
    );
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("rejectIncomingCall succeeds when Telnyx returns ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("")
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await rejectIncomingCall("k", "cc", "CALL_REJECTED", fetchMock as typeof fetch);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      cause: "CALL_REJECTED"
    });
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("telnyx messaging errors", () => {
  it("sendTelnyxSms throws on HTTP error", async () => {
    const { sendTelnyxSms } = await import("@/lib/telnyx/messaging");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve("nope")
    });
    await expect(
      sendTelnyxSms(
        { apiKey: "k", messagingProfileId: "p" },
        "+15550001111",
        "Hi",
        { fetchImpl: fetchMock as typeof fetch }
      )
    ).rejects.toThrow("Telnyx SMS error");
  });

  it("sendTelnyxSms throws when response has no id", async () => {
    const { sendTelnyxSms } = await import("@/lib/telnyx/messaging");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: {} })
    });
    await expect(
      sendTelnyxSms(
        { apiKey: "k", messagingProfileId: "p" },
        "+15550001111",
        "Hi",
        { fetchImpl: fetchMock as typeof fetch }
      )
    ).rejects.toThrow("missing message id");
  });
});
