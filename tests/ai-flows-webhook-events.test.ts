import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...a: unknown[]) => defaultClientSpy(...a)
}));

const enqueueAiFlowRun = vi.fn();
vi.mock("@/lib/ai-flows/db", () => ({
  enqueueAiFlowRun: (...a: unknown[]) => enqueueAiFlowRun(...a)
}));

const recordSystemLog = vi.fn();
vi.mock("@/lib/db/system-logs", () => ({
  recordSystemLog: (...a: unknown[]) => recordSystemLog(...a)
}));

import { processWebhookFlowEvent, webhookEventKey } from "@/lib/ai-flows/webhook-events";

/** A db whose ai_flows query resolves to the given flow rows (or error). */
function flowsDb(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  // loadWebhookFlows chains .eq().eq().eq(); the third (terminal) eq is awaited.
  let eqCalls = 0;
  builder.eq = vi.fn(() => {
    eqCalls += 1;
    return eqCalls >= 3 ? Promise.resolve(result) : builder;
  });
  return { from: vi.fn(() => builder) };
}

const EVENT = {
  source: "facebook_lead_ads",
  eventId: "lead-123",
  data: {
    full_name: "Jane Lead",
    phone_number: "+16025551234",
    email: "jane@example.com",
    link: "https://fb.me/lead/1"
  }
};

beforeEach(() => {
  defaultClientSpy.mockReset();
  enqueueAiFlowRun.mockReset();
  recordSystemLog.mockReset();
});

describe("webhookEventKey", () => {
  it("uses the caller event id when present (trimmed, bounded)", () => {
    expect(webhookEventKey(EVENT)).toBe("lead-123");
    expect(webhookEventKey({ ...EVENT, eventId: `  ${"x".repeat(300)}  ` }).length).toBe(180);
  });
  it("digests the payload when no event id — identical redeliveries collide, different leads don't", () => {
    const a = webhookEventKey({ source: "s", data: { a: 1 } });
    expect(a).toBe(webhookEventKey({ source: "s", data: { a: 1 } }));
    expect(a).not.toBe(webhookEventKey({ source: "s", data: { a: 2 } }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("treats a whitespace-only event id as absent", () => {
    expect(webhookEventKey({ source: "s", eventId: "   ", data: { a: 1 } })).toMatch(
      /^[0-9a-f]{64}$/
    );
  });
});

describe("processWebhookFlowEvent", () => {
  it("enqueues each matching flow and logs the delivery", async () => {
    const db = flowsDb({
      data: [
        { id: "flow-match", definition: { trigger: { channel: "webhook", conditions: [{ type: "has_url" }] } } },
        { id: "flow-skip", definition: { trigger: { channel: "webhook", conditions: [{ type: "contains", value: "zzz" }] } } },
        { id: "flow-anymatch", definition: { trigger: { channel: "webhook" } } }
      ],
      error: null
    });
    enqueueAiFlowRun.mockResolvedValueOnce({ id: "run-1" }).mockResolvedValueOnce({ id: "run-2" });

    const res = await processWebhookFlowEvent("biz-1", EVENT, db as never);

    expect(res).toEqual({ enqueued: 2, flowsEvaluated: 3 });
    expect(enqueueAiFlowRun).toHaveBeenCalledTimes(2);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        flowId: "flow-match",
        dedupeKey: "webhook:lead-123",
        trigger: expect.objectContaining({
          channel: "webhook",
          from: "facebook_lead_ads",
          url: "https://fb.me/lead/1"
        })
      }),
      db
    );
    // One per enqueued run + the always-on delivery log.
    expect(recordSystemLog).toHaveBeenCalledTimes(3);
    expect(recordSystemLog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: "webhook_event_received",
        payload: expect.objectContaining({
          source_label: "facebook_lead_ads",
          flows_evaluated: 3,
          runs_enqueued: 2,
          flow_ids: ["flow-match", "flow-anymatch"]
        })
      }),
      db
    );
  });

  it("matches conditions against the FLATTENED payload text", async () => {
    const db = flowsDb({
      data: [
        {
          id: "flow-city",
          definition: {
            trigger: { channel: "webhook", conditions: [{ type: "contains", value: "phoenix" }] }
          }
        }
      ],
      error: null
    });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-1" });

    const res = await processWebhookFlowEvent(
      "biz-1",
      { source: "make", data: { field_data: { city: "Phoenix" } } },
      db as never
    );
    expect(res.enqueued).toBe(1);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({ windowText: "field_data.city: Phoenix" })
      }),
      db
    );
  });

  it("treats a duplicate (null enqueue) as already-handled — delivery log only", async () => {
    const db = flowsDb({
      data: [{ id: "flow-dupe", definition: { trigger: { channel: "webhook", conditions: [] } } }],
      error: null
    });
    enqueueAiFlowRun.mockResolvedValue(null); // already enqueued by an earlier delivery

    const res = await processWebhookFlowEvent("biz-1", EVENT, db as never);
    expect(res).toEqual({ enqueued: 0, flowsEvaluated: 1 });
    expect(recordSystemLog).toHaveBeenCalledTimes(1);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "webhook_event_received" }),
      db
    );
  });

  it("fails closed when a from_matches contact ref cannot be resolved", async () => {
    // The flows-only db stub has no contacts/roster query support, so ref
    // resolution throws — the flow must fail closed (no run) without breaking
    // the delivery log.
    const db = flowsDb({
      data: [
        {
          id: "flow-ref",
          definition: {
            trigger: {
              channel: "webhook",
              conditions: [
                {
                  type: "from_matches",
                  ref: { source: "contact", id: "22222222-2222-4222-8222-222222222222" }
                }
              ]
            }
          }
        }
      ],
      error: null
    });
    const res = await processWebhookFlowEvent("biz-1", EVENT, db as never);
    expect(res).toEqual({ enqueued: 0, flowsEvaluated: 1 });
    expect(enqueueAiFlowRun).not.toHaveBeenCalled();
  });

  it("handles null flow data and logs a zero-flow delivery for the guide readout", async () => {
    const db = flowsDb({ data: null, error: null });
    const res = await processWebhookFlowEvent("biz-1", EVENT, db as never);
    expect(res).toEqual({ enqueued: 0, flowsEvaluated: 0 });
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "webhook_event_received",
        payload: expect.objectContaining({ flows_evaluated: 0, runs_enqueued: 0 })
      }),
      db
    );
  });

  it("surfaces an ai_flows query error", async () => {
    const db = flowsDb({ data: null, error: { message: "down" } });
    await expect(processWebhookFlowEvent("biz-1", EVENT, db as never)).rejects.toThrow(
      "loadWebhookFlows: down"
    );
  });

  it("uses the default client when none is injected", async () => {
    defaultClientSpy.mockResolvedValueOnce(flowsDb({ data: [], error: null }));
    await expect(processWebhookFlowEvent("biz-1", EVENT)).resolves.toEqual({
      enqueued: 0,
      flowsEvaluated: 0
    });
  });
});
