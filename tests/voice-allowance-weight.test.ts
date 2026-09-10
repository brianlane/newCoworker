import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({
    from: vi.fn(),
    rpc: vi.fn(async () => ({ data: { ok: true }, error: null }))
  }))
}));

import { settlementMeteringFromHangupPayload } from "../supabase/functions/_shared/voice_settlement_lrn";
import { applyVoiceSettlementLrnUpdates } from "@/lib/db/voice-settlement-lrn";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

describe("settlementMeteringFromHangupPayload", () => {
  it("returns 1x and no LRN for a typical hangup (from/to are dialed, not LRN)", () => {
    expect(
      settlementMeteringFromHangupPayload({
        call_control_id: "cc-1",
        from: "+16028384497",
        to: "+19289512316",
        call_duration: 33
      })
    ).toEqual({ terminatingLrn: null, zoneWeight: 1, callLegId: null });
  });

  it("stamps the raw Zone 6 / N11 multiplier so SQL can duration-gate", () => {
    expect(
      settlementMeteringFromHangupPayload({
        terminating_lrn: "1308286",
        call_leg_id: "leg-z6"
      })
    ).toEqual({
      terminatingLrn: "1308286",
      zoneWeight: 36.2,
      callLegId: "leg-z6"
    });
    expect(
      settlementMeteringFromHangupPayload({
        terminating_lrn: "4163110000"
      }).zoneWeight
    ).toBe(150);
  });

  it("weights Payson Zone 5 when Terminating LRN is actually on the payload", () => {
    expect(
      settlementMeteringFromHangupPayload({
        terminating_lrn: "9283630020",
        call_leg_id: "leg-payson",
        to: "+19289512316"
      })
    ).toEqual({
      terminatingLrn: "9283630020",
      zoneWeight: 14,
      callLegId: "leg-payson"
    });
  });

  it("ignores blank call_leg_id and empty payload", () => {
    expect(settlementMeteringFromHangupPayload(null)).toEqual({
      terminatingLrn: null,
      zoneWeight: 1,
      callLegId: null
    });
    expect(settlementMeteringFromHangupPayload({ call_leg_id: "  " })).toEqual({
      terminatingLrn: null,
      zoneWeight: 1,
      callLegId: null
    });
    expect(settlementMeteringFromHangupPayload({ call_leg_id: 123 as unknown as string })).toEqual({
      terminatingLrn: null,
      zoneWeight: 1,
      callLegId: null
    });
  });
});

describe("applyVoiceSettlementLrnUpdates", () => {
  it("no-ops an empty list without touching the database", async () => {
    const result = await applyVoiceSettlementLrnUpdates([]);
    expect(result).toEqual({ applied: 0, skipped: 0 });
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("builds a service client when none is injected", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValueOnce({
      from: vi.fn(),
      rpc: vi.fn(async () => ({ data: { ok: true }, error: null }))
    } as never);
    const result = await applyVoiceSettlementLrnUpdates([
      {
        callControlId: "cc-default",
        callLegId: null,
        terminatingLrn: "9283630020",
        zoneWeight: 14
      }
    ]);
    expect(result.applied).toBe(1);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });

  it("applies by call_control_id", async () => {
    const rpc = vi.fn(async () => ({ data: { ok: true }, error: null }));
    const client = {
      from: vi.fn(),
      rpc
    };
    const result = await applyVoiceSettlementLrnUpdates(
      [
        {
          callControlId: "cc-1",
          callLegId: null,
          terminatingLrn: "9283630020",
          zoneWeight: 14
        }
      ],
      client
    );
    expect(result).toEqual({ applied: 1, skipped: 0 });
    expect(rpc).toHaveBeenCalledWith("voice_apply_settlement_lrn", {
      p_call_control_id: "cc-1",
      p_terminating_lrn: "9283630020",
      p_zone_weight: 14
    });
  });

  it("floors injected weights at 1 and passes raw 150, store-ceiling 200", async () => {
    const rpc = vi.fn(async () => ({ data: { ok: true }, error: null }));
    const client = { from: vi.fn(), rpc };
    await applyVoiceSettlementLrnUpdates(
      [
        {
          callControlId: "cc-hi",
          callLegId: null,
          terminatingLrn: "1",
          zoneWeight: 150
        },
        {
          callControlId: "cc-lo",
          callLegId: null,
          terminatingLrn: "1",
          zoneWeight: 0
        },
        {
          callControlId: "cc-absurd",
          callLegId: null,
          terminatingLrn: "1",
          zoneWeight: 9999
        }
      ],
      client
    );
    expect(rpc).toHaveBeenNthCalledWith(1, "voice_apply_settlement_lrn", {
      p_call_control_id: "cc-hi",
      p_terminating_lrn: "1",
      p_zone_weight: 150
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "voice_apply_settlement_lrn", {
      p_call_control_id: "cc-lo",
      p_terminating_lrn: "1",
      p_zone_weight: 1
    });
    expect(rpc).toHaveBeenNthCalledWith(3, "voice_apply_settlement_lrn", {
      p_call_control_id: "cc-absurd",
      p_terminating_lrn: "1",
      p_zone_weight: 200
    });
  });

  it("looks up call_control_id from call_leg_id", async () => {
    const maybeSingle = vi.fn(async () => ({
      data: { call_control_id: "cc-from-leg" },
      error: null
    }));
    const client = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ maybeSingle }))
        }))
      })),
      rpc: vi.fn(async () => ({ data: { ok: true }, error: null }))
    };
    const result = await applyVoiceSettlementLrnUpdates(
      [
        {
          callControlId: null,
          callLegId: "leg-1",
          terminatingLrn: "5044010000",
          zoneWeight: 2
        }
      ],
      client
    );
    expect(result).toEqual({ applied: 1, skipped: 0 });
    expect(client.rpc).toHaveBeenCalledWith(
      "voice_apply_settlement_lrn",
      expect.objectContaining({ p_call_control_id: "cc-from-leg" })
    );
  });

  it("skips when the leg lookup misses, the ids are both empty, or rpc fails", async () => {
    const maybeSingle = vi.fn(async () => ({ data: null, error: { message: "nope" } }));
    const client = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ maybeSingle }))
        }))
      })),
      rpc: vi.fn(async () => ({ data: null, error: { message: "rpc failed" } }))
    };
    const result = await applyVoiceSettlementLrnUpdates(
      [
        { callControlId: null, callLegId: "missing", terminatingLrn: "1", zoneWeight: 1 },
        { callControlId: null, callLegId: null, terminatingLrn: "1", zoneWeight: 1 },
        { callControlId: "cc-bad", callLegId: null, terminatingLrn: "1", zoneWeight: 1 }
      ],
      client
    );
    expect(result).toEqual({ applied: 0, skipped: 3 });
  });

  it("skips a leg lookup that returns no call_control_id", async () => {
    const maybeSingle = vi.fn(async () => ({ data: { call_control_id: "" }, error: null }));
    const client = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ maybeSingle }))
        }))
      })),
      rpc: vi.fn()
    };
    const result = await applyVoiceSettlementLrnUpdates(
      [{ callControlId: null, callLegId: "leg-empty", terminatingLrn: "1", zoneWeight: 1 }],
      client
    );
    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
