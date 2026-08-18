import { describe, expect, it, vi } from "vitest";
import {
  recordForwardedCall,
  type ForwardedCallLogSupabase
} from "../supabase/functions/_shared/forwarded_call_log";

type ExistingRow = {
  model?: string;
  status?: string;
  direction?: string;
  summarized_at?: string | null;
} | null;

function makeSupabase(
  result: { data: unknown[] | null; error: { message: string } | null },
  existing: { row?: ExistingRow; error?: { message: string } | null } = {}
) {
  const select = vi.fn().mockResolvedValue(result);
  const upsert = vi.fn().mockReturnValue({ select });
  const updateSelect = vi.fn().mockResolvedValue(result);
  const updateEq = vi.fn().mockReturnValue({ select: updateSelect });
  const update = vi.fn().mockReturnValue({ eq: updateEq });
  const maybeSingle = vi
    .fn()
    .mockResolvedValue({ data: existing.row ?? null, error: existing.error ?? null });
  const lookupEq = vi.fn().mockReturnValue({ maybeSingle });
  const lookupSelect = vi.fn().mockReturnValue({ eq: lookupEq });
  const from = vi.fn(() => ({ upsert, update, select: lookupSelect }));
  return {
    supabase: { from } as unknown as ForwardedCallLogSupabase,
    from,
    upsert,
    select,
    update,
    updateEq,
    lookupSelect
  };
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

/**
 * The AI transcript is not the forwarded record's to overwrite.
 *
 * THE DEFECT (found investigating Amy Laidlaw's call 5634b7f0, 2026-08-18).
 * This module was written for calls the routing layer forwards straight to a
 * human, which never engage the bridge, so it hardcodes `direction: 'inbound'`,
 * `model: 'forwarded'` and a terminal `summarized_at`. But the warm-transfer
 * path calls it for calls the AI DID handle, and the answered upsert overwrites
 * the whole row. Three things were lost on every warm-transferred AI call:
 *
 *   - an OUTBOUND AI call was relabelled incoming (the dashboard header said
 *     INCOMING on a call the platform itself had placed),
 *   - the real model id was replaced by the sentinel,
 *   - `summarized_at` was stamped, so the summary sweep skipped a call with 14
 *     real transcript turns and the owner never got a summary.
 *
 * Two rows were in that state in production when this was written.
 */
describe("recordForwardedCall against an existing AI transcript", () => {
  const aiRow = {
    model: "gemini-3.1-flash-live-preview",
    status: "completed",
    direction: "outbound",
    summarized_at: null
  };

  it("updates the forwarded facts instead of overwriting the row", async () => {
    const { supabase, upsert, update, updateEq } = makeSupabase(okResult, { row: aiRow });
    const res = await recordForwardedCall(supabase, { ...base, outcome: "answered" });
    expect(res).toEqual({ status: "recorded" });
    expect(upsert).not.toHaveBeenCalled();
    expect(updateEq).toHaveBeenCalledWith("call_control_id", "v3:abc");
    const [patch] = update.mock.calls[0];
    // No `status`: this row is already terminal. Only a still-open transcript
    // gets promoted (next test), so the patch stays as small as the new facts.
    expect(patch).toEqual({
      call_kind: "forwarded",
      forwarded_to_e164: "+16025245719",
      // The hangup is the true end of the call: it includes any stretch the AI
      // stayed on the line for, which the bridge's own teardown stamp predates.
      ended_at: "2026-07-05T20:21:41.000Z",
      updated_at: "2026-07-05T20:21:41.000Z"
    });
  });

  it("leaves direction, model, and summarized_at alone", async () => {
    // Asserted as ABSENT keys rather than as values: a patch that writes them
    // back "unchanged" would still clobber a row updated in between.
    const { supabase, update } = makeSupabase(okResult, { row: aiRow });
    await recordForwardedCall(supabase, { ...base, outcome: "answered" });
    const [patch] = update.mock.calls[0];
    expect(patch).not.toHaveProperty("direction");
    expect(patch).not.toHaveProperty("model");
    expect(patch).not.toHaveProperty("summarized_at");
    expect(patch).not.toHaveProperty("started_at");
    expect(patch).not.toHaveProperty("caller_e164");
  });

  it("promotes a still-open AI transcript to completed", async () => {
    const { supabase, update } = makeSupabase(okResult, {
      row: { ...aiRow, status: "in_progress" }
    });
    await recordForwardedCall(supabase, { ...base, outcome: "answered" });
    expect(update.mock.calls[0][0]).toMatchObject({ status: "completed" });
  });

  it("does not paper over an errored AI session", async () => {
    // The AI's session genuinely failed; a human answering afterwards does not
    // make that untrue, and the owner should still see it.
    const { supabase, update } = makeSupabase(okResult, { row: { ...aiRow, status: "errored" } });
    await recordForwardedCall(supabase, { ...base, outcome: "answered" });
    expect(update.mock.calls[0][0]).not.toHaveProperty("status");
  });

  it("still overwrites a row this module wrote itself", async () => {
    // A re-delivered webhook on a pure forwarded call must keep refreshing
    // ended_at, which is what the overwrite upsert is for.
    const { supabase, upsert, update } = makeSupabase(okResult, {
      row: { model: "forwarded", status: "missed", direction: "inbound", summarized_at: null }
    });
    await recordForwardedCall(supabase, { ...base, outcome: "answered" });
    expect(upsert).toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps missed insert-only, so an AI row is never downgraded", async () => {
    const { supabase, upsert, update } = makeSupabase({ data: [], error: null }, { row: aiRow });
    const res = await recordForwardedCall(supabase, { ...base, outcome: "missed" });
    expect(update).not.toHaveBeenCalled();
    expect(upsert.mock.calls[0][1]).toEqual({
      onConflict: "call_control_id",
      ignoreDuplicates: true
    });
    expect(res).toEqual({ status: "superseded" });
  });

  it("stores NULL when the transfer target never resolved", async () => {
    // The reach ladder can bridge without a single resolved E.164 (a named
    // agent whose row has no number). The patch must not write an empty
    // string into a column every reader treats as nullable.
    const { supabase, update } = makeSupabase(okResult, { row: aiRow });
    await recordForwardedCall(supabase, {
      ...base,
      outcome: "answered",
      forwardedToE164: "   "
    });
    expect(update.mock.calls[0][0]).toMatchObject({ forwarded_to_e164: null });
  });

  it("falls back to the upsert when the lookup itself fails", async () => {
    // Deliberate: a lookup failure means we do not know what is there. Skipping
    // the write would drop a plain forwarded call out of Call history entirely
    // and permanently, which is the common case; the overwrite risk needs BOTH
    // a failed lookup AND an AI-handled call, and only costs fields a backfill
    // can restore.
    const { supabase, upsert } = makeSupabase(okResult, { error: { message: "lookup down" } });
    const res = await recordForwardedCall(supabase, { ...base, outcome: "answered" });
    expect(res).toEqual({ status: "recorded" });
    expect(upsert).toHaveBeenCalled();
  });

  it("returns failed when the update errors, and never throws", async () => {
    const { supabase } = makeSupabase(
      { data: null, error: { message: "update boom" } },
      { row: aiRow }
    );
    const res = await recordForwardedCall(supabase, { ...base, outcome: "answered" });
    expect(res).toEqual({ status: "failed", reason: "update boom" });
  });
});
