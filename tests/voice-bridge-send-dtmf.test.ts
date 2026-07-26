import { describe, expect, it, vi } from "vitest";
import { telnyxSendDtmf } from "../vps/voice-bridge/src/telnyx-call-actions";

const okResponse = () =>
  ({ ok: true, status: 200, text: async () => "{}" }) as unknown as Response;

function fetchSpy(impl: () => Response = okResponse) {
  return vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(impl())
  ) as unknown as typeof fetch;
}

describe("telnyxSendDtmf", () => {
  it("posts the digits to the leg's send_dtmf action", async () => {
    const f = fetchSpy();
    const res = await telnyxSendDtmf("key", "call-abc", "1", f);
    expect(res.ok).toBe(true);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.telnyx.com/v2/calls/call-abc/actions/send_dtmf");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ digits: "1" });
  });

  it("url-encodes the call id", async () => {
    const f = fetchSpy();
    await telnyxSendDtmf("key", "v3:a/b+c", "1", f);
    const [url] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.telnyx.com/v2/calls/v3%3Aa%2Fb%2Bc/actions/send_dtmf");
  });

  it("refuses digits the keypad cannot produce, without calling Telnyx", async () => {
    // The argument comes from the model, so a malformed one must never reach
    // the API as a request we then have to reason about.
    const f = fetchSpy();
    for (const bad of ["", "1;drop", "hello", "1".repeat(33)]) {
      const res = await telnyxSendDtmf("key", "call-abc", bad, f);
      expect(res.ok).toBe(false);
      expect(res.body).toBe("invalid digits");
    }
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("accepts the pause characters Telnyx supports", async () => {
    const f = fetchSpy();
    expect((await telnyxSendDtmf("key", "c", "w1", f)).ok).toBe(true);
    expect((await telnyxSendDtmf("key", "c", "W#", f)).ok).toBe(true);
    expect((await telnyxSendDtmf("key", "c", "*0", f)).ok).toBe(true);
  });

  it("fails closed without an api key or call id", async () => {
    const f = fetchSpy();
    expect((await telnyxSendDtmf("", "call-abc", "1", f)).ok).toBe(false);
    expect((await telnyxSendDtmf("key", "", "1", f)).ok).toBe(false);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("reports a non-2xx and a thrown fetch as a failed press, never throwing", async () => {
    // The caller retries or falls back on `ok: false`; a throw here would take
    // down the bridge's tool loop mid-call.
    const bad = fetchSpy(
      () => ({ ok: false, status: 422, text: async () => "nope" }) as unknown as Response
    );
    const failed = await telnyxSendDtmf("key", "call-abc", "1", bad);
    expect(failed).toMatchObject({ ok: false, status: 422, body: "nope" });

    const thrower = vi.fn(() => Promise.reject(new Error("socket"))) as unknown as typeof fetch;
    const threw = await telnyxSendDtmf("key", "call-abc", "1", thrower);
    expect(threw).toMatchObject({ ok: false, status: 0, body: "socket" });
  });
});
