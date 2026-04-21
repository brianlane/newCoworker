import { describe, it, expect, vi, type Mock } from "vitest";
import {
  DEFAULT_BRIDGE_STALE_SECONDS,
  DEFAULT_SETTLEMENT_STUCK_SECONDS,
  computeStaleBridges,
  computeStuckSettlements,
  formatAlertSummary,
  parsePositiveInt,
  postWebhook,
  type AlertPayload
} from "../supabase/functions/_shared/voice_bridge_health";

type WebhookInit = { method: string; headers: Record<string, string>; body: string };
type WebhookResult = { ok: boolean; status: number; text: () => Promise<string> };
// vi.fn's generic is invariant enough that we read `.mock.calls` through this
// narrow helper; the alternative is littering every call site with `as` casts.
function firstCall(mock: Mock<(url: string, init: WebhookInit) => Promise<WebhookResult>>): [string, WebhookInit] {
  const call = mock.mock.calls[0];
  if (!call) throw new Error("fetchImpl was not called");
  return call;
}

const NOW_MS = Date.UTC(2026, 3, 20, 12, 0, 0);

describe("parsePositiveInt", () => {
  it("returns fallback for empty/undefined/null", () => {
    expect(parsePositiveInt(undefined, 42)).toBe(42);
    expect(parsePositiveInt("", 42)).toBe(42);
  });

  it("returns fallback for non-positive / non-finite", () => {
    expect(parsePositiveInt("0", 42)).toBe(42);
    expect(parsePositiveInt("-5", 42)).toBe(42);
    expect(parsePositiveInt("abc", 42)).toBe(42);
  });

  it("floors positive numeric strings", () => {
    expect(parsePositiveInt("10", 42)).toBe(10);
    expect(parsePositiveInt("10.9", 42)).toBe(10);
  });
});

describe("computeStaleBridges", () => {
  it("skips rows without a telnyx_connection_id (shell rows)", () => {
    const rows = [
      {
        business_id: "biz-a",
        bridge_last_heartbeat_at: new Date(NOW_MS - 600_000).toISOString(),
        telnyx_connection_id: null
      }
    ];
    expect(computeStaleBridges(rows, NOW_MS, 300)).toEqual([]);
  });

  it("flags rows with a null heartbeat and sentinel age -1", () => {
    const rows = [
      {
        business_id: "biz-a",
        bridge_last_heartbeat_at: null,
        telnyx_connection_id: "conn-1"
      }
    ];
    const out = computeStaleBridges(rows, NOW_MS, 300);
    expect(out).toEqual([
      { business_id: "biz-a", bridge_last_heartbeat_at: null, age_seconds: -1 }
    ]);
  });

  it("ignores fresh heartbeats", () => {
    const rows = [
      {
        business_id: "biz-fresh",
        bridge_last_heartbeat_at: new Date(NOW_MS - 10_000).toISOString(),
        telnyx_connection_id: "conn-1"
      }
    ];
    expect(computeStaleBridges(rows, NOW_MS, 300)).toEqual([]);
  });

  it("flags heartbeats older than the cutoff with age_seconds", () => {
    const heartbeat = new Date(NOW_MS - 600_000).toISOString();
    const rows = [
      {
        business_id: "biz-stale",
        bridge_last_heartbeat_at: heartbeat,
        telnyx_connection_id: "conn-2"
      }
    ];
    const out = computeStaleBridges(rows, NOW_MS, 300);
    expect(out).toEqual([
      {
        business_id: "biz-stale",
        bridge_last_heartbeat_at: heartbeat,
        age_seconds: 600
      }
    ]);
  });

  it("ignores unparseable heartbeat timestamps", () => {
    const rows = [
      {
        business_id: "biz-junk",
        bridge_last_heartbeat_at: "not-a-date",
        telnyx_connection_id: "conn-3"
      }
    ];
    expect(computeStaleBridges(rows, NOW_MS, 300)).toEqual([]);
  });
});

describe("computeStuckSettlements", () => {
  it("skips rows with finalized_at", () => {
    const rows = [
      {
        call_control_id: "cc-1",
        business_id: "biz-a",
        first_signal_at: new Date(NOW_MS - 3_600_000).toISOString(),
        finalized_at: new Date(NOW_MS - 60_000).toISOString()
      }
    ];
    expect(computeStuckSettlements(rows, NOW_MS, 1800)).toEqual([]);
  });

  it("skips rows with no first_signal_at", () => {
    const rows = [
      {
        call_control_id: "cc-none",
        business_id: "biz-a",
        first_signal_at: null,
        finalized_at: null
      }
    ];
    expect(computeStuckSettlements(rows, NOW_MS, 1800)).toEqual([]);
  });

  it("skips rows whose first_signal_at is within the window", () => {
    const rows = [
      {
        call_control_id: "cc-fresh",
        business_id: "biz-a",
        first_signal_at: new Date(NOW_MS - 60_000).toISOString(),
        finalized_at: null
      }
    ];
    expect(computeStuckSettlements(rows, NOW_MS, 1800)).toEqual([]);
  });

  it("flags unfinalized rows older than the cutoff", () => {
    const first = new Date(NOW_MS - 3600_000).toISOString();
    const rows = [
      {
        call_control_id: "cc-stuck",
        business_id: "biz-b",
        first_signal_at: first,
        finalized_at: null
      }
    ];
    const out = computeStuckSettlements(rows, NOW_MS, 1800);
    expect(out).toEqual([
      {
        call_control_id: "cc-stuck",
        business_id: "biz-b",
        first_signal_at: first,
        age_seconds: 3600
      }
    ]);
  });

  it("ignores unparseable first_signal_at timestamps", () => {
    const rows = [
      {
        call_control_id: "cc-junk",
        business_id: "biz-a",
        first_signal_at: "nope",
        finalized_at: null
      }
    ];
    expect(computeStuckSettlements(rows, NOW_MS, 1800)).toEqual([]);
  });
});

