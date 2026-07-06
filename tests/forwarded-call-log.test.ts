import { describe, expect, it, vi } from "vitest";
import {
  recordForwardedCall,
  type ForwardedCallLogSupabase
} from "../supabase/functions/_shared/forwarded_call_log";

function makeSupabase(result: { data: unknown[] | null; error: { message: string } | null }) {
  const select = vi.fn().mockResolvedValue(result);
  const upsert = vi.fn().mockReturnValue({ select });
  const from = vi.fn(() => ({ upsert }));
  return { supabase: { from } as unknown as ForwardedCallLogSupabase, from, upsert, select };
}

const okResult = { data: [{ call_control_id: "v3:abc" }], error: null };

const base = {
  businessId: "biz-1",
  callControlId: "v3:abc",
  callerE164: "+18332253837",
  forwardedToE164: "+16025245719",
  nowIso: "2026-07-05T20:21:41.000Z"
};

describe("recordForwardedCall", () => {
  it("records an answered forwarded call as a completed row with ended_at (overwrite upsert)", async () => {
    const { supabase, from, upsert } = makeSupabase(okResult);
    const res = await recordForwardedCall(supabase, { ...base, outcome: "answered" });
    expect(res).toEqual({ status: "recorded" });
    expect(from).toHaveBeenCalledWith("voice_call_transcripts");
    const [row, opts] = upsert.mock.calls[0];
    // answered must OVERWRITE so it supersedes an earlier missed row.
    expect(opts).toEqual({ onConflict: "call_control_id", ignoreDuplicates: false });
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

  it("records a missed forwarded call insert-only (never downgrades answered)", async () => {
    const { supabase, upsert } = makeSupabase(okResult);
    const res = await recordForwardedCall(supabase, { ...base, outcome: "missed" });
    expect(res).toEqual({ status: "recorded" });
    const [row, opts] = upsert.mock.calls[0];
    expect(opts).toEqual({ onConflict: "call_control_id", ignoreDuplicates: true });
    expect(row).toMatchObject({ status: "missed", ended_at: null });
  });

  it("returns superseded when the missed insert is blocked by an existing row", async () => {
    const { supabase } = makeSupabase({ data: [], error: null });
    const res = await recordForwardedCall(supabase, { ...base, outcome: "missed" });
    expect(res).toEqual({ status: "superseded" });
  });

  it("treats a null data payload on a missed insert as superseded", async () => {
    const { supabase } = makeSupabase({ data: null, error: null });
    const res = await recordForwardedCall(supabase, { ...base, outcome: "missed" });
    expect(res).toEqual({ status: "superseded" });
  });

  it("never reports superseded for an answered overwrite", async () => {
    const { supabase } = makeSupabase({ data: [], error: null });
    const res = await recordForwardedCall(supabase, { ...base, outcome: "answered" });
    expect(res).toEqual({ status: "recorded" });
  });

  it("prefers an explicit startedAtIso when provided", async () => {
    const { supabase, upsert } = makeSupabase(okResult);
    await recordForwardedCall(supabase, {
      ...base,
      outcome: "answered",
      startedAtIso: "2026-07-05T20:20:00.000Z"
    });
    const [row] = upsert.mock.calls[0];
    expect(row.started_at).toBe("2026-07-05T20:20:00.000Z");
  });

  it("defaults nowIso to the current time when omitted", async () => {
    const { supabase, upsert } = makeSupabase(okResult);
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
    const { supabase, upsert } = makeSupabase(okResult);
    await recordForwardedCall(supabase, { ...base, outcome: "missed" });
    const [row] = upsert.mock.calls[0];
    expect(row.started_at).toBe("2026-07-05T20:21:41.000Z");
  });

  it("stores NULL for a blank caller or forwarded-to number", async () => {
    const { supabase, upsert } = makeSupabase(okResult);
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
    const { supabase, from } = makeSupabase(okResult);
    const res = await recordForwardedCall(supabase, {
      ...base,
      callControlId: "",
      outcome: "answered"
    });
    expect(res).toEqual({ status: "skipped", reason: "no_call" });
    expect(from).not.toHaveBeenCalled();
  });

  it("skips when businessId is missing", async () => {
    const { supabase, from } = makeSupabase(okResult);
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
