import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SCHEDULED_SMS_BATCH_SIZE,
  processDueScheduledSms,
  scheduledSmsTierAllowed,
  type ScheduledSmsSupabase
} from "../supabase/functions/_shared/scheduled_sms";

type DbResult = { data: unknown; error: { message: string } | null };

const ROW = {
  id: "sched-1",
  business_id: "biz-1",
  to_e164: "+15551234567",
  body: "Reminder: your appointment is tomorrow at 10am."
};

function makeSupabase(overrides: {
  claim?: DbResult;
  business?: DbResult;
  telnyxSettings?: DbResult;
  channelSettings?: DbResult;
  priorLog?: DbResult;
  rpc?: (fn: string, args: Record<string, unknown>) => DbResult;
  updateResult?: DbResult;
  updateThrows?: unknown;
  insertResult?: DbResult;
}) {
  const updateEq =
    overrides.updateThrows !== undefined
      ? vi.fn().mockRejectedValue(overrides.updateThrows)
      : vi.fn().mockResolvedValue(overrides.updateResult ?? { data: null, error: null });
  const update = vi.fn().mockReturnValue({ eq: updateEq });
  const insert = vi.fn().mockResolvedValue(overrides.insertResult ?? { data: null, error: null });
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "claim_due_scheduled_sms") {
      return overrides.claim ?? { data: [ROW], error: null };
    }
    if (overrides.rpc) return overrides.rpc(fn, args);
    if (fn === "sms_is_opted_out") return { data: false, error: null };
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
            return overrides.business ?? { data: { tier: "standard" }, error: null };
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
          if (table === "business_channel_settings") {
            return overrides.channelSettings ?? { data: null, error: null };
          }
          if (table === "sms_outbound_log") {
            return overrides.priorLog ?? { data: null, error: null };
          }
          return { data: null, error: null };
        })
      })
    }),
    update,
    insert
  }));
  return {
    supabase: { from, rpc } as unknown as ScheduledSmsSupabase,
    from,
    rpc,
    update,
    updateEq,
    insert
  };
}

function okFetch(mid = "msg_1") {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: mid } }))
  }) as unknown as typeof fetch;
}

const baseOpts = {
  telnyxApiKey: "key_1",
  defaultMessagingProfileId: "prof_env",
  defaultFromE164: "+15559990000"
};

