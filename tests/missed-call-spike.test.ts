import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  MISSED_CALL_SPIKE_THRESHOLD,
  MISSED_CALL_SPIKE_TIERS,
  maybeSendMissedCallSpikeAlert,
  type MissedCallSpikeSupabase
} from "../supabase/functions/_shared/missed_call_spike";

const NOW = new Date("2026-07-04T18:00:00Z");

type StubOpts = {
  tier?: string | null;
  tierError?: { message: string } | null;
  count?: number | null;
  countError?: { message: string } | null;
  /** mark_usage_cap_alert result (true = first claim). */
  markData?: unknown;
  markError?: { message: string } | null;
};

function stubSupabase(opts: StubOpts = {}) {
  const rpc = vi.fn(async (fn: string) => {
    if (fn === "mark_usage_cap_alert") {
      return { data: opts.markData ?? true, error: opts.markError ?? null };
    }
    return { data: null, error: null }; // unmark_usage_cap_alert
  });
  const countThenable = {
    then(onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) {
      return Promise.resolve({
        count: opts.count === undefined ? 0 : opts.count,
        error: opts.countError ?? null
      }).then(onF, onR);
    }
  };
  const from = vi.fn((table: string) => {
    if (table === "businesses") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({
              data: opts.tier === null ? null : { tier: opts.tier ?? "standard" },
              error: opts.tierError ?? null
            }))
          }))
        }))
      };
    }
    // system_logs count query
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            gte: vi.fn(() => countThenable)
          }))
        }))
      }))
    };
  });
  return { supabase: { rpc, from } as unknown as MissedCallSpikeSupabase, rpc, from };
}

const baseOpts = {
  businessId: "biz-1",
  notifyUrl: "https://x.supabase.co/functions/v1/notifications",
  bearer: "service-key",
  now: NOW
};

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
});