describe("formatAlertSummary", () => {
  const base: AlertPayload = {
    generated_at: new Date(NOW_MS).toISOString(),
    stale_bridges: [],
    stuck_settlements: [],
    thresholds: {
      bridge_stale_seconds: 300,
      settlement_stuck_seconds: 1800
    }
  };

  it("returns OK when nothing is wrong", () => {
    expect(formatAlertSummary(base)).toBe("voice health OK");
  });

  it("pluralizes correctly for one item", () => {
    const p: AlertPayload = {
      ...base,
      stale_bridges: [{ business_id: "b", bridge_last_heartbeat_at: null, age_seconds: -1 }]
    };
    expect(formatAlertSummary(p)).toBe("voice health issue: 1 stale bridge (> 300s)");
  });

  it("pluralizes correctly for many items and lists both kinds", () => {
    const p: AlertPayload = {
      ...base,
      stale_bridges: [
        { business_id: "b1", bridge_last_heartbeat_at: null, age_seconds: -1 },
        { business_id: "b2", bridge_last_heartbeat_at: null, age_seconds: -1 }
      ],
      stuck_settlements: [
        {
          call_control_id: "cc",
          business_id: "b3",
          first_signal_at: new Date(NOW_MS - 2000_000).toISOString(),
          age_seconds: 2000
        }
      ]
    };
    expect(formatAlertSummary(p)).toBe(
      "voice health issue: 2 stale bridges (> 300s), 1 stuck settlement (> 1800s)"
    );
  });

  it("pluralizes stuck settlements when > 1", () => {
    const p: AlertPayload = {
      ...base,
      stuck_settlements: [
        {
          call_control_id: "cc1",
          business_id: "b1",
          first_signal_at: new Date(NOW_MS - 2000_000).toISOString(),
          age_seconds: 2000
        },
        {
          call_control_id: "cc2",
          business_id: "b2",
          first_signal_at: new Date(NOW_MS - 3000_000).toISOString(),
          age_seconds: 3000
        }
      ]
    };
    expect(formatAlertSummary(p)).toBe(
      "voice health issue: 2 stuck settlements (> 1800s)"
    );
  });
});

describe("postWebhook", () => {
  const payload: AlertPayload = {
    generated_at: new Date(NOW_MS).toISOString(),
    stale_bridges: [
      { business_id: "biz-1", bridge_last_heartbeat_at: null, age_seconds: -1 },
      { business_id: "biz-2", bridge_last_heartbeat_at: "2026-04-20T11:50:00Z", age_seconds: 600 }
    ],
    stuck_settlements: [
      {
        call_control_id: "cc-1",
        business_id: "biz-3",
        first_signal_at: "2026-04-20T11:00:00Z",
        age_seconds: 3600
      }
    ],
    thresholds: { bridge_stale_seconds: 300, settlement_stuck_seconds: 1800 }
  };

  it("returns ok on 2xx", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => ""
    }));
    const result = await postWebhook(fetchImpl, "https://hook.example", payload);
    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = firstCall(fetchImpl);
    expect(url).toBe("https://hook.example");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    expect(body.text).toMatch(/voice health issue/);
    expect(Array.isArray(body.attachments)).toBe(true);
    expect(body.attachments[0].fields[0].value).toContain("biz-1");
    expect(body.attachments[0].fields[0].value).toContain("biz-2");
    expect(body.attachments[0].fields[1].value).toContain("cc-1");
  });

  it("returns error on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "boom".repeat(200) // exceeds the 500-char slice
    }));
    const result = await postWebhook(fetchImpl, "https://hook.example", payload);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error?.length).toBeLessThanOrEqual(500);
  });

  it("catches fetch throws and returns status 0", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("dns boom");
    });
    const result = await postWebhook(fetchImpl, "https://hook.example", payload);
    expect(result).toEqual({ ok: false, status: 0, error: "dns boom" });
  });

  it("coerces non-Error throws to string", async () => {
    const fetchImpl = vi.fn(async () => {
      throw "string-thrown";
    });
    const result = await postWebhook(fetchImpl, "https://hook.example", payload);
    expect(result).toEqual({ ok: false, status: 0, error: "string-thrown" });
  });

  it("renders 'none' when payload is empty on the plumbing side", async () => {
    const empty: AlertPayload = {
      ...payload,
      stale_bridges: [],
      stuck_settlements: []
    };
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }));
    await postWebhook(fetchImpl, "https://hook.example", empty);
    const body = JSON.parse(firstCall(fetchImpl)[1].body);
    expect(body.text).toBe("voice health OK");
    expect(body.attachments[0].fields[0].value).toBe("none");
    expect(body.attachments[0].fields[1].value).toBe("none");
  });
});

describe("defaults", () => {
  it("match the documented 5min / 30min cadence expectations", () => {
    expect(DEFAULT_BRIDGE_STALE_SECONDS).toBe(300);
    expect(DEFAULT_SETTLEMENT_STUCK_SECONDS).toBe(1800);
  });
});