describe("scheduled SMS dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scheduledSmsTierAllowed gates on standard/enterprise", () => {
    expect(scheduledSmsTierAllowed("standard")).toBe(true);
    expect(scheduledSmsTierAllowed("enterprise")).toBe(true);
    expect(scheduledSmsTierAllowed("starter")).toBe(false);
    expect(scheduledSmsTierAllowed(null)).toBe(false);
    expect(scheduledSmsTierAllowed(undefined)).toBe(false);
  });

  it("throws when the claim RPC errors", async () => {
    const { supabase } = makeSupabase({ claim: { data: null, error: { message: "db down" } } });
    await expect(processDueScheduledSms(supabase, baseOpts)).rejects.toThrow(
      "claim_due_scheduled_sms: db down"
    );
  });

  it("returns empty on an empty (or non-array) claim", async () => {
    const empty = makeSupabase({ claim: { data: [], error: null } });
    expect(await processDueScheduledSms(empty.supabase, baseOpts)).toEqual({
      claimed: 0,
      outcomes: []
    });

    const nonArray = makeSupabase({ claim: { data: null, error: null } });
    expect(await processDueScheduledSms(nonArray.supabase, baseOpts)).toEqual({
      claimed: 0,
      outcomes: []
    });
  });

  it("dispatches a due row: reserves, sends, logs, marks sent", async () => {
    const { supabase, rpc, insert, update, updateEq } = makeSupabase({});
    const fetchFn = okFetch("msg_42");

    const result = await processDueScheduledSms(supabase, { ...baseOpts, fetchFn });

    expect(result).toEqual({ claimed: 1, outcomes: [{ id: "sched-1", status: "sent" }] });
    expect(rpc).toHaveBeenCalledWith("claim_due_scheduled_sms", {
      p_limit: SCHEDULED_SMS_BATCH_SIZE
    });
    expect(rpc).toHaveBeenCalledWith("try_reserve_sms_outbound_slot", {
      p_business_id: "biz-1"
    });
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.telnyx.com/v2/messages");
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toEqual({
      to: "+15551234567",
      text: ROW.body,
      messaging_profile_id: "prof_biz",
      from: "+15550001111"
    });
    expect((init as { headers: Record<string, string> }).headers["Idempotency-Key"]).toBe(
      "scheduled_sms:sched-1"
    );
    expect(insert).toHaveBeenCalledWith({
      business_id: "biz-1",
      to_e164: "+15551234567",
      from_e164: "+15550001111",
      body: ROW.body,
      source: "owner_scheduled",
      run_id: null,
      flow_id: null,
      telnyx_message_id: "msg_42",
      channel: "sms",
      scheduled_sms_id: "sched-1"
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "sent", telnyx_message_id: "msg_42", error: null })
    );
    expect(updateEq).toHaveBeenCalledWith("id", "sched-1");
  });

  it("short-circuits a reclaimed row whose send already reached Telnyx", async () => {
    const { supabase, rpc, update } = makeSupabase({
      priorLog: { data: { telnyx_message_id: "msg_prior" }, error: null }
    });
    const fetchFn = okFetch();

    const result = await processDueScheduledSms(supabase, { ...baseOpts, fetchFn });
    expect(result.outcomes[0]).toEqual({ id: "sched-1", status: "sent" });
    // No second metered slot, no second Telnyx call — just re-mark sent.
    expect(rpc).not.toHaveBeenCalledWith("try_reserve_sms_outbound_slot", expect.anything());
    expect(fetchFn).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "sent", telnyx_message_id: "msg_prior" })
    );

    // Prior log without a message id still short-circuits (null id re-marked).
    const noMid = makeSupabase({ priorLog: { data: {}, error: null } });
    const result2 = await processDueScheduledSms(noMid.supabase, { ...baseOpts, fetchFn: okFetch() });
    expect(result2.outcomes[0]).toEqual({ id: "sched-1", status: "sent" });
    expect(noMid.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "sent", telnyx_message_id: null })
    );
  });

  it("honors a custom batch size and falls back to env messaging config", async () => {
    const { supabase, rpc } = makeSupabase({
      telnyxSettings: { data: null, error: null }
    });
    const fetchFn = okFetch();

    const result = await processDueScheduledSms(supabase, {
      ...baseOpts,
      batchSize: 5,
      fetchFn
    });
    expect(result.outcomes[0]).toEqual({ id: "sched-1", status: "sent" });
    expect(rpc).toHaveBeenCalledWith("claim_due_scheduled_sms", { p_limit: 5 });
    const body = JSON.parse(
      ((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1] as { body: string }).body
    );
    expect(body.messaging_profile_id).toBe("prof_env");
    expect(body.from).toBe("+15559990000");
  });

  it("sends RCS-first when the tenant has an approved agent (enterprise-only)", async () => {
    const { supabase } = makeSupabase({
      business: { data: { tier: "enterprise" }, error: null },
      channelSettings: { data: { rcs_agent_id: "agent_1", rcs_enabled: true }, error: null }
    });
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: "rcs_9" } }))
    }) as unknown as typeof fetch;

    const result = await processDueScheduledSms(supabase, { ...baseOpts, fetchFn });
    expect(result.outcomes[0]).toEqual({ id: "sched-1", status: "sent" });
    const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.telnyx.com/v2/messages/rcs");
  });

  it("omits from and marks sent without a message id on unparseable Telnyx body", async () => {
    const { supabase, insert, update } = makeSupabase({
      telnyxSettings: {
        data: { telnyx_messaging_profile_id: "prof_biz", telnyx_sms_from_e164: "" },
        error: null
      }
    });
    // Force the env fallback from-number to empty too so `from` is omitted.
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue("not json")
    }) as unknown as typeof fetch;

    const result = await processDueScheduledSms(supabase, {
      ...baseOpts,
      defaultFromE164: "",
      fetchFn
    });
    expect(result.outcomes[0]).toEqual({ id: "sched-1", status: "sent" });
    const body = JSON.parse(
      ((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1] as { body: string }).body
    );
    expect(body.from).toBeUndefined();
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ from_e164: null, telnyx_message_id: null }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ telnyx_message_id: null }));
  });

  it("marks sent with a null message id when the Telnyx body has no id", async () => {
    const { supabase, update } = makeSupabase({});
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: {} }))
    }) as unknown as typeof fetch;

    const result = await processDueScheduledSms(supabase, { ...baseOpts, fetchFn });
    expect(result.outcomes[0]).toEqual({ id: "sched-1", status: "sent" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ telnyx_message_id: null }));
  });

  it("tolerates a failed outbound-log insert (send already delivered)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { supabase } = makeSupabase({
      insertResult: { data: null, error: { message: "log down" } }
    });
    const result = await processDueScheduledSms(supabase, { ...baseOpts, fetchFn: okFetch() });
    expect(result.outcomes[0]).toEqual({ id: "sched-1", status: "sent" });
    expect(errSpy).toHaveBeenCalledWith("scheduled_sms outbound log failed", "sched-1", "log down");
    errSpy.mockRestore();
  });

  it("fails the row when the business lookup errors or tier is not allowed", async () => {
    const lookupFail = makeSupabase({ business: { data: null, error: { message: "boom" } } });
    expect(
      (await processDueScheduledSms(lookupFail.supabase, baseOpts)).outcomes[0]
    ).toEqual({ id: "sched-1", status: "failed", detail: "business_lookup:boom" });
    expect(lookupFail.update).toHaveBeenCalledWith({
      status: "failed",
      error: "business_lookup:boom"
    });

    const starter = makeSupabase({ business: { data: { tier: "starter" }, error: null } });
    expect((await processDueScheduledSms(starter.supabase, baseOpts)).outcomes[0]).toEqual({
      id: "sched-1",
      status: "failed",
      detail: "tier_not_allowed"
    });

    const ghost = makeSupabase({ business: { data: null, error: null } });
    expect((await processDueScheduledSms(ghost.supabase, baseOpts)).outcomes[0]).toEqual({
      id: "sched-1",
      status: "failed",
      detail: "tier_not_allowed"
    });
  });

  it("cancels the row for an opted-out recipient and fails on opt-out lookup errors", async () => {
    const optedOut = makeSupabase({
      rpc: (fn) =>
        fn === "sms_is_opted_out" ? { data: true, error: null } : { data: null, error: null }
    });
    expect((await processDueScheduledSms(optedOut.supabase, baseOpts)).outcomes[0]).toEqual({
      id: "sched-1",
      status: "canceled",
      detail: "recipient_opted_out"
    });
    expect(optedOut.update).toHaveBeenCalledWith({
      status: "canceled",
      error: "recipient_opted_out"
    });

    const lookupFail = makeSupabase({
      rpc: (fn) =>
        fn === "sms_is_opted_out"
          ? { data: null, error: { message: "rpc down" } }
          : { data: null, error: null }
    });
    expect((await processDueScheduledSms(lookupFail.supabase, baseOpts)).outcomes[0]).toEqual({
      id: "sched-1",
      status: "failed",
      detail: "opt_out_lookup:rpc down"
    });
  });

  it("fails the row when messaging is not configured", async () => {
    const noKey = makeSupabase({});
    expect(
      (await processDueScheduledSms(noKey.supabase, { ...baseOpts, telnyxApiKey: "" }))
        .outcomes[0]
    ).toEqual({ id: "sched-1", status: "failed", detail: "no_messaging" });

    const noProfile = makeSupabase({ telnyxSettings: { data: null, error: null } });
    expect(
      (
        await processDueScheduledSms(noProfile.supabase, {
          ...baseOpts,
          defaultMessagingProfileId: ""
        })
      ).outcomes[0]
    ).toEqual({ id: "sched-1", status: "failed", detail: "no_messaging" });
  });

  it("fails on reserve errors and on the SMS cap (alerting once when configured)", async () => {
    const reserveErr = makeSupabase({
      rpc: (fn) => {
        if (fn === "sms_is_opted_out") return { data: false, error: null };
        if (fn === "try_reserve_sms_outbound_slot") {
          return { data: null, error: { message: "rpc down" } };
        }
        return { data: null, error: null };
      }
    });
    expect((await processDueScheduledSms(reserveErr.supabase, baseOpts)).outcomes[0]).toEqual({
      id: "sched-1",
      status: "failed",
      detail: "sms_reserve:rpc down"
    });

    // Cap hit with notify config: the once-per-period alert posts through the
    // notifications function.
    const alertCalls: Array<[string, Record<string, unknown>]> = [];
    const capped = makeSupabase({
      rpc: (fn, args) => {
        if (fn === "sms_is_opted_out") return { data: false, error: null };
        if (fn === "try_reserve_sms_outbound_slot") {
          return { data: { ok: false, reason: "monthly_sms_limit" }, error: null };
        }
        if (fn === "mark_usage_cap_alert") {
          alertCalls.push([fn, args]);
          return { data: true, error: null };
        }
        return { data: null, error: null };
      }
    });
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
    expect(
      (
        await processDueScheduledSms(capped.supabase, {
          ...baseOpts,
          notifyUrl: "https://x.supabase.co/functions/v1/notifications",
          notifyBearer: "cron-secret",
          fetchFn
        })
      ).outcomes[0]
    ).toEqual({ id: "sched-1", status: "failed", detail: "sms_cap:monthly_sms_limit" });
    expect(alertCalls).toHaveLength(1);
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "https://x.supabase.co/functions/v1/notifications"
    );

    // Cap hit WITHOUT notify config: no alert attempted.
    const cappedSilent = makeSupabase({
      rpc: (fn) => {
        if (fn === "sms_is_opted_out") return { data: false, error: null };
        if (fn === "try_reserve_sms_outbound_slot") {
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }
    });
    expect(
      (await processDueScheduledSms(cappedSilent.supabase, baseOpts)).outcomes[0]
    ).toEqual({ id: "sched-1", status: "failed", detail: "sms_cap:monthly_sms_limit" });

    // Cap hit with notify config but no injected fetch: the alert posts via
    // the global fetch.
    const cappedGlobal = makeSupabase({
      rpc: (fn) => {
        if (fn === "sms_is_opted_out") return { data: false, error: null };
        if (fn === "try_reserve_sms_outbound_slot") {
          return { data: { ok: false, reason: "monthly_sms_limit" }, error: null };
        }
        if (fn === "mark_usage_cap_alert") return { data: true, error: null };
        return { data: null, error: null };
      }
    });
    const globalFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", globalFetch);
    try {
      expect(
        (
          await processDueScheduledSms(cappedGlobal.supabase, {
            ...baseOpts,
            notifyUrl: "https://x.supabase.co/functions/v1/notifications",
            notifyBearer: "cron-secret"
          })
        ).outcomes[0]
      ).toEqual({ id: "sched-1", status: "failed", detail: "sms_cap:monthly_sms_limit" });
      expect(globalFetch).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }

    // Non-cap refusal reason: failed but no alert.
    const throttled = makeSupabase({
      rpc: (fn) => {
        if (fn === "sms_is_opted_out") return { data: false, error: null };
        if (fn === "try_reserve_sms_outbound_slot") {
          return { data: { ok: false, reason: "throttled" }, error: null };
        }
        return { data: null, error: null };
      }
    });
    expect(
      (
        await processDueScheduledSms(throttled.supabase, {
          ...baseOpts,
          notifyUrl: "https://x.supabase.co/functions/v1/notifications",
          notifyBearer: "cron-secret",
          fetchFn: okFetch()
        })
      ).outcomes[0]
    ).toEqual({ id: "sched-1", status: "failed", detail: "sms_cap:throttled" });
  });

  it("releases the metered slot (refunding bonus) when Telnyx rejects the send", async () => {
    const releaseCalls: Array<Record<string, unknown>> = [];
    const { supabase } = makeSupabase({
      rpc: (fn, args) => {
        if (fn === "sms_is_opted_out") return { data: false, error: null };
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
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: vi.fn().mockResolvedValue("nope")
    }) as unknown as typeof fetch;

    expect(
      (await processDueScheduledSms(supabase, { ...baseOpts, fetchFn })).outcomes[0]
    ).toEqual({ id: "sched-1", status: "failed", detail: "telnyx_422" });
    expect(releaseCalls).toEqual([{ p_business_id: "biz-1", p_refund_bonus: true }]);
  });

  it("releases the slot when fetch itself throws and logs release failures", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const releaseCalls: Array<Record<string, unknown>> = [];
    const { supabase } = makeSupabase({
      rpc: (fn, args) => {
        if (fn === "sms_is_opted_out") return { data: false, error: null };
        if (fn === "try_reserve_sms_outbound_slot") {
          return { data: { ok: true, source: "included" }, error: null };
        }
        if (fn === "release_sms_outbound_slot") {
          releaseCalls.push(args);
          return { data: null, error: { message: "release down" } };
        }
        return { data: null, error: null };
      }
    });
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    expect(
      (await processDueScheduledSms(supabase, { ...baseOpts, fetchFn })).outcomes[0]
    ).toEqual({ id: "sched-1", status: "failed", detail: "network down" });
    expect(releaseCalls).toEqual([{ p_business_id: "biz-1", p_refund_bonus: false }]);
    expect(errSpy).toHaveBeenCalledWith("release_sms_outbound_slot", "sched-1", "release down");
    errSpy.mockRestore();
  });

  it("stringifies non-Error send throws", async () => {
    const { supabase } = makeSupabase({});
    const fetchFn = vi.fn().mockRejectedValue("socket reset") as unknown as typeof fetch;
    expect(
      (await processDueScheduledSms(supabase, { ...baseOpts, fetchFn })).outcomes[0]
    ).toEqual({ id: "sched-1", status: "failed", detail: "socket reset" });
  });

  it("uses the global fetch when no fetchFn is injected", async () => {
    const { supabase } = makeSupabase({});
    const globalFetch = okFetch("msg_global");
    vi.stubGlobal("fetch", globalFetch);
    try {
      const result = await processDueScheduledSms(supabase, baseOpts);
      expect(result.outcomes[0]).toEqual({ id: "sched-1", status: "sent" });
      expect(globalFetch).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("catches unexpected per-row throws (incl. non-Error) without wedging the batch", async () => {
    const rows = [ROW, { ...ROW, id: "sched-2" }];
    const updateEq = vi.fn().mockResolvedValue({ data: null, error: null });
    let call = 0;
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "scheduled_sms") {
          return { update: vi.fn().mockReturnValue({ eq: updateEq }) };
        }
        call += 1;
        if (call === 1) throw new Error("boom");
        throw "string boom";
      }),
      rpc: vi.fn(async (fn: string) =>
        fn === "claim_due_scheduled_sms" ? { data: rows, error: null } : { data: null, error: null }
      )
    } as unknown as ScheduledSmsSupabase;

    const result = await processDueScheduledSms(supabase, baseOpts);
    expect(result.outcomes).toEqual([
      { id: "sched-1", status: "failed", detail: "boom" },
      { id: "sched-2", status: "failed", detail: "string boom" }
    ]);
  });

  it("logs but survives mark failures (error result and thrown)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const markErr = makeSupabase({
      updateResult: { data: null, error: { message: "mark down" } }
    });
    expect(
      (await processDueScheduledSms(markErr.supabase, { ...baseOpts, fetchFn: okFetch() }))
        .outcomes[0]
    ).toEqual({ id: "sched-1", status: "sent" });
    expect(errSpy).toHaveBeenCalledWith("scheduled_sms mark failed", "sched-1", "mark down");

    const markThrow = makeSupabase({ updateThrows: new Error("update exploded") });
    expect(
      (await processDueScheduledSms(markThrow.supabase, { ...baseOpts, fetchFn: okFetch() }))
        .outcomes[0]
    ).toEqual({ id: "sched-1", status: "sent" });
    expect(errSpy).toHaveBeenCalledWith("scheduled_sms mark threw", "sched-1", "update exploded");

    const markThrowString = makeSupabase({ updateThrows: "mark string boom" });
    expect(
      (await processDueScheduledSms(markThrowString.supabase, { ...baseOpts, fetchFn: okFetch() }))
        .outcomes[0]
    ).toEqual({ id: "sched-1", status: "sent" });
    expect(errSpy).toHaveBeenCalledWith("scheduled_sms mark threw", "sched-1", "mark string boom");

    errSpy.mockRestore();
  });
});
