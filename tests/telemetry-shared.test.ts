import { describe, it, expect, vi } from "vitest";
import { telemetryRecord } from "../supabase/functions/_shared/telemetry";

describe("telemetryRecord (Edge shared)", () => {
  it("invokes telemetry_record RPC", async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ error: null }) };
    await telemetryRecord(supabase, "test_event", { k: 1 });
    expect(supabase.rpc).toHaveBeenCalledWith("telemetry_record", {
      p_event_type: "test_event",
      p_payload: { k: 1 }
    });
  });

  it("logs when RPC returns error", async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ error: { message: "db" } }) };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await telemetryRecord(supabase, "bad", {});
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("defaults payload to empty object when omitted", async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ error: null }) };
    await telemetryRecord(supabase, "bare");
    expect(supabase.rpc).toHaveBeenCalledWith("telemetry_record", {
      p_event_type: "bare",
      p_payload: {}
    });
  });
});
