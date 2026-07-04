import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MISSED_CALL_AUTOTEXT_WINDOW_SECONDS,
  buildMissedCallAutotextMessage,
  missedCallAutotextTierAllowed,
  sendMissedCallAutotext,
  type AutotextSupabase
} from "../supabase/functions/_shared/missed_call_autotext";

type RpcResult = { data: unknown; error: { message: string } | null };

function makeSupabase(overrides: {
  business?: RpcResult;
  channelSettings?: RpcResult;
  telnyxSettings?: RpcResult;
  rpc?: (fn: string, args: Record<string, unknown>) => RpcResult;
}) {
  const updateEq = vi.fn().mockResolvedValue({ data: null, error: null });
  const update = vi.fn().mockReturnValue({ eq: updateEq });
  const deleteEq = vi.fn().mockResolvedValue({ data: null, error: null });
  const deleteFn = vi.fn().mockReturnValue({ eq: deleteEq });
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (overrides.rpc) return overrides.rpc(fn, args);
    if (fn === "sms_is_opted_out") return { data: false, error: null };
    if (fn === "try_mark_missed_call_autotext") return { data: "ledger-1", error: null };
    if (fn === "try_reserve_sms_outbound_slot") {
      return { data: { ok: true, source: "included" }, error: null };
    }
    return { data: null, error: null };
  });
  const from = vi.fn((table: string) => ({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn(async () => {
          if (table === "businesses") {
            return overrides.business ?? { data: { tier: "standard", name: "Sunrise Realty" }, error: null };
          }
          if (table === "business_channel_settings") {
            return overrides.channelSettings ?? { data: null, error: null };
          }
          if (table === "business_telnyx_settings") {
            return (
              overrides.telnyxSettings ?? {
                data: {
                  telnyx_messaging_profile_id: "prof_biz",
                  telnyx_sms_from_e164: "+15550001111"
                },
                error: null
              }
            );
          }
          return { data: null, error: null };
        })
      })
    }),
    update,
    delete: deleteFn
  }));
  return {
    supabase: { from, rpc } as unknown as AutotextSupabase,
    from,
    rpc,
    update,
    updateEq,
    deleteFn,
    deleteEq
  };
}

function okFetch(mid = "msg_1") {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({ data: { id: mid } })
  }) as unknown as typeof fetch;
}

const baseOpts = {
  businessId: "biz-1",
  callerE164: "+15551234567",
  reason: "concurrent_limit" as const,
  telnyxApiKey: "key_1",
  defaultMessagingProfileId: "prof_env",
  defaultFromE164: "+15559990000"
};

