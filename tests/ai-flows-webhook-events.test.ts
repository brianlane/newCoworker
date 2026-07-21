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

const recordLeadSubmission = vi.fn();
vi.mock("@/lib/leads/submissions", () => ({
  recordLeadSubmission: (...a: unknown[]) => recordLeadSubmission(...a)
}));

import {
  countEnabledWebhookFlows,
  processWebhookFlowEvent,
  webhookEventKey
} from "@/lib/ai-flows/webhook-events";

/** A db whose ai_flows query resolves to the given flow rows (or error). */
function flowsDb(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  // loadWebhookFlows chains .select().eq().eq().or(); the .or (which admits
  // flows whose EXTRA triggers include a webhook) is the awaited terminal.
  builder.or = vi.fn(() => Promise.resolve(result));
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
  recordLeadSubmission.mockReset();
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

    expect(res).toEqual({ enqueued: 2, flowsEvaluated: 3, flowsMatched: 2 });
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
    // The durable Data-view record is written once per delivery, before any
    // flow evaluation, keyed by the bare event key.
    expect(recordLeadSubmission).toHaveBeenCalledTimes(1);
    expect(recordLeadSubmission).toHaveBeenCalledWith(
      "biz-1",
      { source: EVENT.source, data: EVENT.data, eventKey: "lead-123" },
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
          flows_matched: 2,
          runs_enqueued: 2,
          flow_ids: ["flow-match", "flow-anymatch"]
        })
      }),
      db
    );
  });

  it("fires flows whose webhook trigger lives in the EXTRA triggers array (multi-trigger OR)", async () => {
    const db = flowsDb({
      data: [
        {
          // Primary is SMS; the webhook trigger is one of the extras — must fire.
          id: "flow-multi",
          definition: {
            trigger: { channel: "sms", conditions: [] },
            triggers: [
              { channel: "webhook", conditions: [{ type: "contains", value: "nope" }] },
              { channel: "webhook", conditions: [{ type: "has_url" }] }
            ]
          }
        },
        {
          // Broad .or() fetch also returns flows with extras but NO webhook
          // trigger anywhere — they must be skipped, not crash.
          id: "flow-no-webhook",
          definition: {
            trigger: { channel: "sms", conditions: [] },
            triggers: [{ channel: "manual" }]
          }
        }
      ],
      error: null
    });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-1" });

    const res = await processWebhookFlowEvent("biz-1", EVENT, db as never);
    expect(res).toEqual({ enqueued: 1, flowsEvaluated: 1, flowsMatched: 1 });
    expect(enqueueAiFlowRun).toHaveBeenCalledTimes(1);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: "flow-multi" }),
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

  it("treats a duplicate (null enqueue) as already-handled: matched but not enqueued", async () => {
    const db = flowsDb({
      data: [{ id: "flow-dupe", definition: { trigger: { channel: "webhook", conditions: [] } } }],
      error: null
    });
    enqueueAiFlowRun.mockResolvedValue(null); // already enqueued by an earlier delivery

    const res = await processWebhookFlowEvent("biz-1", EVENT, db as never);
    // flowsMatched stays 1 so the guide readout can say "already handled"
    // instead of the false "no flow matched" on a bridge retry.
    expect(res).toEqual({ enqueued: 0, flowsEvaluated: 1, flowsMatched: 1 });
    expect(recordSystemLog).toHaveBeenCalledTimes(1);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "webhook_event_received",
        payload: expect.objectContaining({ flows_matched: 1, runs_enqueued: 0 })
      }),
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
    expect(res).toEqual({ enqueued: 0, flowsEvaluated: 1, flowsMatched: 0 });
    expect(enqueueAiFlowRun).not.toHaveBeenCalled();
  });

  it("handles null flow data and logs a zero-flow delivery for the guide readout", async () => {
    const db = flowsDb({ data: null, error: null });
    const res = await processWebhookFlowEvent("biz-1", EVENT, db as never);
    expect(res).toEqual({ enqueued: 0, flowsEvaluated: 0, flowsMatched: 0 });
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
      flowsEvaluated: 0,
      flowsMatched: 0
    });
  });

  it("forwards earliestClaimAt (lead-backlog drip) onto every enqueued run", async () => {
    const db = flowsDb({
      data: [{ id: "flow-drip", definition: { trigger: { channel: "webhook", conditions: [] } } }],
      error: null
    });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-1" });

    const at = "2026-07-10T21:00:00.000Z";
    await processWebhookFlowEvent("biz-1", EVENT, db as never, { earliestClaimAt: at });
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: "flow-drip", earliestClaimAt: at }),
      db
    );

    // Without the option the enqueue input must NOT carry the key at all.
    enqueueAiFlowRun.mockClear();
    await processWebhookFlowEvent("biz-1", EVENT, db as never);
    expect(enqueueAiFlowRun.mock.calls[0][0]).not.toHaveProperty("earliestClaimAt");
  });
});

describe("countEnabledWebhookFlows", () => {
  it("counts only flows carrying a webhook trigger somewhere in their set", async () => {
    const db = flowsDb({
      data: [
        { id: "f1", definition: { trigger: { channel: "webhook", conditions: [] } } },
        {
          id: "f2",
          definition: { trigger: { channel: "sms", conditions: [] }, triggers: [{ channel: "manual" }] }
        }
      ],
      error: null
    });
    await expect(countEnabledWebhookFlows("biz-1", db as never)).resolves.toBe(1);
  });

  it("uses the default client when none is injected", async () => {
    defaultClientSpy.mockResolvedValueOnce(flowsDb({ data: [], error: null }));
    await expect(countEnabledWebhookFlows("biz-1")).resolves.toBe(0);
  });
});
