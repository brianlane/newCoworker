import { describe, expect, it, vi } from "vitest";
import {
  recordForwardedCall,
  type ForwardedCallLogSupabase
} from "../supabase/functions/_shared/forwarded_call_log";

function makeSupabase(upsertResult: { data: unknown; error: { message: string } | null }) {
  const upsert = vi.fn().mockResolvedValue(upsertResult);
  const from = vi.fn(() => ({ upsert }));
  return { supabase: { from } as unknown as ForwardedCallLogSupabase, from, upsert };
}

const base = {
  businessId: "biz-1",
  callControlId: "v3:abc",
  callerE164: "+18332253837",
  forwardedToE164: "+16025245719",
  nowIso: "2026-07-05T20:21:41.000Z"
};

describe("recordForwardedCall", () => {
  it("records an answered forwarded call as a completed row with ended_at", async () => {
    const { supabase, from, upsert } = makeSupabase({ data: null, error: null });
    const res = await recordForwardedCall(supabase, { ...base, outcome: "answered" });
    expect(res).toEqual({ status: "recorded" });
    expect(from).toHaveBeenCalledWith("voice_call_transcripts");
    const [row, opts] = upsert.mock.calls[0];
    expect(opts).toEqual({ onConflict: "call_control_id" });
    expect(row).toMatchObject({
      business_id: "biz-1",
      call_control_id: "v3:abc",
      call_kind: "forwarded",
      direction: "inbound",
      model: "forwarded",
      caller_e164: "+18332253837",
      forwarded_to_e164: "+16025245719",
      status: "completed",
      ended_at: "2026-07-05T20:21:41.000Z",
      summarized_at: "2026-07-05T20:21:41.000Z"
    });
  });

  it("records a missed forwarded call as a missed row with no ended_at", async () => {
    const { supabase, upsert } = makeSupabase({ data: null, error: null });
    const res = await recordForwardedCall(supabase, { ...base, outcome: "missed" });
    expect(res).toEqual({ status: "recorded" });
    const [row] = upsert.mock.calls[0];
    expect(row).toMatchObject({ status: "missed", ended_at: null });
  });

  it("prefers an explicit startedAtIso when provided", async () => {
    const { supabase, upsert } = makeSupabase({ data: null, error: null });
    await recordForwardedCall(supabase, {
      ...base,
      outcome: "answered",
      startedAtIso: "2026-07-05T20:20:00.000Z"
    });
    const [row] = upsert.mock.calls[0];
    expect(row.started_at).toBe("2026-07-05T20:20:00.000Z");
  });

  it("defaults nowIso to the current time when omitted", async () => {
    const { supabase, upsert } = makeSupabase({ data: null, error: null });
    const before = Date.now();
    await recordForwardedCall(supabase, {
      businessId: base.businessId,
      callControlId: base.callControlId,
      outcome: "answered"
    });
    const [row] = upsert.mock.calls[0];
    const ended = Date.parse(row.ended_at as string);
    expect(ended).toBeGreaterThanOrEqual(before);
    expect(ended).toBeLessThanOrEqual(Date.now());
  });

  it("falls back to now for started_at when none given", async () => {
    const { supabase, upsert } = makeSupabase({ data: null, error: null });
    await recordForwardedCall(supabase, { ...base, outcome: "missed" });
    const [row] = upsert.mock.calls[0];
    expect(row.started_at).toBe("2026-07-05T20:21:41.000Z");
  });

  it("stores NULL for a blank caller or forwarded-to number", async () => {
    const { supabase, upsert } = makeSupabase({ data: null, error: null });
    await recordForwardedCall(supabase, {
      businessId: "biz-1",
      callControlId: "v3:abc",
      outcome: "missed",
      callerE164: "  ",
      forwardedToE164: null,
      nowIso: base.nowIso
    });
    const [row] = upsert.mock.calls[0];
    expect(row.caller_e164).toBeNull();
    expect(row.forwarded_to_e164).toBeNull();
  });

  it("skips when call_control_id is missing", async () => {
    const { supabase, from } = makeSupabase({ data: null, error: null });
    const res = await recordForwardedCall(supabase, {
      ...base,
      callControlId: "",
      outcome: "answered"
    });
    expect(res).toEqual({ status: "skipped", reason: "no_call" });
    expect(from).not.toHaveBeenCalled();
  });

  it("skips when businessId is missing", async () => {
    const { supabase, from } = makeSupabase({ data: null, error: null });
    const res = await recordForwardedCall(supabase, {
      ...base,
      businessId: "",
      outcome: "answered"
    });
    expect(res).toEqual({ status: "skipped", reason: "no_business" });
    expect(from).not.toHaveBeenCalled();
  });

  it("returns failed (never throws) when the upsert errors", async () => {
    const { supabase } = makeSupabase({ data: null, error: { message: "boom" } });
    const res = await recordForwardedCall(supabase, { ...base, outcome: "answered" });
    expect(res).toEqual({ status: "failed", reason: "boom" });
  });

  it("returns failed (never throws) when the client throws", async () => {
    const from = vi.fn(() => {
      throw new Error("kaboom");
    });
    const supabase = { from } as unknown as ForwardedCallLogSupabase;
    const res = await recordForwardedCall(supabase, { ...base, outcome: "answered" });
    expect(res).toEqual({ status: "failed", reason: "kaboom" });
  });

  it("stringifies non-Error throwables", async () => {
    const from = vi.fn(() => {
      throw "string boom";
    });
    const supabase = { from } as unknown as ForwardedCallLogSupabase;
    const res = await recordForwardedCall(supabase, { ...base, outcome: "missed" });
    expect(res).toEqual({ status: "failed", reason: "string boom" });
  });
});