describe("missed-call auto-text helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("missedCallAutotextTierAllowed gates on standard/enterprise", () => {
    expect(missedCallAutotextTierAllowed("standard")).toBe(true);
    expect(missedCallAutotextTierAllowed("enterprise")).toBe(true);
    expect(missedCallAutotextTierAllowed("starter")).toBe(false);
    expect(missedCallAutotextTierAllowed(null)).toBe(false);
    expect(missedCallAutotextTierAllowed(undefined)).toBe(false);
  });

  it("buildMissedCallAutotextMessage includes the business name when present", () => {
    expect(buildMissedCallAutotextMessage("Sunrise Realty")).toBe(
      "Sorry we missed your call! This is Sunrise Realty. Reply here and we'll help you by text."
    );
    expect(buildMissedCallAutotextMessage("  ")).toBe(
      "Sorry we missed your call! Reply here and we'll help you by text."
    );
    expect(buildMissedCallAutotextMessage(null)).toContain("Sorry we missed your call!");
  });

  it("sends the auto-text and records the Telnyx message id on the ledger row", async () => {
    const { supabase, rpc, update, updateEq } = makeSupabase({});
    const fetchFn = okFetch("msg_42");

    const outcome = await sendMissedCallAutotext(supabase, { ...baseOpts, fetchFn });

    expect(outcome).toEqual({ status: "sent", telnyxMessageId: "msg_42" });
    expect(rpc).toHaveBeenCalledWith("try_mark_missed_call_autotext", {
      p_business_id: "biz-1",
      p_caller_e164: "+15551234567",
      p_reason: "concurrent_limit",
      p_window_seconds: MISSED_CALL_AUTOTEXT_WINDOW_SECONDS
    });
    expect(rpc).toHaveBeenCalledWith("try_reserve_sms_outbound_slot", {
      p_business_id: "biz-1"
    });
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.telnyx.com/v2/messages");
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toEqual({
      to: "+15551234567",
      from: "+15550001111",
      text: "Sorry we missed your call! This is Sunrise Realty. Reply here and we'll help you by text.",
      messaging_profile_id: "prof_biz"
    });
    expect(update).toHaveBeenCalledWith({ telnyx_message_id: "msg_42" });
    expect(updateEq).toHaveBeenCalledWith("id", "ledger-1");
  });

  it("falls back to env messaging profile + from number when tenant settings are empty", async () => {
    const { supabase } = makeSupabase({
      telnyxSettings: { data: { telnyx_messaging_profile_id: "", telnyx_sms_from_e164: null }, error: null }
    });
    const fetchFn = okFetch();

    const outcome = await sendMissedCallAutotext(supabase, { ...baseOpts, fetchFn });

    expect(outcome.status).toBe("sent");
    const body = JSON.parse(
      ((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1] as { body: string }).body
    );
    expect(body.from).toBe("+15559990000");
    expect(body.messaging_profile_id).toBe("prof_env");
  });

  it("sends without a ledger update when Telnyx returns no message id", async () => {
    const { supabase, update } = makeSupabase({});
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: {} })
    }) as unknown as typeof fetch;

    const outcome = await sendMissedCallAutotext(supabase, { ...baseOpts, fetchFn });
    expect(outcome).toEqual({ status: "sent" });
    expect(update).not.toHaveBeenCalled();
  });

  it("uses global fetch and the nameless copy when fetchFn/business name are absent", async () => {
    const { supabase } = makeSupabase({
      business: { data: { tier: "standard" }, error: null }
    });
    const globalFetch = okFetch("msg_global");
    vi.stubGlobal("fetch", globalFetch);
    try {
      const outcome = await sendMissedCallAutotext(supabase, { ...baseOpts });
      expect(outcome).toEqual({ status: "sent", telnyxMessageId: "msg_global" });
      const body = JSON.parse(
        ((globalFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as { body: string }).body
      );
      expect(body.text).toBe("Sorry we missed your call! Reply here and we'll help you by text.");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("tolerates a non-JSON Telnyx success body", async () => {
    const { supabase } = makeSupabase({});
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockRejectedValue(new Error("bad json"))
    }) as unknown as typeof fetch;

    const outcome = await sendMissedCallAutotext(supabase, { ...baseOpts, fetchFn });
    expect(outcome).toEqual({ status: "sent" });
  });

  it("skips anonymous / malformed callers", async () => {
    const { supabase, rpc } = makeSupabase({});
    for (const callerE164 of [null, "", "anonymous", "15551234567", "+1555"]) {
      const outcome = await sendMissedCallAutotext(supabase, { ...baseOpts, callerE164 });
      expect(outcome).toEqual({ status: "skipped", reason: "no_caller" });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("skips starter-tier businesses", async () => {
    const { supabase } = makeSupabase({
      business: { data: { tier: "starter", name: "Solo Shop" }, error: null }
    });
    const outcome = await sendMissedCallAutotext(supabase, baseOpts);
    expect(outcome).toEqual({ status: "skipped", reason: "tier" });
  });

  it("fails when the business lookup errors", async () => {
    const { supabase } = makeSupabase({
      business: { data: null, error: { message: "db down" } }
    });
    const outcome = await sendMissedCallAutotext(supabase, baseOpts);
    expect(outcome).toEqual({ status: "failed", reason: "business_lookup:db down" });
  });

  it("skips when the per-tenant kill switch is off", async () => {
    const { supabase } = makeSupabase({
      channelSettings: { data: { missed_call_autotext_enabled: false }, error: null }
    });
    const outcome = await sendMissedCallAutotext(supabase, baseOpts);
    expect(outcome).toEqual({ status: "skipped", reason: "disabled" });
  });

  it("treats a missing channel-settings row as enabled", async () => {
    const { supabase } = makeSupabase({ channelSettings: { data: null, error: null } });
    const outcome = await sendMissedCallAutotext(supabase, { ...baseOpts, fetchFn: okFetch() });
    expect(outcome.status).toBe("sent");
  });

  it("skips opted-out callers and opt-out lookup failures", async () => {
    const optedOut = makeSupabase({
      rpc: (fn) =>
        fn === "sms_is_opted_out" ? { data: true, error: null } : { data: null, error: null }
    });
    expect(await sendMissedCallAutotext(optedOut.supabase, baseOpts)).toEqual({
      status: "skipped",
      reason: "opt_out"
    });

    const lookupFail = makeSupabase({
      rpc: (fn) =>
        fn === "sms_is_opted_out"
          ? { data: null, error: { message: "rpc down" } }
          : { data: null, error: null }
    });
    expect(await sendMissedCallAutotext(lookupFail.supabase, baseOpts)).toEqual({
      status: "skipped",
      reason: "opt_out_lookup_failed"
    });
  });

  it("skips when the caller was already texted within the window", async () => {
    const { supabase } = makeSupabase({
      rpc: (fn) => {
        if (fn === "sms_is_opted_out") return { data: false, error: null };
        if (fn === "try_mark_missed_call_autotext") return { data: null, error: null };
        return { data: null, error: null };
      }
    });
    const outcome = await sendMissedCallAutotext(supabase, baseOpts);
    expect(outcome).toEqual({ status: "skipped", reason: "deduped" });
  });

  it("fails when the dedup claim errors", async () => {
    const { supabase } = makeSupabase({
      rpc: (fn) => {
        if (fn === "sms_is_opted_out") return { data: false, error: null };
        if (fn === "try_mark_missed_call_autotext") {
          return { data: null, error: { message: "lock timeout" } };
        }
        return { data: null, error: null };
      }
    });
    const outcome = await sendMissedCallAutotext(supabase, baseOpts);
    expect(outcome).toEqual({ status: "failed", reason: "dedup:lock timeout" });
  });

  it("skips when messaging is not configured or the caller IS the business number", async () => {
    const noKey = makeSupabase({});
    expect(
      await sendMissedCallAutotext(noKey.supabase, { ...baseOpts, telnyxApiKey: "" })
    ).toEqual({ status: "skipped", reason: "no_messaging" });
    expect(noKey.deleteEq).toHaveBeenCalledWith("id", "ledger-1");

    const noProfile = makeSupabase({
      telnyxSettings: { data: null, error: null }
    });
    expect(
      await sendMissedCallAutotext(noProfile.supabase, {
        ...baseOpts,
        defaultMessagingProfileId: "",
        defaultFromE164: ""
      })
    ).toEqual({ status: "skipped", reason: "no_messaging" });
    expect(noProfile.deleteEq).toHaveBeenCalledWith("id", "ledger-1");

    const selfCall = makeSupabase({
      telnyxSettings: {
        data: { telnyx_messaging_profile_id: "prof_biz", telnyx_sms_from_e164: "+15551234567" },
        error: null
      }
    });
    expect(await sendMissedCallAutotext(selfCall.supabase, baseOpts)).toEqual({
      status: "skipped",
      reason: "no_messaging"
    });
    expect(selfCall.deleteEq).toHaveBeenCalledWith("id", "ledger-1");
  });

  it("skips when the monthly SMS cap refuses the slot", async () => {
    const { supabase, deleteEq } = makeSupabase({
      rpc: (fn) => {
        if (fn === "sms_is_opted_out") return { data: false, error: null };
        if (fn === "try_mark_missed_call_autotext") return { data: "ledger-1", error: null };
        if (fn === "try_reserve_sms_outbound_slot") {
          return { data: { ok: false, reason: "monthly_sms_limit" }, error: null };
        }
        return { data: null, error: null };
      }
    });
    const outcome = await sendMissedCallAutotext(supabase, baseOpts);
    expect(outcome).toEqual({ status: "skipped", reason: "sms_cap:monthly_sms_limit" });
    expect(deleteEq).toHaveBeenCalledWith("id", "ledger-1");
  });

  it("reports a generic cap reason when the reserve RPC returns an empty payload", async () => {
    const { supabase, deleteEq } = makeSupabase({
      rpc: (fn) => {
        if (fn === "sms_is_opted_out") return { data: false, error: null };
        if (fn === "try_mark_missed_call_autotext") return { data: "ledger-1", error: null };
        if (fn === "try_reserve_sms_outbound_slot") return { data: null, error: null };
        return { data: null, error: null };
      }
    });
    const outcome = await sendMissedCallAutotext(supabase, baseOpts);
    expect(outcome).toEqual({ status: "skipped", reason: "sms_cap:monthly_sms_limit" });
    expect(deleteEq).toHaveBeenCalledWith("id", "ledger-1");
  });

  it("fails when the reserve RPC errors", async () => {
    const { supabase, deleteEq } = makeSupabase({
      rpc: (fn) => {
        if (fn === "sms_is_opted_out") return { data: false, error: null };
        if (fn === "try_mark_missed_call_autotext") return { data: "ledger-1", error: null };
        if (fn === "try_reserve_sms_outbound_slot") {
          return { data: null, error: { message: "rpc down" } };
        }
        return { data: null, error: null };
      }
    });
    const outcome = await sendMissedCallAutotext(supabase, baseOpts);
    expect(outcome).toEqual({ status: "failed", reason: "sms_reserve:rpc down" });
    expect(deleteEq).toHaveBeenCalledWith("id", "ledger-1");
  });

  it("releases the metered slot (refunding bonus texts) when Telnyx rejects the send", async () => {
    const releaseCalls: Array<Record<string, unknown>> = [];
    const { supabase } = makeSupabase({
      rpc: (fn, args) => {
        if (fn === "sms_is_opted_out") return { data: false, error: null };
        if (fn === "try_mark_missed_call_autotext") return { data: "ledger-1", error: null };
        if (fn === "try_reserve_sms_outbound_slot") {
          return { data: { ok: true, source: "bonus" }, error: null };
        }
        if (fn === "release_sms_outbound_slot") {
          releaseCalls.push(args);
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }
    });
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 422 }) as unknown as typeof fetch;

    const outcome = await sendMissedCallAutotext(supabase, { ...baseOpts, fetchFn });
    expect(outcome).toEqual({ status: "failed", reason: "telnyx_422" });
    expect(releaseCalls).toEqual([{ p_business_id: "biz-1", p_refund_bonus: true }]);
  });

  it("releases the metered slot but keeps the dedup row when fetch itself throws", async () => {
    const releaseCalls: Array<Record<string, unknown>> = [];
    const { supabase, deleteFn } = makeSupabase({
      rpc: (fn, args) => {
        if (fn === "sms_is_opted_out") return { data: false, error: null };
        if (fn === "try_mark_missed_call_autotext") return { data: "ledger-1", error: null };
        if (fn === "try_reserve_sms_outbound_slot") {
          return { data: { ok: true, source: "included" }, error: null };
        }
        if (fn === "release_sms_outbound_slot") {
          releaseCalls.push(args);
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }
    });
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    const outcome = await sendMissedCallAutotext(supabase, { ...baseOpts, fetchFn });
    expect(outcome).toEqual({ status: "failed", reason: "network down" });
    expect(releaseCalls).toEqual([{ p_business_id: "biz-1", p_refund_bonus: false }]);
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("stringifies non-Error fetch throws while releasing the slot", async () => {
    const { supabase } = makeSupabase({});
    const fetchFn = vi.fn().mockRejectedValue("socket reset") as unknown as typeof fetch;

    const outcome = await sendMissedCallAutotext(supabase, { ...baseOpts, fetchFn });
    expect(outcome).toEqual({ status: "failed", reason: "socket reset" });
  });

  it("returns failed on unexpected throws instead of propagating", async () => {
    const supabase = {
      from: () => {
        throw new Error("boom");
      },
      rpc: vi.fn()
    } as unknown as AutotextSupabase;

    const outcome = await sendMissedCallAutotext(supabase, baseOpts);
    expect(outcome).toEqual({ status: "failed", reason: "boom" });
  });

  it("stringifies non-Error throws", async () => {
    const supabase = {
      from: () => {
        throw "string boom";
      },
      rpc: vi.fn()
    } as unknown as AutotextSupabase;

    const outcome = await sendMissedCallAutotext(supabase, baseOpts);
    expect(outcome).toEqual({ status: "failed", reason: "string boom" });
  });
});
