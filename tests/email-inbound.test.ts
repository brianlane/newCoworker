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

const findCustomerByEmail = vi.fn();
const recordInteractionAndIncrement = vi.fn();
vi.mock("@/lib/customer-memory/db", () => ({
  findCustomerByEmail: (...a: unknown[]) => findCustomerByEmail(...a),
  recordInteractionAndIncrement: (...a: unknown[]) => recordInteractionAndIncrement(...a)
}));

import { processInboundTenantEmail } from "@/lib/email/inbound";

/** A db whose ai_flows query resolves to the given flow rows (or error). */
function flowsDb(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  // loadTenantEmailFlows chains .select().eq().eq().or(); the .or (which
  // admits flows whose EXTRA triggers include tenant_email) is the terminal.
  builder.or = vi.fn(() => Promise.resolve(result));
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
  findCustomerByEmail.mockReset();
  findCustomerByEmail.mockResolvedValue(null);
  recordInteractionAndIncrement.mockReset();
  recordInteractionAndIncrement.mockResolvedValue(undefined);
});

describe("processInboundTenantEmail", () => {
  it("returns matched:false for an unknown recipient (no logging)", async () => {
    resolveBusinessByAddress.mockResolvedValue(null);
    const res = await processInboundTenantEmail(PAYLOAD, flowsDb({ data: [], error: null }) as never);
    expect(res).toEqual({ matched: false });
    expect(recordTenantMailboxInbound).not.toHaveBeenCalled();
  });

  it("removes orphaned attachments when the recipient is unknown", async () => {
    resolveBusinessByAddress.mockResolvedValue(null);
    const remove = vi.fn().mockResolvedValue({ data: [], error: null });
    const storageFrom = vi.fn(() => ({ remove }));
    const db = { from: vi.fn(), storage: { from: storageFrom } };
    const res = await processInboundTenantEmail(
      {
        ...PAYLOAD,
        attachments: [
          {
            filename: "a.pdf",
            mimeType: "application/pdf",
            size: 10,
            path: "inbound/_msg-1_example.com_/0-a.pdf"
          },
          // Foreign path (another message's namespace) must be ignored, never
          // removed — otherwise a secret-holder could delete others' objects.
          { filename: "evil.pdf", mimeType: "application/pdf", size: 1, path: "inbound/victim/0-x.pdf" }
        ]
      },
      db as never
    );
    expect(res).toEqual({ matched: false });
    expect(storageFrom).toHaveBeenCalledWith("email-attachments");
    expect(remove).toHaveBeenCalledWith(["inbound/_msg-1_example.com_/0-a.pdf"]);
    expect(recordTenantMailboxInbound).not.toHaveBeenCalled();
  });

  it("fails closed when a from_matches contact ref cannot be resolved", async () => {
    resolveBusinessByAddress.mockResolvedValue("biz-1");
    // The flows-only db stub has no contacts/roster query support, so ref
    // resolution throws — the flow must fail closed (no run) without breaking
    // the inbound path.
    const db = flowsDb({
      data: [
        {
          id: "flow-ref",
          definition: {
            trigger: {
              channel: "tenant_email",
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
    const res = await processInboundTenantEmail(PAYLOAD, db as never);
    expect(res).toEqual({ matched: true, businessId: "biz-1", enqueued: 0 });
    expect(enqueueAiFlowRun).not.toHaveBeenCalled();
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

  it("exposes the first image attachment as trigger.image (email-attachments ref)", async () => {
    resolveBusinessByAddress.mockResolvedValue("biz-1");
    const db = flowsDb({
      data: [{ id: "flow-img", definition: { trigger: { channel: "tenant_email" } } }],
      error: null
    });
    enqueueAiFlowRun.mockResolvedValueOnce({ id: "run-img" });

    await processInboundTenantEmail(
      {
        ...PAYLOAD,
        attachments: [
          // Non-image first: it must be skipped in favor of the jpeg.
          {
            filename: "quote.pdf",
            mimeType: "application/pdf",
            size: 10,
            path: "inbound/_msg-1_example.com_/0-quote.pdf"
          },
          {
            filename: "face.jpg",
            mimeType: "IMAGE/JPEG",
            size: 20,
            path: "inbound/_msg-1_example.com_/1-face.jpg"
          }
        ]
      },
      db as never
    );

    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({
          image: "email-attachments:inbound/_msg-1_example.com_/1-face.jpg"
        })
      }),
      db
    );
  });

  it("fires flows whose tenant_email trigger lives in the EXTRA triggers array (multi-trigger OR)", async () => {
    resolveBusinessByAddress.mockResolvedValue("biz-1");
    const db = flowsDb({
      data: [
        {
          // Primary is SMS; tenant_email is one of the extras — must fire once.
          id: "flow-multi",
          definition: {
            trigger: { channel: "sms", conditions: [] },
            triggers: [
              { channel: "tenant_email", conditions: [{ type: "contains", value: "zzz" }] },
              { channel: "tenant_email", conditions: [{ type: "has_url" }] }
            ]
          }
        },
        {
          // Extras with no tenant_email trigger anywhere → skipped.
          id: "flow-no-email",
          definition: { trigger: { channel: "sms", conditions: [] }, triggers: [{ channel: "manual" }] }
        }
      ],
      error: null
    });
    enqueueAiFlowRun.mockResolvedValueOnce({ id: "run-1" });

    const res = await processInboundTenantEmail(PAYLOAD, db as never);
    expect(res).toEqual({ matched: true, businessId: "biz-1", enqueued: 1 });
    expect(enqueueAiFlowRun).toHaveBeenCalledTimes(1);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: "flow-multi" }),
      db
    );
  });

  it("records message-scoped attachments and drops foreign paths", async () => {
    resolveBusinessByAddress.mockResolvedValue("biz-1");
    const db = flowsDb({ data: [], error: null });
    await processInboundTenantEmail(
      {
        ...PAYLOAD,
        attachments: [
          {
            filename: "quote.pdf",
            mimeType: "application/pdf",
            size: 2048,
            path: "inbound/_msg-1_example.com_/0-quote.pdf"
          },
          // Path outside this message's namespace — must be dropped so it can't
          // be bound to this tenant's row and signed by the dashboard.
          { filename: "secret.pdf", mimeType: "application/pdf", size: 9, path: "inbound/other/0-secret.pdf" }
        ]
      },
      db as never
    );
    expect(recordTenantMailboxInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          {
            filename: "quote.pdf",
            mime_type: "application/pdf",
            size_bytes: 2048,
            storage_path: "inbound/_msg-1_example.com_/0-quote.pdf"
          }
        ]
      }),
      db
    );
  });

  it("stores the html alternative when the worker forwards one (null otherwise)", async () => {
    resolveBusinessByAddress.mockResolvedValue("biz-1");
    const db = flowsDb({ data: [], error: null });
    await processInboundTenantEmail({ ...PAYLOAD, html: "<p>Hello</p>" }, db as never);
    expect(recordTenantMailboxInbound).toHaveBeenCalledWith(
      expect.objectContaining({ bodyHtml: "<p>Hello</p>" }),
      db
    );
    recordTenantMailboxInbound.mockClear();
    const db2 = flowsDb({ data: [], error: null });
    await processInboundTenantEmail(PAYLOAD, db2 as never);
    expect(recordTenantMailboxInbound).toHaveBeenCalledWith(
      expect.objectContaining({ bodyHtml: null }),
      db2
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

  it("rolls inbound mail up to a matching customer profile as an email interaction", async () => {
    resolveBusinessByAddress.mockResolvedValue("biz-1");
    findCustomerByEmail.mockResolvedValue({ customerE164: "+15555550123", displayName: "Jane" });
    const db = flowsDb({ data: [], error: null });

    const res = await processInboundTenantEmail({ ...PAYLOAD, from: "jane@example.com" }, db as never);

    expect(res).toEqual({ matched: true, businessId: "biz-1", enqueued: 0 });
    expect(findCustomerByEmail).toHaveBeenCalledWith("biz-1", "jane@example.com", db);
    expect(recordInteractionAndIncrement).toHaveBeenCalledWith(
      "biz-1",
      "+15555550123",
      "email",
      {},
      db
    );
  });

  it("skips the rollup (no interaction) when the sender isn't a known customer", async () => {
    resolveBusinessByAddress.mockResolvedValue("biz-1");
    findCustomerByEmail.mockResolvedValue(null);
    const db = flowsDb({ data: [], error: null });

    await processInboundTenantEmail({ ...PAYLOAD, from: "stranger@example.com" }, db as never);

    expect(recordInteractionAndIncrement).not.toHaveBeenCalled();
  });

  it("never lets a rollup failure break inbound processing", async () => {
    resolveBusinessByAddress.mockResolvedValue("biz-1");
    findCustomerByEmail.mockRejectedValue(new Error("lookup boom"));
    const db = flowsDb({ data: [], error: null });

    const res = await processInboundTenantEmail({ ...PAYLOAD, from: "jane@example.com" }, db as never);

    expect(res).toEqual({ matched: true, businessId: "biz-1", enqueued: 0 });
    expect(recordTenantMailboxInbound).toHaveBeenCalled();
  });

  it("stringifies a non-Error rollup failure when logging it (never assumes Error)", async () => {
    resolveBusinessByAddress.mockResolvedValue("biz-1");
    findCustomerByEmail.mockRejectedValue("weird non-error");
    const db = flowsDb({ data: [], error: null });

    const res = await processInboundTenantEmail({ ...PAYLOAD, from: "jane@example.com" }, db as never);

    expect(res).toEqual({ matched: true, businessId: "biz-1", enqueued: 0 });
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "customer_email_rollup_failed",
        payload: expect.objectContaining({ error: "weird non-error" })
      })
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
