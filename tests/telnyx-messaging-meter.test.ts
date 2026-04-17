import { describe, it, expect, vi, beforeEach } from "vitest";

const createSupabaseServiceClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient
}));

import { sendTelnyxSms, reserveSlotFailureMessage } from "@/lib/telnyx/messaging";

describe("reserveSlotFailureMessage", () => {
  it("maps known reasons", () => {
    expect(reserveSlotFailureMessage({ ok: false, reason: "monthly_sms_limit" })).toBe(
      "Monthly SMS limit reached"
    );
    expect(reserveSlotFailureMessage({ ok: false, reason: "no_business" })).toBe("Business not found");
    expect(reserveSlotFailureMessage({ ok: false, reason: "throttled" })).toBe(
      "SMS throughput throttled (please retry in a moment)"
    );
  });

  it("falls back for unknown reason and empty", () => {
    expect(reserveSlotFailureMessage({ ok: false, reason: "other" })).toBe("SMS quota blocked: other");
    expect(reserveSlotFailureMessage(null)).toBe("SMS quota blocked");
    expect(reserveSlotFailureMessage({ ok: false })).toBe("SMS quota blocked");
  });
});

describe("sendTelnyxSms meterBusinessId (atomic reserve)", () => {
  const rpc = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockImplementation((name: string) => {
      if (name === "try_reserve_sms_outbound_slot") {
        return Promise.resolve({ data: { ok: true }, error: null });
      }
      if (name === "release_sms_outbound_slot") {
        return Promise.resolve({ error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    createSupabaseServiceClient.mockResolvedValue({ rpc } as never);
  });

  it("reserves slot via RPC then sends; does not increment twice or release on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "m1" } })
    });
    const id = await sendTelnyxSms(
      { apiKey: "k", messagingProfileId: "p" },
      "+15550001111",
      "Hi",
      { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1" }
    );
    expect(id).toBe("m1");
    expect(rpc).toHaveBeenCalledWith("try_reserve_sms_outbound_slot", { p_business_id: "biz-1" });
    expect(rpc).not.toHaveBeenCalledWith("release_sms_outbound_slot", expect.anything());
  });

  it("throws when reserve returns ok false without calling Telnyx", async () => {
    rpc.mockImplementation((name: string) => {
      if (name === "try_reserve_sms_outbound_slot") {
        return Promise.resolve({ data: { ok: false, reason: "monthly_sms_limit" }, error: null });
      }
      return Promise.resolve({ error: null });
    });
    const fetchMock = vi.fn();
    await expect(
      sendTelnyxSms(
        { apiKey: "k", messagingProfileId: "p" },
        "+15550001111",
        "Hi",
        { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1" }
      )
    ).rejects.toThrow("Monthly SMS limit reached");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when reserve RPC errors", async () => {
    rpc.mockImplementation((name: string) => {
      if (name === "try_reserve_sms_outbound_slot") {
        return Promise.resolve({ data: null, error: { message: "db down" } });
      }
      return Promise.resolve({ error: null });
    });
    await expect(
      sendTelnyxSms(
        { apiKey: "k", messagingProfileId: "p" },
        "+15550001111",
        "Hi",
        { meterBusinessId: "biz-1" }
      )
    ).rejects.toThrow("quota reserve failed: db down");
  });

  it("releases slot when Telnyx returns non-OK", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      text: () => Promise.resolve("err")
    });
    await expect(
      sendTelnyxSms(
        { apiKey: "k", messagingProfileId: "p" },
        "+15550001111",
        "Hi",
        { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1" }
      )
    ).rejects.toThrow("Telnyx SMS error");
    expect(rpc).toHaveBeenCalledWith("release_sms_outbound_slot", { p_business_id: "biz-1" });
  });

  it("releases slot when response has no message id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: {} })
    });
    await expect(
      sendTelnyxSms(
        { apiKey: "k", messagingProfileId: "p" },
        "+15550001111",
        "Hi",
        { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1" }
      )
    ).rejects.toThrow("missing message id");
    expect(rpc).toHaveBeenCalledWith("release_sms_outbound_slot", { p_business_id: "biz-1" });
  });

  it("releases slot when fetch throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network"));
    await expect(
      sendTelnyxSms(
        { apiKey: "k", messagingProfileId: "p" },
        "+15550001111",
        "Hi",
        { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1" }
      )
    ).rejects.toThrow("network");
    expect(rpc).toHaveBeenCalledWith("release_sms_outbound_slot", { p_business_id: "biz-1" });
  });

  it("logs when release_sms_outbound_slot returns an error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockImplementation((name: string) => {
      if (name === "try_reserve_sms_outbound_slot") {
        return Promise.resolve({ data: { ok: true }, error: null });
      }
      if (name === "release_sms_outbound_slot") {
        return Promise.resolve({ error: { message: "db write failed" } });
      }
      return Promise.resolve({ error: null });
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      text: () => Promise.resolve("")
    });
    await expect(
      sendTelnyxSms(
        { apiKey: "k", messagingProfileId: "p" },
        "+15550001111",
        "Hi",
        { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1" }
      )
    ).rejects.toThrow("Telnyx SMS error");
    expect(errSpy).toHaveBeenCalledWith(
      "sendTelnyxSms: release_sms_outbound_slot failed",
      "db write failed"
    );
    errSpy.mockRestore();
  });

  it("throws without calling Telnyx when throttle RPC returns ok:false", async () => {
    rpc.mockImplementation((name: string) => {
      if (name === "sms_outbound_rate_check") {
        return Promise.resolve({ data: { ok: false, reason: "rate_limited" }, error: null });
      }
      return Promise.resolve({ error: null });
    });
    const fetchMock = vi.fn();
    await expect(
      sendTelnyxSms(
        { apiKey: "k", messagingProfileId: "p" },
        "+15550001111",
        "Hi",
        { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1" }
      )
    ).rejects.toThrow("SMS quota blocked: rate_limited");
    expect(fetchMock).not.toHaveBeenCalled();
    // Should not have proceeded to reserve a slot once the throttle refuses.
    expect(rpc).not.toHaveBeenCalledWith("try_reserve_sms_outbound_slot", expect.anything());
  });

  it("fails open (warns + continues) when throttle RPC errors", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    rpc.mockImplementation((name: string) => {
      if (name === "sms_outbound_rate_check") {
        return Promise.resolve({ data: null, error: { message: "db offline" } });
      }
      if (name === "try_reserve_sms_outbound_slot") {
        return Promise.resolve({ data: { ok: true }, error: null });
      }
      return Promise.resolve({ error: null });
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "mFailOpen" } })
    });
    const id = await sendTelnyxSms(
      { apiKey: "k", messagingProfileId: "p" },
      "+15550001111",
      "Hi",
      { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1" }
    );
    expect(id).toBe("mFailOpen");
    expect(warnSpy).toHaveBeenCalledWith(
      "sendTelnyxSms: sms_outbound_rate_check failed (fail-open)",
      "db offline"
    );
    expect(rpc).toHaveBeenCalledWith("try_reserve_sms_outbound_slot", { p_business_id: "biz-1" });
    warnSpy.mockRestore();
  });

  it("skips the throttle check entirely when throttleMaxPerSecond is 0", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "mNoThrottle" } })
    });
    await sendTelnyxSms(
      { apiKey: "k", messagingProfileId: "p" },
      "+15550001111",
      "Hi",
      {
        fetchImpl: fetchMock as typeof fetch,
        meterBusinessId: "biz-1",
        throttleMaxPerSecond: 0
      }
    );
    expect(rpc).not.toHaveBeenCalledWith("sms_outbound_rate_check", expect.anything());
    expect(rpc).toHaveBeenCalledWith("try_reserve_sms_outbound_slot", { p_business_id: "biz-1" });
  });

  it("includes Idempotency-Key and from when metering", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "mid" } })
    });
    await sendTelnyxSms(
      {
        apiKey: "k",
        messagingProfileId: "p",
        fromE164: "+15550009999"
      },
      "+15550001111",
      "Hi",
      {
        fetchImpl: fetchMock as typeof fetch,
        meterBusinessId: "biz-1",
        idempotencyKey: "idem-z"
      }
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const h = init.headers as Record<string, string>;
    expect(h["Idempotency-Key"]).toBe("idem-z");
    const body = JSON.parse(init.body as string);
    expect(body.from).toBe("+15550009999");
  });
});
