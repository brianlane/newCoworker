import { describe, it, expect, vi, beforeEach } from "vitest";

const createSupabaseServiceClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient
}));

import { sendTelnyxSms, reserveSlotFailureMessage } from "@/lib/telnyx/messaging";
import { MMS_TEXT_UNITS } from "@/lib/sms/segment-info";
import { INTERNATIONAL_MMS_ERROR } from "@/lib/telnyx/international-gateway";

describe("reserveSlotFailureMessage", () => {
  it("maps known reasons", () => {
    expect(reserveSlotFailureMessage({ ok: false, reason: "monthly_sms_limit" })).toBe(
      "Monthly SMS limit reached"
    );
    expect(reserveSlotFailureMessage({ ok: false, reason: "no_business" })).toBe("Business not found");
    expect(reserveSlotFailureMessage({ ok: false, reason: "throttled" })).toBe(
      "SMS throughput throttled (please retry in a moment)"
    );
    expect(reserveSlotFailureMessage({ ok: false, reason: "destination_blocked" })).toBe(
      "Texting this destination is not supported"
    );
    expect(reserveSlotFailureMessage({ ok: false, reason: "destination_unknown" })).toBe(
      "Unrecognized destination country for this number"
    );
    expect(reserveSlotFailureMessage({ ok: false, reason: "destination_velocity" })).toBe(
      "Too many texts to this country in the last hour (limit resets shortly)"
    );
  });

  it("falls back for unknown reason and empty", () => {
    expect(reserveSlotFailureMessage({ ok: false, reason: "other" })).toBe("SMS quota blocked: other");
    expect(reserveSlotFailureMessage(null)).toBe("SMS quota blocked");
    expect(reserveSlotFailureMessage({ ok: false })).toBe("SMS quota blocked");
  });
});

