import { describe, expect, it, vi } from "vitest";
import {
  OWNER_NOTIFY_FALLBACK_TASK_TYPE,
  sendOwnerNotifyFallback
} from "../supabase/functions/_shared/owner_notify_fallback";
import { isPermanentTelnyxSmsFailure } from "../supabase/functions/_shared/telnyx_permanent_failure";

/**
 * Email fallback for owner notify texts SMS cannot deliver: content still
 * reaches the owner via the notifications function, deduped per run+step
 * against DELIVERED rows, never throwing into the flow that called it.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const RUN = "10000000-0000-0000-0000-000000000001";
const NOTIFY_URL = "https://example.supabase.co/functions/v1/notifications";

const baseInput = (fetchFn: typeof fetch, over: Record<string, unknown> = {}) => ({
  businessId: BIZ,
  runId: RUN,
  stepIndex: 3,
  message: "New lead H Eve (+14168489229) booked a call",
  reason: "sms_unreachable" as const,
  phone: "+85261234567",
  notifyUrl: NOTIFY_URL,
  bearer: "service-key",
  fetchFn,
  ...over
});

/** Chainable fake client: one scripted result per terminal await. */
type Scripted = { data?: unknown; error?: unknown };
function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "limit", "maybeSingle"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { db: { from }, calls };
}

const okFetch = () =>
  vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

const NO_PRIOR = { data: [], error: null };

describe("isPermanentTelnyxSmsFailure", () => {
  it("treats 4xx as permanent except timeout and rate limit", () => {
    expect(isPermanentTelnyxSmsFailure(400)).toBe(true);
    expect(isPermanentTelnyxSmsFailure(409)).toBe(true); // the CA-outage status
    expect(isPermanentTelnyxSmsFailure(422)).toBe(true);
    expect(isPermanentTelnyxSmsFailure(408)).toBe(false);
    expect(isPermanentTelnyxSmsFailure(429)).toBe(false);
  });

  it("treats 5xx and success statuses as non-permanent", () => {
    expect(isPermanentTelnyxSmsFailure(500)).toBe(false);
    expect(isPermanentTelnyxSmsFailure(503)).toBe(false);
    expect(isPermanentTelnyxSmsFailure(200)).toBe(false);
  });
});

describe("sendOwnerNotifyFallback", () => {
  it("posts a coworker_logs-shaped record with message, reason, and run+step stamps", async () => {
    const { db } = makeDb([NO_PRIOR]);
    const fetchFn = okFetch();
    const result = await sendOwnerNotifyFallback(db, baseInput(fetchFn));
    expect(result).toBe("sent");
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit
    ];
    expect(url).toBe(NOTIFY_URL);
    const body = JSON.parse(String(init.body));
    expect(body.record.task_type).toBe(OWNER_NOTIFY_FALLBACK_TASK_TYPE);
    expect(body.record.status).toBe("urgent_alert");
    expect(body.record.business_id).toBe(BIZ);
    expect(body.record.log_payload.message).toBe("New lead H Eve (+14168489229) booked a call");
    expect(body.record.log_payload.reason).toBe("sms_unreachable");
    expect(body.record.log_payload.phone).toBe("+85261234567");
    expect(body.record.log_payload.run_id).toBe(RUN);
    expect(body.record.log_payload.step_index).toBe(3);
  });

  it("clips the carrier detail and long messages", async () => {
    const { db } = makeDb([NO_PRIOR]);
    const fetchFn = okFetch();
    await sendOwnerNotifyFallback(
      db,
      baseInput(fetchFn, {
        reason: "sms_rejected",
        message: "m".repeat(1500),
        detail: "d".repeat(500)
      })
    );
    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit
    ];
    const body = JSON.parse(String(init.body));
    expect(body.record.log_payload.message).toHaveLength(1000);
    expect(body.record.log_payload.detail).toHaveLength(200);
  });

  it("skips when a DELIVERED page for this run+step already exists", async () => {
    const { db } = makeDb([{ data: [{ id: "n1" }], error: null }]);
    const fetchFn = okFetch();
    const result = await sendOwnerNotifyFallback(db, baseInput(fetchFn));
    expect(result).toBe("already_sent");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends anyway when the dedupe lookup errors (fail open, like needs_human)", async () => {
    const { db } = makeDb([{ data: null, error: { message: "boom" } }]);
    const fetchFn = okFetch();
    const result = await sendOwnerNotifyFallback(db, baseInput(fetchFn));
    expect(result).toBe("sent");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("reports post_failed on a non-2xx from the notifications function", async () => {
    const { db } = makeDb([NO_PRIOR]);
    const fetchFn = vi.fn(
      async () => new Response("nope", { status: 500 })
    ) as unknown as typeof fetch;
    expect(await sendOwnerNotifyFallback(db, baseInput(fetchFn))).toBe("post_failed");
  });

  it("reports post_failed when fetch throws, never propagating into the flow", async () => {
    const { db } = makeDb([NO_PRIOR]);
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await sendOwnerNotifyFallback(db, baseInput(fetchFn))).toBe("post_failed");
  });
});
