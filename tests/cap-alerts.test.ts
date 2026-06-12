import { describe, expect, it, vi } from "vitest";
import {
  capAlertTaskType,
  sendCapAlertOnce,
  smsCapPeriodKey,
  type CapAlertSupabase
} from "../supabase/functions/_shared/cap_alerts";

function stubSupabase(
  rpcResult: { data: unknown; error: { message: string } | null },
  unmarkResult: { data: unknown; error: { message: string } | null } = { data: null, error: null }
) {
  const rpc = vi.fn(async (fn: string) =>
    fn === "unmark_usage_cap_alert" ? unmarkResult : rpcResult
  );
  return { supabase: { rpc } as unknown as CapAlertSupabase, rpc };
}

const baseOpts = {
  businessId: "biz-1",
  kind: "sms_monthly" as const,
  periodKey: "2026-06-01",
  notifyUrl: "https://x.supabase.co/functions/v1/notifications",
  bearer: "service-key"
};

describe("capAlertTaskType", () => {
  it("maps cap kinds to the notification task types", () => {
    expect(capAlertTaskType("sms_monthly")).toBe("sms_cap_reached");
    expect(capAlertTaskType("chat_spend")).toBe("chat_spend_cap_reached");
  });
});

describe("smsCapPeriodKey", () => {
  it("returns the UTC month start as YYYY-MM-DD", () => {
    expect(smsCapPeriodKey(new Date("2026-06-15T23:59:00Z"))).toBe("2026-06-01");
    expect(smsCapPeriodKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
  });

  it("defaults to now", () => {
    expect(smsCapPeriodKey()).toMatch(/^\d{4}-\d{2}-01$/);
  });
});

describe("sendCapAlertOnce", () => {
  it("marks the period and POSTs the urgent notification on first hit", async () => {
    const { supabase, rpc } = stubSupabase({ data: true, error: null });
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

    const result = await sendCapAlertOnce(supabase, { ...baseOpts, fetchFn, payload: { surface: "sms_worker" } });

    expect(result).toBe("sent");
    expect(rpc).toHaveBeenCalledWith("mark_usage_cap_alert", {
      p_business_id: "biz-1",
      p_cap_kind: "sms_monthly",
      p_period_key: "2026-06-01"
    });
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string }
    ];
    expect(url).toBe(baseOpts.notifyUrl);
    expect(init.headers.Authorization).toBe("Bearer service-key");
    const body = JSON.parse(init.body) as {
      type: string;
      table: string;
      record: { business_id: string; task_type: string; status: string; log_payload: Record<string, unknown> };
    };
    expect(body.type).toBe("INSERT");
    expect(body.table).toBe("coworker_logs");
    expect(body.record.business_id).toBe("biz-1");
    expect(body.record.task_type).toBe("sms_cap_reached");
    expect(body.record.status).toBe("urgent_alert");
    expect(body.record.log_payload).toMatchObject({ period_key: "2026-06-01", surface: "sms_worker" });
  });

  it("uses the chat task type for chat_spend and works without extra payload", async () => {
    const { supabase } = stubSupabase({ data: true, error: null });
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

    const result = await sendCapAlertOnce(supabase, { ...baseOpts, kind: "chat_spend", fetchFn });

    expect(result).toBe("sent");
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as { body: string };
    const body = JSON.parse(init.body) as { record: { task_type: string; log_payload: Record<string, unknown> } };
    expect(body.record.task_type).toBe("chat_spend_cap_reached");
    expect(body.record.log_payload).toEqual({ period_key: "2026-06-01" });
  });

  it("defaults to global fetch when no fetchFn is injected", async () => {
    const { supabase } = stubSupabase({ data: true, error: null });
    const globalFetch = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", globalFetch);
    try {
      const result = await sendCapAlertOnce(supabase, { ...baseOpts });
      expect(result).toBe("sent");
      expect(globalFetch).toHaveBeenCalledWith(baseOpts.notifyUrl, expect.anything());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips the POST when the period was already alerted", async () => {
    const { supabase } = stubSupabase({ data: false, error: null });
    const fetchFn = vi.fn() as unknown as typeof fetch;

    const result = await sendCapAlertOnce(supabase, { ...baseOpts, fetchFn });

    expect(result).toBe("already_alerted");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns mark_failed (no POST) when the RPC errors", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { supabase } = stubSupabase({ data: null, error: { message: "boom" } });
    const fetchFn = vi.fn() as unknown as typeof fetch;

    const result = await sendCapAlertOnce(supabase, { ...baseOpts, fetchFn });

    expect(result).toBe("mark_failed");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("rolls the mark back when the notifications POST is non-2xx, so a later cap hit retries", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { supabase, rpc } = stubSupabase({ data: true, error: null });
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;

    const result = await sendCapAlertOnce(supabase, { ...baseOpts, fetchFn });

    expect(result).toBe("post_failed");
    expect(rpc).toHaveBeenCalledWith("unmark_usage_cap_alert", {
      p_business_id: "biz-1",
      p_cap_kind: "sms_monthly",
      p_period_key: "2026-06-01"
    });
    errSpy.mockRestore();
  });

  it("logs (but still returns post_failed) when the rollback RPC itself errors", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { supabase } = stubSupabase(
      { data: true, error: null },
      { data: null, error: { message: "unmark boom" } }
    );
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;

    const result = await sendCapAlertOnce(supabase, { ...baseOpts, fetchFn });

    expect(result).toBe("post_failed");
    expect(errSpy).toHaveBeenCalledWith("cap_alert unmark failed", "sms_monthly", "unmark boom");
    errSpy.mockRestore();
  });

  it("never throws even when the rollback RPC rejects", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn(async (fn: string) => {
      if (fn === "unmark_usage_cap_alert") throw new Error("unmark down");
      return { data: true, error: null };
    });
    const supabase = { rpc } as unknown as CapAlertSupabase;
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;

    const result = await sendCapAlertOnce(supabase, { ...baseOpts, fetchFn });

    expect(result).toBe("post_failed");
    expect(errSpy).toHaveBeenCalledWith("cap_alert unmark failed", "sms_monthly", "unmark down");
    errSpy.mockRestore();
  });

  it("handles a non-Error rollback rejection", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn(async (fn: string) => {
      if (fn === "unmark_usage_cap_alert") throw "unmark string failure";
      return { data: true, error: null };
    });
    const supabase = { rpc } as unknown as CapAlertSupabase;
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;

    const result = await sendCapAlertOnce(supabase, { ...baseOpts, fetchFn });

    expect(result).toBe("post_failed");
    expect(errSpy).toHaveBeenCalledWith(
      "cap_alert unmark failed",
      "sms_monthly",
      "unmark string failure"
    );
    errSpy.mockRestore();
  });

  it("never throws: rolls back the mark when fetch rejects (Error)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { supabase, rpc } = stubSupabase({ data: true, error: null });
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await sendCapAlertOnce(supabase, { ...baseOpts, fetchFn });

    expect(result).toBe("post_failed");
    expect(rpc).toHaveBeenCalledWith("unmark_usage_cap_alert", expect.anything());
    errSpy.mockRestore();
  });

  it("never throws: handles non-Error thrown values without rolling back an unclaimed mark", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn(async () => {
      throw "string failure";
    });
    const supabase = { rpc } as unknown as CapAlertSupabase;

    const result = await sendCapAlertOnce(supabase, { ...baseOpts });

    expect(result).toBe("post_failed");
    expect(errSpy).toHaveBeenCalledWith("cap_alert unexpected", "sms_monthly", "string failure");
    // The mark RPC threw before claiming, so there is nothing to roll back.
    expect(rpc).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