describe("sendTelnyxSms meterMode: operational (count always, never refuse)", () => {
  const rpc = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockImplementation((name: string) => {
      if (name === "meter_sms_operational_send") {
        return Promise.resolve({ data: { counted: true, source: "plan" }, error: null });
      }
      if (name === "release_sms_outbound_slot") {
        return Promise.resolve({ error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    createSupabaseServiceClient.mockResolvedValue({ rpc } as never);
  });

  const okFetch = () =>
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "m1" } })
    });

  it("counts via the operational RPC and sends, no reserve, no throttle", async () => {
    const fetchMock = okFetch();
    const { id } = await sendTelnyxSms(
      { apiKey: "k", messagingProfileId: "p" },
      "+15145188192",
      "Your New Coworker is live!",
      { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1", meterMode: "operational" }
    );
    expect(id).toBe("m1");
    expect(rpc).toHaveBeenCalledWith("meter_sms_operational_send", { p_business_id: "biz-1", p_text_units: 1 });
    expect(rpc).not.toHaveBeenCalledWith("try_reserve_sms_outbound_slot", expect.anything());
    expect(rpc).not.toHaveBeenCalledWith("sms_outbound_rate_check", expect.anything());
    expect(rpc).not.toHaveBeenCalledWith("release_sms_outbound_slot", expect.anything());
  });

  it("still sends when the operational meter RPC errors (log-and-continue)", async () => {
    rpc.mockImplementation((name: string) => {
      if (name === "meter_sms_operational_send") {
        return Promise.resolve({ data: null, error: { message: "ledger down" } });
      }
      return Promise.resolve({ error: null });
    });
    const fetchMock = okFetch();
    const { id } = await sendTelnyxSms(
      { apiKey: "k", messagingProfileId: "p" },
      "+15145188192",
      "Alert",
      { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1", meterMode: "operational" }
    );
    expect(id).toBe("m1");
    // Nothing counted → nothing released even if later steps failed.
  });

  it("releases (with bonus refund) when a bonus-counted send fails at Telnyx", async () => {
    rpc.mockImplementation((name: string) => {
      if (name === "meter_sms_operational_send") {
        return Promise.resolve({ data: { counted: true, source: "bonus" }, error: null });
      }
      return Promise.resolve({ error: null });
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      text: () => Promise.resolve("err")
    });
    await expect(
      sendTelnyxSms(
        { apiKey: "k", messagingProfileId: "p" },
        "+15145188192",
        "Alert",
        { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1", meterMode: "operational" }
      )
    ).rejects.toThrow("Telnyx SMS error");
    expect(rpc).toHaveBeenCalledWith("release_sms_outbound_slot", {
      p_business_id: "biz-1",
      p_refund_bonus: true,
      p_text_units: 1
    });
  });

  it("does not release after a failed send when the meter never counted", async () => {
    rpc.mockImplementation((name: string) => {
      if (name === "meter_sms_operational_send") {
        return Promise.resolve({ data: { counted: false, reason: "no_business" }, error: null });
      }
      return Promise.resolve({ error: null });
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      text: () => Promise.resolve("err")
    });
    await expect(
      sendTelnyxSms(
        { apiKey: "k", messagingProfileId: "p" },
        "+15145188192",
        "Alert",
        { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1", meterMode: "operational" }
      )
    ).rejects.toThrow("Telnyx SMS error");
    expect(rpc).not.toHaveBeenCalledWith("release_sms_outbound_slot", expect.anything());
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
    const { id } = await sendTelnyxSms(
      { apiKey: "k", messagingProfileId: "p" },
      "+15550001111",
      "Hi",
      { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1" }
    );
    expect(id).toBe("m1");
    expect(rpc).toHaveBeenCalledWith("try_reserve_sms_outbound_slot", {
      p_business_id: "biz-1",
      p_text_units: 1,
      p_destination_e164: "+15550001111"
    });
    expect(rpc).not.toHaveBeenCalledWith("release_sms_outbound_slot", expect.anything());
  });

  it("reserves one unit per part for a long body and refunds the same on failure", async () => {
    // Amy's real ai_flow message length: 1,342 GSM chars = 9 parts. Under the
    // old message-denominated meter this billed 9 parts and counted 1, the
    // overspend hole this change closes.
    const longBody = "a".repeat(1342);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("bad request")
    });
    await expect(
      sendTelnyxSms({ apiKey: "k", messagingProfileId: "p" }, "+15550001111", longBody, {
        fetchImpl: fetchMock as typeof fetch,
        meterBusinessId: "biz-1"
      })
    ).rejects.toThrow("Telnyx SMS error");
    expect(rpc).toHaveBeenCalledWith("try_reserve_sms_outbound_slot", {
      p_business_id: "biz-1",
      p_text_units: 9,
      p_destination_e164: "+15550001111"
    });
    // The failed send must refund exactly what the reserve charged.
    expect(rpc).toHaveBeenCalledWith("release_sms_outbound_slot", {
      p_business_id: "biz-1",
      p_refund_bonus: false,
      p_text_units: 9
    });
  });

  it("multiplies units by the destination country's cost ratio", async () => {
    // Denmark is the deck's most expensive long-code destination: 18.3x the
    // blended US per-part rate, so one single-part message reserves 18.3
    // units. That is the whole support-every-country model.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "m3" } })
    });
    await sendTelnyxSms({ apiKey: "k", messagingProfileId: "p" }, "+4520123456", "Hej", {
      fetchImpl: fetchMock as typeof fetch,
      meterBusinessId: "biz-1"
    });
    expect(rpc).toHaveBeenCalledWith("try_reserve_sms_outbound_slot", {
      p_business_id: "biz-1",
      p_text_units: 18.3,
      p_destination_e164: "+4520123456"
    });
  });

  it("surfaces the destination-gate refusal reasons", async () => {
    rpc.mockImplementation((name: string) => {
      if (name === "try_reserve_sms_outbound_slot") {
        return Promise.resolve({ data: { ok: false, reason: "destination_blocked" }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const fetchMock = vi.fn();
    await expect(
      sendTelnyxSms({ apiKey: "k", messagingProfileId: "p" }, "+5355512345", "Hi", {
        fetchImpl: fetchMock as typeof fetch,
        meterBusinessId: "biz-1"
      })
    ).rejects.toThrow("Texting this destination is not supported");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes an international send through the gateway from-number", async () => {
    vi.stubEnv("TELNYX_INTL_GATEWAY_E164", "+16028384497");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "m4" } })
    });
    await sendTelnyxSms(
      { apiKey: "k", messagingProfileId: "p", fromE164: "+14388035806" },
      "+85261234567",
      "Hello James",
      { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1" }
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    // The tenant's own A2P number cannot originate international; the P2P
    // gateway substitutes as the visible sender. Metering stays on the
    // tenant regardless of the from-number.
    expect(body.from).toBe("+16028384497");
    expect(rpc).toHaveBeenCalledWith("try_reserve_sms_outbound_slot", {
      p_business_id: "biz-1",
      p_text_units: 1,
      p_destination_e164: "+85261234567"
    });
    vi.unstubAllEnvs();
  });

  it("keeps the tenant from-number for domestic sends even with a gateway configured", async () => {
    vi.stubEnv("TELNYX_INTL_GATEWAY_E164", "+16028384497");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "m5" } })
    });
    await sendTelnyxSms(
      { apiKey: "k", messagingProfileId: "p", fromE164: "+14388035806" },
      "+16025550100",
      "Hi",
      { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1" }
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.from).toBe("+14388035806");
    vi.unstubAllEnvs();
  });

  it("never puts ANY from-number on an alpha-profile send, even with the gateway configured", async () => {
    // Bugbot on PR #1229: with TELNYX_INTL_GATEWAY_E164 and the alpha
    // profile both set, the gateway substitution would have stamped a P2P
    // phone number over the profile's registered alpha identity. The seam
    // must omit `from` entirely for alpha-profile sends.
    vi.stubEnv("TELNYX_INTL_GATEWAY_E164", "+16028384497");
    vi.stubEnv("TELNYX_INTL_ALPHA_PROFILE_ID", "alpha-prof");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "m4a" } })
    });
    await sendTelnyxSms(
      { apiKey: "k", messagingProfileId: "alpha-prof", fromE164: "+14388035806" },
      "+85261234567",
      "Owner alert",
      { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1", meterMode: "operational" }
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.from).toBeUndefined();
    expect(body.messaging_profile_id).toBe("alpha-prof");
    vi.unstubAllEnvs();
  });

  it("keeps the gateway substitution for non-alpha profiles when both envs are set", async () => {
    vi.stubEnv("TELNYX_INTL_GATEWAY_E164", "+16028384497");
    vi.stubEnv("TELNYX_INTL_ALPHA_PROFILE_ID", "alpha-prof");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "m4b" } })
    });
    await sendTelnyxSms(
      { apiKey: "k", messagingProfileId: "tenant-prof", fromE164: "+14388035806" },
      "+85261234567",
      "Hello James",
      { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1" }
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.from).toBe("+16028384497");
    vi.unstubAllEnvs();
  });

  it("refuses international MMS before metering: zero units, zero Telnyx calls", async () => {
    vi.stubEnv("TELNYX_INTL_GATEWAY_E164", "+16028384497");
    const fetchMock = vi.fn();
    await expect(
      sendTelnyxSms({ apiKey: "k", messagingProfileId: "p" }, "+85261234567", "photo", {
        fetchImpl: fetchMock as typeof fetch,
        meterBusinessId: "biz-1",
        mediaUrls: ["https://example.com/img.png"]
      })
    ).rejects.toThrow(INTERNATIONAL_MMS_ERROR);
    // Refused up front: the P2P gateway cannot carry MMS and the tenant's
    // A2P number cannot reach the destination, so nothing may be charged.
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("keeps the units when Telnyx returns 2xx without a message id (may have charged)", async () => {
    // Refund policy: units are refunded ONLY when Telnyx provably did not
    // charge (a rejection). A 2xx without an id is ambiguous: Telnyx
    // accepted the request, so the charge may exist and the units stay.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: {} })
    });
    await expect(
      sendTelnyxSms({ apiKey: "k", messagingProfileId: "p" }, "+15550001111", "Hi", {
        fetchImpl: fetchMock as typeof fetch,
        meterBusinessId: "biz-1"
      })
    ).rejects.toThrow("missing message id");
    expect(rpc).not.toHaveBeenCalledWith("release_sms_outbound_slot", expect.anything());
  });

  it("meters an MMS as flat MMS_TEXT_UNITS regardless of caption length", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "m2" } })
    });
    await sendTelnyxSms(
      { apiKey: "k", messagingProfileId: "p" },
      "+15550001111",
      "a".repeat(1000),
      {
        fetchImpl: fetchMock as typeof fetch,
        meterBusinessId: "biz-1",
        mediaUrls: ["https://example.com/img.png"]
      }
    );
    expect(rpc).toHaveBeenCalledWith("try_reserve_sms_outbound_slot", {
      p_business_id: "biz-1",
      p_text_units: MMS_TEXT_UNITS,
      p_destination_e164: "+15550001111"
    });
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
    expect(rpc).toHaveBeenCalledWith("release_sms_outbound_slot", {
      p_business_id: "biz-1",
      p_refund_bonus: false,
      p_text_units: 1
    });
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
    expect(rpc).toHaveBeenCalledWith("release_sms_outbound_slot", {
      p_business_id: "biz-1",
      p_refund_bonus: false,
      p_text_units: 1
    });
  });

  it("refunds the bonus grant when a bonus-sourced reserve fails to send", async () => {
    rpc.mockImplementation((name: string) => {
      if (name === "try_reserve_sms_outbound_slot") {
        return Promise.resolve({ data: { ok: true, source: "bonus" }, error: null });
      }
      if (name === "release_sms_outbound_slot") {
        return Promise.resolve({ error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
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
    expect(rpc).toHaveBeenCalledWith("release_sms_outbound_slot", {
      p_business_id: "biz-1",
      p_refund_bonus: true,
      p_text_units: 1
    });
  });

  it("sends a one-time owner cap alert when the monthly limit first blocks a send", async () => {
    const savedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "srv-key";
    try {
      rpc.mockImplementation((name: string) => {
        if (name === "try_reserve_sms_outbound_slot") {
          return Promise.resolve({ data: { ok: false, reason: "monthly_sms_limit" }, error: null });
        }
        if (name === "mark_usage_cap_alert") {
          return Promise.resolve({ data: true, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      await expect(
        sendTelnyxSms(
          { apiKey: "k", messagingProfileId: "p" },
          "+15550001111",
          "Hi",
          { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1" }
        )
      ).rejects.toThrow("Monthly SMS limit reached");
      expect(rpc).toHaveBeenCalledWith(
        "mark_usage_cap_alert",
        expect.objectContaining({
          p_business_id: "biz-1",
          p_cap_kind: "sms_monthly",
          p_period_key: expect.stringMatching(/^\d{4}-\d{2}-01$/)
        })
      );
      // The only fetch is the notifications POST (Telnyx is never called).
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://x.supabase.co/functions/v1/notifications");
      const body = JSON.parse(init.body as string);
      expect(body.record.task_type).toBe("sms_cap_reached");
      expect(body.record.log_payload.surface).toBe("app_send_sms");
    } finally {
      if (savedUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl;
      if (savedKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    }
  });

  it("still posts the cap alert with empty base URL/bearer when the env is unset", async () => {
    // Explicitly exercises the env-UNSET side of the `?? ""` fallbacks so
    // branch coverage doesn't depend on whether the developer's shell has the
    // Supabase env exported (it isn't in CI, it often is locally).
    const savedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      rpc.mockImplementation((name: string) => {
        if (name === "try_reserve_sms_outbound_slot") {
          return Promise.resolve({ data: { ok: false, reason: "monthly_sms_limit" }, error: null });
        }
        if (name === "mark_usage_cap_alert") {
          return Promise.resolve({ data: true, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      await expect(
        sendTelnyxSms(
          { apiKey: "k", messagingProfileId: "p" },
          "+15550001111",
          "Hi",
          { fetchImpl: fetchMock as typeof fetch, meterBusinessId: "biz-1" }
        )
      ).rejects.toThrow("Monthly SMS limit reached");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/functions/v1/notifications");
    } finally {
      if (savedUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl;
      if (savedKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    }
  });

  it("skips the alert POST when another sender already alerted this period", async () => {
    rpc.mockImplementation((name: string) => {
      if (name === "try_reserve_sms_outbound_slot") {
        return Promise.resolve({ data: { ok: false, reason: "monthly_sms_limit" }, error: null });
      }
      if (name === "mark_usage_cap_alert") {
        return Promise.resolve({ data: false, error: null });
      }
      return Promise.resolve({ data: null, error: null });
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

  it("does not alert for non-cap reserve failures", async () => {
    rpc.mockImplementation((name: string) => {
      if (name === "try_reserve_sms_outbound_slot") {
        return Promise.resolve({ data: { ok: false, reason: "no_business" }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    await expect(
      sendTelnyxSms(
        { apiKey: "k", messagingProfileId: "p" },
        "+15550001111",
        "Hi",
        { meterBusinessId: "biz-1" }
      )
    ).rejects.toThrow("Business not found");
    expect(rpc).not.toHaveBeenCalledWith("mark_usage_cap_alert", expect.anything());
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
      "sendTelnyxSms: release_sms_outbound_slot failed (will keep slot flagged)",
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
    const { id } = await sendTelnyxSms(
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
    expect(rpc).toHaveBeenCalledWith("try_reserve_sms_outbound_slot", {
      p_business_id: "biz-1",
      p_text_units: 1,
      p_destination_e164: "+15550001111"
    });
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
    expect(rpc).toHaveBeenCalledWith("try_reserve_sms_outbound_slot", {
      p_business_id: "biz-1",
      p_text_units: 1,
      p_destination_e164: "+15550001111"
    });
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

describe("refund boundary is Telnyx acceptance", () => {
  const rpc = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockImplementation((name: string) => {
      if (name === "try_reserve_sms_outbound_slot") {
        return Promise.resolve({ data: { ok: true }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    createSupabaseServiceClient.mockResolvedValue({ rpc } as never);
  });

  it("keeps the units when the 2xx body fails to parse (charge may exist)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error("bad json"))
    });
    await expect(
      sendTelnyxSms({ apiKey: "k", messagingProfileId: "p" }, "+15550001111", "Hi", {
        fetchImpl: fetchMock as typeof fetch,
        meterBusinessId: "biz-1"
      })
    ).rejects.toThrow("bad json");
    expect(rpc).not.toHaveBeenCalledWith("release_sms_outbound_slot", expect.anything());
  });
});
