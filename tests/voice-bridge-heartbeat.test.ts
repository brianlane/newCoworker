import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDLE_HEARTBEAT_INTERVAL_MS,
  startIdleHeartbeatLoop,
  writeHeartbeat
} from "../vps/voice-bridge/src/heartbeat";

type Upsert = (
  row: Record<string, unknown>,
  opts: { onConflict: string }
) => Promise<unknown>;

function makeSupabase(): { upsert: ReturnType<typeof vi.fn>; client: { from: () => { upsert: Upsert } } } {
  const upsert = vi.fn().mockResolvedValue({ data: null, error: null });
  const client = {
    from: vi.fn(() => ({ upsert: upsert as unknown as Upsert }))
  };
  return { upsert, client };
}

describe("writeHeartbeat", () => {
  it("upserts business_telnyx_settings keyed on business_id with bridge_last_heartbeat_at", async () => {
    const { upsert, client } = makeSupabase();
    await writeHeartbeat(client as never, "biz-1", () => "2026-05-01T00:00:00.000Z");
    expect(client.from).toHaveBeenCalledWith("business_telnyx_settings");
    expect(upsert).toHaveBeenCalledWith(
      {
        business_id: "biz-1",
        bridge_last_heartbeat_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z"
      },
      { onConflict: "business_id" }
    );
  });

  it("uses the current wall clock when `now` is omitted", async () => {
    const { upsert, client } = makeSupabase();
    await writeHeartbeat(client as never, "biz-1");
    const row = upsert.mock.calls[0][0] as Record<string, string>;
    // ISO 8601 UTC, e.g. 2026-05-03T17:48:09.123Z
    expect(row.bridge_last_heartbeat_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
    );
    expect(row.bridge_last_heartbeat_at).toBe(row.updated_at);
  });
});

describe("startIdleHeartbeatLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits an eager beat immediately so the dashboard reflects a restart in seconds, not minutes", async () => {
    const { upsert, client } = makeSupabase();
    let n = 0;
    const timer = startIdleHeartbeatLoop(
      client as never,
      "biz-1",
      60_000,
      () => `t${n++}`
    );
    // Eager beat fires synchronously (writeHeartbeat is awaited via void).
    await Promise.resolve();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toMatchObject({ bridge_last_heartbeat_at: "t0" });
    clearInterval(timer);
  });

  it("re-beats on every interval tick", async () => {
    const { upsert, client } = makeSupabase();
    const timer = startIdleHeartbeatLoop(client as never, "biz-1", 1_000);
    await Promise.resolve();
    expect(upsert).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(upsert).toHaveBeenCalledTimes(4);
    clearInterval(timer);
  });

  it("uses IDLE_HEARTBEAT_INTERVAL_MS by default", async () => {
    const { upsert, client } = makeSupabase();
    const timer = startIdleHeartbeatLoop(client as never, "biz-1");
    await Promise.resolve();
    expect(upsert).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(IDLE_HEARTBEAT_INTERVAL_MS - 1);
    expect(upsert).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(upsert).toHaveBeenCalledTimes(2);
    clearInterval(timer);
  });

  it("returns a clearable timer (callers can stop the loop in tests)", () => {
    const { client } = makeSupabase();
    const timer = startIdleHeartbeatLoop(client as never, "biz-1", 1_000);
    expect(timer).toBeDefined();
    clearInterval(timer);
  });

  it("is well below BRIDGE_FRESHNESS_THRESHOLD_MS (3 min) so an idle bridge never flips to stale between beats", () => {
    // Pin the cadence so a future "tune the heartbeat to be cheaper"
    // refactor cannot accidentally raise it past the 3-minute staleness
    // threshold and re-introduce the "voice bridge hasn't checked in yet"
    // misclassification.
    expect(IDLE_HEARTBEAT_INTERVAL_MS).toBeLessThan(3 * 60 * 1000);
  });
});
