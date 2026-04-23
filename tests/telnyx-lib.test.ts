import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { verifyTelnyxWebhookSignature } from "@/lib/telnyx/webhook-verify";
import { signStreamUrlPayload, verifyStreamUrlPayload, newStreamNonce } from "@/lib/telnyx/stream-url";
import {
  answerThenSpeak,
  rejectIncomingCall,
  telnyxAnswerPlain,
  telnyxAnswerWithStream,
  telnyxSpeak,
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