describe("maybeSendMissedCallSpikeAlert", () => {
  it("exports standard/enterprise as the entitled tiers", () => {
    expect(MISSED_CALL_SPIKE_TIERS).toEqual(["standard", "enterprise"]);
  });

  it("sends the once-per-day alert when the threshold is crossed", async () => {
    const { supabase, rpc } = stubSupabase({ count: 5 });
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

    const outcome = await maybeSendMissedCallSpikeAlert(supabase, { ...baseOpts, fetchFn });

    expect(outcome).toEqual({ status: "sent", count: 5 });
    expect(rpc).toHaveBeenCalledWith("mark_usage_cap_alert", {
      p_business_id: "biz-1",
      p_cap_kind: "missed_call_spike",
      p_period_key: "2026-07-04"
    });
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { body: string }
    ];
    expect(url).toBe(baseOpts.notifyUrl);
    const body = JSON.parse(init.body) as {
      record: { task_type: string; log_payload: Record<string, unknown> };
    };
    expect(body.record.task_type).toBe("missed_call_spike");
    expect(body.record.log_payload).toMatchObject({
      period_key: "2026-07-04",
      missed_calls_today: 5
    });
  });

  it("skips below the threshold", async () => {
    const { supabase, rpc } = stubSupabase({ count: MISSED_CALL_SPIKE_THRESHOLD - 1 });
    const outcome = await maybeSendMissedCallSpikeAlert(supabase, baseOpts);
    expect(outcome).toEqual({
      status: "skipped",
      reason: "below_threshold",
      count: MISSED_CALL_SPIKE_THRESHOLD - 1
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("honors a custom threshold", async () => {
    const { supabase } = stubSupabase({ count: 1 });
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    const outcome = await maybeSendMissedCallSpikeAlert(supabase, {
      ...baseOpts,
      threshold: 1,
      fetchFn
    });
    expect(outcome).toEqual({ status: "sent", count: 1 });
  });

  it("treats a null count as zero", async () => {
    const { supabase } = stubSupabase({ count: null });
    const outcome = await maybeSendMissedCallSpikeAlert(supabase, baseOpts);
    expect(outcome).toEqual({ status: "skipped", reason: "below_threshold", count: 0 });
  });

  it("skips starter tenants without counting", async () => {
    const { supabase, from } = stubSupabase({ tier: "starter" });
    const outcome = await maybeSendMissedCallSpikeAlert(supabase, baseOpts);
    expect(outcome).toEqual({ status: "skipped", reason: "tier" });
    expect(from).toHaveBeenCalledTimes(1); // businesses only, never system_logs
  });

  it("skips when the business row is missing", async () => {
    const { supabase } = stubSupabase({ tier: null });
    const outcome = await maybeSendMissedCallSpikeAlert(supabase, baseOpts);
    expect(outcome).toEqual({ status: "skipped", reason: "tier" });
  });

  it("skips (never throws) when the tier lookup errors", async () => {
    const { supabase } = stubSupabase({ tierError: { message: "tier down" } });
    const outcome = await maybeSendMissedCallSpikeAlert(supabase, baseOpts);
    expect(outcome).toEqual({ status: "skipped", reason: "lookup_failed" });
    expect(errSpy).toHaveBeenCalledWith("missed_call_spike tier lookup", "tier down");
  });

  it("skips (never throws) when the blocked-call count errors", async () => {
    const { supabase } = stubSupabase({ countError: { message: "count down" } });
    const outcome = await maybeSendMissedCallSpikeAlert(supabase, baseOpts);
    expect(outcome).toEqual({ status: "skipped", reason: "lookup_failed" });
    expect(errSpy).toHaveBeenCalledWith("missed_call_spike count", "count down");
  });

  it("reports already_alerted when the day's alert was previously claimed", async () => {
    const { supabase } = stubSupabase({ count: 4, markData: false });
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const outcome = await maybeSendMissedCallSpikeAlert(supabase, { ...baseOpts, fetchFn });
    expect(outcome).toEqual({ status: "skipped", reason: "already_alerted", count: 4 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports alert_failed when the notifications POST fails", async () => {
    const { supabase } = stubSupabase({ count: 4 });
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    const outcome = await maybeSendMissedCallSpikeAlert(supabase, { ...baseOpts, fetchFn });
    expect(outcome).toEqual({ status: "skipped", reason: "alert_failed", count: 4 });
  });

  it("reports alert_failed when the mark RPC errors", async () => {
    const { supabase } = stubSupabase({ count: 4, markData: null, markError: { message: "rpc down" } });
    const outcome = await maybeSendMissedCallSpikeAlert(supabase, baseOpts);
    expect(outcome).toEqual({ status: "skipped", reason: "alert_failed", count: 4 });
  });

  it("never throws on an unexpected Error", async () => {
    const from = vi.fn(() => {
      throw new Error("client exploded");
    });
    const supabase = { from, rpc: vi.fn() } as unknown as MissedCallSpikeSupabase;
    const outcome = await maybeSendMissedCallSpikeAlert(supabase, baseOpts);
    expect(outcome).toEqual({ status: "skipped", reason: "lookup_failed" });
    expect(errSpy).toHaveBeenCalledWith("missed_call_spike unexpected", "client exploded");
  });

  it("never throws on a non-Error value", async () => {
    const from = vi.fn(() => {
      throw "string failure";
    });
    const supabase = { from, rpc: vi.fn() } as unknown as MissedCallSpikeSupabase;
    const outcome = await maybeSendMissedCallSpikeAlert(supabase, baseOpts);
    expect(outcome).toEqual({ status: "skipped", reason: "lookup_failed" });
    expect(errSpy).toHaveBeenCalledWith("missed_call_spike unexpected", "string failure");
  });

  it("defaults now to the current time", async () => {
    const { supabase, rpc } = stubSupabase({ count: 5 });
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    const outcome = await maybeSendMissedCallSpikeAlert(supabase, {
      businessId: baseOpts.businessId,
      notifyUrl: baseOpts.notifyUrl,
      bearer: baseOpts.bearer,
      fetchFn
    });
    expect(outcome.status).toBe("sent");
    expect(rpc).toHaveBeenCalledWith(
      "mark_usage_cap_alert",
      expect.objectContaining({ p_period_key: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
    );
  });
});
