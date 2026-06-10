import { describe, it, expect, vi } from "vitest";
import { systemLog } from "../supabase/functions/_shared/system_log";

function mockSupabase(insertResult: { error: { message: string } | null }) {
  const insert = vi.fn().mockResolvedValue(insertResult);
  return { supabase: { from: vi.fn(() => ({ insert })) }, insert };
}

describe("systemLog (Edge shared)", () => {
  it("inserts a normalized system_logs row", async () => {
    const { supabase, insert } = mockSupabase({ error: null });
    await systemLog(supabase, {
      businessId: "biz-1",
      source: "aiflow",
      level: "error",
      event: "ai_flow_run_failed",
      message: "telnyx 500",
      payload: { run_id: "r1" }
    });
    expect(supabase.from).toHaveBeenCalledWith("system_logs");
    expect(insert).toHaveBeenCalledWith({
      business_id: "biz-1",
      source: "aiflow",
      level: "error",
      event: "ai_flow_run_failed",
      message: "telnyx 500",
      payload: { run_id: "r1" }
    });
  });

  it("defaults businessId to null, message to empty, payload to {}", async () => {
    const { supabase, insert } = mockSupabase({ error: null });
    await systemLog(supabase, { source: "voice", level: "info", event: "sweep_done" });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ business_id: null, message: "", payload: {} })
    );
  });

  it("truncates oversized messages to 4000 chars", async () => {
    const { supabase, insert } = mockSupabase({ error: null });
    await systemLog(supabase, {
      source: "voice",
      level: "warn",
      event: "x",
      message: "b".repeat(9000)
    });
    const row = insert.mock.calls[0][0] as { message: string };
    expect(row.message).toHaveLength(4000);
  });

  it("swallows insert errors (logs to console)", async () => {
    const { supabase } = mockSupabase({ error: { message: "db down" } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      systemLog(supabase, { source: "aiflow", level: "error", event: "x" })
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("swallows thrown exceptions (logging must never break the caller)", async () => {
    const supabase = {
      from: vi.fn(() => ({
        insert: vi.fn().mockRejectedValue(new Error("network"))
      }))
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      systemLog(supabase, { source: "aiflow", level: "error", event: "x" })
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
