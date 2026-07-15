import { describe, expect, it, vi } from "vitest";
import {
  meterOperationalSms,
  releaseOperationalSms,
  sendOperationalSms,
  type OperationalMeterSupabase
} from "../supabase/functions/_shared/sms_operational_meter.ts";

const BIZ = "11111111-1111-4111-8111-111111111111";

function supa(rpcImpl: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>): OperationalMeterSupabase & { rpc: ReturnType<typeof vi.fn> } {
  return { rpc: vi.fn(rpcImpl) };
}

describe("meterOperationalSms", () => {
  it("counts and surfaces the ledger source", async () => {
    const s = supa(async () => ({ data: { counted: true, source: "overage" }, error: null }));
    expect(await meterOperationalSms(s, BIZ)).toEqual({ counted: true, detail: "overage" });
    expect(s.rpc).toHaveBeenCalledWith("meter_sms_operational_send", { p_business_id: BIZ });
  });

  it("defaults the source to plan when the RPC omits it", async () => {
    const s = supa(async () => ({ data: { counted: true }, error: null }));
    expect(await meterOperationalSms(s, BIZ)).toEqual({ counted: true, detail: "plan" });
  });

  it("reports not-counted reasons without throwing", async () => {
    const s = supa(async () => ({ data: { counted: false, reason: "no_business" }, error: null }));
    expect(await meterOperationalSms(s, BIZ)).toEqual({ counted: false, detail: "no_business" });

    const empty = supa(async () => ({ data: null, error: null }));
    expect(await meterOperationalSms(empty, BIZ)).toEqual({ counted: false, detail: "not_counted" });
  });

  it("never throws: RPC errors and thrown shapes become outcomes", async () => {
    const rpcErr = supa(async () => ({ data: null, error: { message: "db down" } }));
    expect(await meterOperationalSms(rpcErr, BIZ)).toEqual({
      counted: false,
      detail: "rpc_error:db down"
    });

    const throwing = supa(async () => {
      throw new Error("boom");
    });
    expect(await meterOperationalSms(throwing, BIZ)).toEqual({
      counted: false,
      detail: "error:boom"
    });

    const throwingString = supa(async () => {
      throw "plain";
    });
    expect(await meterOperationalSms(throwingString, BIZ)).toEqual({
      counted: false,
      detail: "error:plain"
    });
  });
});

describe("releaseOperationalSms", () => {
  it("skips entirely when nothing was counted", async () => {
    const s = supa(async () => ({ data: null, error: null }));
    await releaseOperationalSms(s, BIZ, { counted: false, detail: "no_business" });
    expect(s.rpc).not.toHaveBeenCalled();
  });

  it("releases with a bonus refund when the meter consumed a bonus text", async () => {
    const s = supa(async () => ({ data: null, error: null }));
    await releaseOperationalSms(s, BIZ, { counted: true, detail: "bonus" });
    expect(s.rpc).toHaveBeenCalledWith("release_sms_outbound_slot", {
      p_business_id: BIZ,
      p_refund_bonus: true
    });

    await releaseOperationalSms(s, BIZ, { counted: true, detail: "plan" });
    expect(s.rpc).toHaveBeenLastCalledWith("release_sms_outbound_slot", {
      p_business_id: BIZ,
      p_refund_bonus: false
    });
  });

  it("never throws on release failures (Error, string, rpc error)", async () => {
    const rpcErr = supa(async () => ({ data: null, error: { message: "x" } }));
    await expect(
      releaseOperationalSms(rpcErr, BIZ, { counted: true, detail: "plan" })
    ).resolves.toBeUndefined();

    const throwing = supa(async () => {
      throw new Error("boom");
    });
    await expect(
      releaseOperationalSms(throwing, BIZ, { counted: true, detail: "plan" })
    ).resolves.toBeUndefined();

    const throwingString = supa(async () => {
      throw "plain";
    });
    await expect(
      releaseOperationalSms(throwingString, BIZ, { counted: true, detail: "plan" })
    ).resolves.toBeUndefined();
  });
});

describe("sendOperationalSms", () => {
  const sendParams = (fetchImpl: typeof fetch) => ({
    apiKey: "k",
    messagingProfileId: "p",
    fromE164: "+14388035806",
    toE164: "+15145188192",
    text: "hello",
    fetchImpl
  });

  const okFetch = () =>
    vi.fn(async () => new Response(JSON.stringify({ data: { id: "m1" } }), { status: 200 }));
  const failFetch = () => vi.fn(async () => new Response("err", { status: 500 }));

  it("meters then sends; success keeps the counted slot", async () => {
    const s = supa(async (fn) =>
      fn === "meter_sms_operational_send"
        ? { data: { counted: true, source: "plan" }, error: null }
        : { data: null, error: null }
    );
    const res = await sendOperationalSms(s, BIZ, sendParams(okFetch() as unknown as typeof fetch));
    expect(res.ok).toBe(true);
    expect(s.rpc).toHaveBeenCalledWith("meter_sms_operational_send", { p_business_id: BIZ });
    expect(s.rpc).not.toHaveBeenCalledWith("release_sms_outbound_slot", expect.anything());
  });

  it("releases the counted slot when the send never left Telnyx", async () => {
    const s = supa(async (fn) =>
      fn === "meter_sms_operational_send"
        ? { data: { counted: true, source: "bonus" }, error: null }
        : { data: null, error: null }
    );
    const res = await sendOperationalSms(s, BIZ, sendParams(failFetch() as unknown as typeof fetch));
    expect(res.ok).toBe(false);
    expect(s.rpc).toHaveBeenCalledWith("release_sms_outbound_slot", {
      p_business_id: BIZ,
      p_refund_bonus: true
    });
  });

  it("skips metering entirely for sends with no routable tenant", async () => {
    const s = supa(async () => ({ data: null, error: null }));
    const ok = await sendOperationalSms(s, null, sendParams(okFetch() as unknown as typeof fetch));
    expect(ok.ok).toBe(true);
    const fail = await sendOperationalSms(s, null, sendParams(failFetch() as unknown as typeof fetch));
    expect(fail.ok).toBe(false);
    expect(s.rpc).not.toHaveBeenCalled();
  });

  it("releases the counted slot when the send transport THROWS (network error)", async () => {
    const s = supa(async (fn) =>
      fn === "meter_sms_operational_send"
        ? { data: { counted: true, source: "plan" }, error: null }
        : { data: null, error: null }
    );
    const throwingFetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      sendOperationalSms(s, BIZ, sendParams(throwingFetch as unknown as typeof fetch))
    ).rejects.toThrow("fetch failed");
    expect(s.rpc).toHaveBeenCalledWith("release_sms_outbound_slot", {
      p_business_id: BIZ,
      p_refund_bonus: false
    });
  });

  it("rethrows a transport error without releasing when no tenant was metered", async () => {
    const s = supa(async () => ({ data: null, error: null }));
    const throwingFetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      sendOperationalSms(s, null, sendParams(throwingFetch as unknown as typeof fetch))
    ).rejects.toThrow("fetch failed");
    expect(s.rpc).not.toHaveBeenCalled();
  });
});
