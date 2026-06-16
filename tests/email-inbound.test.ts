import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...a: unknown[]) => defaultClientSpy(...a)
}));

const resolveBusinessByAddress = vi.fn();
vi.mock("@/lib/email/tenant-mailbox", () => ({
  resolveBusinessByAddress: (...a: unknown[]) => resolveBusinessByAddress(...a)
}));

const enqueueAiFlowRun = vi.fn();
vi.mock("@/lib/ai-flows/db", () => ({
  enqueueAiFlowRun: (...a: unknown[]) => enqueueAiFlowRun(...a)
}));

const recordTenantMailboxInbound = vi.fn();
vi.mock("@/lib/db/email-log", () => ({
  recordTenantMailboxInbound: (...a: unknown[]) => recordTenantMailboxInbound(...a)
}));

const recordSystemLog = vi.fn();
vi.mock("@/lib/db/system-logs", () => ({
  recordSystemLog: (...a: unknown[]) => recordSystemLog(...a)
}));

import { processInboundTenantEmail } from "@/lib/email/inbound";

/** A db whose ai_flows query resolves to the given flow rows (or error). */
function flowsDb(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  // loadTenantEmailFlows chains .eq().eq().eq(); the third (terminal) eq is awaited.
  let eqCalls = 0;
  builder.eq = vi.fn(() => {
    eqCalls += 1;
    return eqCalls >= 3 ? Promise.resolve(result) : builder;
  });
  return { from: vi.fn(() => builder) };
}

const PAYLOAD = {
  to: "amy@newcoworker.com",
  from: "Jane Lead <jane@example.com>",
  subject: "Interested in a quote",
  text: "Please call me about https://lead.example.com/123",
  messageId: "<msg-1@example.com>"
};

beforeEach(() => {
  defaultClientSpy.mockReset();
  resolveBusinessByAddress.mockReset();
  enqueueAiFlowRun.mockReset();
  recordTenantMailboxInbound.mockReset();
  recordSystemLog.mockReset();
});

describe("processInboundTenantEmail", () => {
  it("returns matched:false for an unknown recipient (no logging)", async () => {
    resolveBusinessByAddress.mockResolvedValue(null);
    const res = await processInboundTenantEmail(PAYLOAD, flowsDb({ data: [], error: null }) as never);
    expect(res).toEqual({ matched: false });
    expect(recordTenantMailboxInbound).not.toHaveBeenCalled();
  });

  it("logs inbound mail and enqueues each matching flow", async () => {
    resolveBusinessByAddress.mockResolvedValue("biz-1");
    const db = flowsDb({
      data: [
        { id: "flow-match", definition: { trigger: { channel: "tenant_email", conditions: [{ type: "has_url" }] } } },
        { id: "flow-skip", definition: { trigger: { channel: "tenant_email", conditions: [{ type: "contains", value: "zzz" }] } } },
        { id: "flow-anymatch", definition: { trigger: { channel: "tenant_email" } } }
      ],
      error: null
    });
    enqueueAiFlowRun.mockResolvedValueOnce({ id: "run-1" }).mockResolvedValueOnce({ id: "run-2" });

    const res = await processInboundTenantEmail(PAYLOAD, db as never);

    expect(res).toEqual({ matched: true, businessId: "biz-1", enqueued: 2 });
    expect(enqueueAiFlowRun).toHaveBeenCalledTimes(2);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz-1", flowId: "flow-match", dedupeKey: "email:<msg-1@example.com>" }),
      db
    );
    expect(recordSystemLog).toHaveBeenCalledTimes(2);
    expect(recordTenantMailboxInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        toEmail: "amy@newcoworker.com",
        fromEmail: "jane@example.com",
        flowId: "flow-match",
        runId: "run-1",
        providerMessageId: "<msg-1@example.com>"
      }),
      db
    );
  });

  it("treats a duplicate (null enqueue) as already-handled and logs once", async () => {
    resolveBusinessByAddress.mockResolvedValue("biz-1");
    const db = flowsDb({
      data: [{ id: "flow-dupe", definition: { trigger: { channel: "tenant_email", conditions: [] } } }],
      error: null
    });
    enqueueAiFlowRun.mockResolvedValue(null); // already enqueued by an earlier delivery

    const res = await processInboundTenantEmail(PAYLOAD, db as never);
    expect(res).toEqual({ matched: true, businessId: "biz-1", enqueued: 0 });
    expect(recordSystemLog).not.toHaveBeenCalled();
    expect(recordTenantMailboxInbound).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: null, runId: null }),
      db
    );
  });

  it("handles a bare From address and a flow set with no matching rows", async () => {
    resolveBusinessByAddress.mockResolvedValue("biz-1");
    const db = flowsDb({ data: null, error: null }); // null data → treated as []
    const res = await processInboundTenantEmail(
      { ...PAYLOAD, from: "jane@example.com" },
      db as never
    );
    expect(res).toEqual({ matched: true, businessId: "biz-1", enqueued: 0 });
    expect(recordTenantMailboxInbound).toHaveBeenCalledWith(
      expect.objectContaining({ fromEmail: "jane@example.com", flowId: null, runId: null }),
      db
    );
  });

  it("surfaces an ai_flows query error", async () => {
    resolveBusinessByAddress.mockResolvedValue("biz-1");
    const db = flowsDb({ data: null, error: { message: "down" } });
    await expect(processInboundTenantEmail(PAYLOAD, db as never)).rejects.toThrow(
      "loadTenantEmailFlows: down"
    );
  });

  it("uses the default client when none is injected", async () => {
    resolveBusinessByAddress.mockResolvedValue(null);
    defaultClientSpy.mockResolvedValueOnce(flowsDb({ data: [], error: null }));
    await expect(processInboundTenantEmail(PAYLOAD)).resolves.toEqual({ matched: false });
  });
});
