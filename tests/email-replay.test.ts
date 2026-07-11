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

import {
  MAX_REPLAY_EMAILS,
  flowHasTenantEmailTrigger,
  replayInboundEmails
} from "@/lib/email/replay";
import {
  BACKFILL_SKIP_EXISTING_TRIGGER_KEY,
  isBackfillSkipExistingTrigger
} from "../supabase/functions/_shared/ai_flows/backfill";

/**
 * email_log stub: select chain (.select().eq().eq().eq().is().in()) resolves
 * `selectResult`; update chain (.update().eq().eq()) is thenable and resolves
 * `updateResult`, recording each patch for assertions.
 */
function emailLogDb(
  selectResult: { data: unknown; error: unknown },
  updateResult: { error: { message: string } | null } = { error: null }
) {
  const updates: Record<string, unknown>[] = [];
  const from = vi.fn(() => {
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.is = vi.fn(() => builder);
    builder.in = vi.fn(() => Promise.resolve(selectResult));
    builder.update = vi.fn((patch: Record<string, unknown>) => {
      updates.push(patch);
      const ub: Record<string, unknown> = {};
      ub.eq = vi.fn(() => ub);
      ub.then = (resolve: (v: unknown) => void) => resolve(updateResult);
      return ub;
    });
    return builder;
  });
  return { db: { from } as never, updates };
}

const ROW = {
  id: "mail-1",
  from_email: "alerts-noreply@privyr.com",
  to_email: "leads@newcoworker.com",
  subject: "New Lead: Ali",
  body_preview: "preview text",
  body_full: "Name: Ali Phone: +14165550001",
  attachments: null,
  provider_message_id: "<m1@ses>",
  created_at: "2026-07-11T19:49:54Z"
};

beforeEach(() => {
  defaultClientSpy.mockReset();
  enqueueAiFlowRun.mockReset();
  recordSystemLog.mockReset();
  recordSystemLog.mockResolvedValue(undefined);
});

describe("flowHasTenantEmailTrigger", () => {
  it("matches a primary tenant_email trigger", () => {
    expect(flowHasTenantEmailTrigger({ trigger: { channel: "tenant_email" } })).toBe(true);
  });

  it("matches a tenant_email trigger in the extra triggers array", () => {
    expect(
      flowHasTenantEmailTrigger({
        trigger: { channel: "sms" },
        triggers: [{ channel: "tenant_email" }]
      })
    ).toBe(true);
  });

  it("rejects flows with no tenant_email trigger anywhere", () => {
    expect(flowHasTenantEmailTrigger({ trigger: { channel: "webhook" } })).toBe(false);
    expect(flowHasTenantEmailTrigger(null)).toBe(false);
  });
});

describe("backfill trigger marker", () => {
  it("recognizes the string and boolean forms, rejects everything else", () => {
    expect(isBackfillSkipExistingTrigger({ [BACKFILL_SKIP_EXISTING_TRIGGER_KEY]: "1" })).toBe(true);
    expect(isBackfillSkipExistingTrigger({ [BACKFILL_SKIP_EXISTING_TRIGGER_KEY]: true })).toBe(
      true
    );
    expect(isBackfillSkipExistingTrigger({ [BACKFILL_SKIP_EXISTING_TRIGGER_KEY]: "0" })).toBe(
      false
    );
    expect(isBackfillSkipExistingTrigger({})).toBe(false);
    expect(isBackfillSkipExistingTrigger(undefined)).toBe(false);
  });
});

describe("replayInboundEmails", () => {
  it("returns an empty summary without touching the db when no ids are given", async () => {
    const { db } = emailLogDb({ data: [], error: null });
    const summary = await replayInboundEmails("biz-1", "flow-1", { emailLogIds: [] }, db);
    expect(summary).toEqual({
      total: 0,
      enqueued: 0,
      duplicates: 0,
      skipped: 0,
      errors: 0,
      outcomes: []
    });
    expect(recordSystemLog).not.toHaveBeenCalled();
  });

  it("throws when the email_log read fails", async () => {
    const { db } = emailLogDb({ data: null, error: { message: "boom" } });
    await expect(
      replayInboundEmails("biz-1", "flow-1", { emailLogIds: ["mail-1"] }, db)
    ).rejects.toThrow("replayInboundEmails: boom");
  });

  it("enqueues a backfill run with the live path's dedupe key and stamps the row", async () => {
    const { db, updates } = emailLogDb({ data: [ROW], error: null });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-9" });

    const summary = await replayInboundEmails(
      "biz-1",
      "flow-1",
      { emailLogIds: ["mail-1"] },
      db
    );

    expect(summary.enqueued).toBe(1);
    expect(summary.outcomes).toEqual([
      { emailLogId: "mail-1", status: "enqueued", runId: "run-9" }
    ]);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        flowId: "flow-1",
        dedupeKey: "email:<m1@ses>",
        trigger: expect.objectContaining({
          channel: "tenant_email",
          from: "alerts-noreply@privyr.com",
          to: "leads@newcoworker.com",
          subject: "New Lead: Ali",
          windowText: "New Lead: Ali\nName: Ali Phone: +14165550001",
          received_at: "2026-07-11T19:49:54Z",
          [BACKFILL_SKIP_EXISTING_TRIGGER_KEY]: "1"
        })
      }),
      db
    );
    expect(updates).toEqual([{ flow_id: "flow-1", run_id: "run-9" }]);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai_flow_email_replay" }),
      db
    );
  });

  it("uses the default service client when none is passed", async () => {
    const { db } = emailLogDb({ data: [ROW], error: null });
    defaultClientSpy.mockResolvedValue(db);
    enqueueAiFlowRun.mockResolvedValue({ id: "run-1" });
    const summary = await replayInboundEmails("biz-1", "flow-1", { emailLogIds: ["mail-1"] });
    expect(defaultClientSpy).toHaveBeenCalled();
    expect(summary.enqueued).toBe(1);
  });

  it("counts an already-enqueued message (dedupe hit) as a duplicate", async () => {
    const { db, updates } = emailLogDb({ data: [ROW], error: null });
    enqueueAiFlowRun.mockResolvedValue(null);
    const summary = await replayInboundEmails(
      "biz-1",
      "flow-1",
      { emailLogIds: ["mail-1"] },
      db
    );
    expect(summary.duplicates).toBe(1);
    expect(summary.outcomes[0]).toEqual({ emailLogId: "mail-1", status: "duplicate" });
    expect(updates).toEqual([]);
  });

  it("skips ids that are not unmatched inbound AI-mailbox rows", async () => {
    const { db } = emailLogDb({ data: [], error: null });
    const summary = await replayInboundEmails(
      "biz-1",
      "flow-1",
      { emailLogIds: ["mail-gone"] },
      db
    );
    expect(summary.skipped).toBe(1);
    expect(summary.outcomes[0]).toEqual({
      emailLogId: "mail-gone",
      status: "skipped",
      reason: "not an unmatched inbound AI-mailbox email"
    });
    expect(enqueueAiFlowRun).not.toHaveBeenCalled();
  });

  it("skips a message with no subject and no body", async () => {
    const { db } = emailLogDb({
      data: [
        { ...ROW, id: "mail-empty", subject: null, body_full: null, body_preview: "   " },
        { ...ROW, id: "mail-null", subject: "  ", body_full: null, body_preview: null }
      ],
      error: null
    });
    const summary = await replayInboundEmails(
      "biz-1",
      "flow-1",
      { emailLogIds: ["mail-empty", "mail-null"] },
      db
    );
    expect(summary.skipped).toBe(2);
    expect(summary.outcomes[0]).toEqual({
      emailLogId: "mail-empty",
      status: "skipped",
      reason: "empty message"
    });
    expect(summary.outcomes[1]).toEqual({
      emailLogId: "mail-null",
      status: "skipped",
      reason: "empty message"
    });
  });

  it("tolerates a null data payload from the read", async () => {
    const { db } = emailLogDb({ data: null, error: null });
    const summary = await replayInboundEmails(
      "biz-1",
      "flow-1",
      { emailLogIds: ["mail-1"] },
      db
    );
    expect(summary.skipped).toBe(1);
  });

  it("falls back to body_preview, a log-row message id, and no sender/recipient", async () => {
    const { db } = emailLogDb({
      data: [
        {
          ...ROW,
          id: "mail-2",
          from_email: null,
          to_email: null,
          body_full: null,
          provider_message_id: null
        }
      ],
      error: null
    });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-2" });
    const summary = await replayInboundEmails(
      "biz-1",
      "flow-1",
      { emailLogIds: ["mail-2"] },
      db
    );
    expect(summary.enqueued).toBe(1);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: "email:log:mail-2",
        trigger: expect.objectContaining({
          from: "",
          message_id: "log:mail-2",
          windowText: "New Lead: Ali\npreview text"
        })
      }),
      db
    );
    const trigger = (enqueueAiFlowRun.mock.calls[0][0] as { trigger: Record<string, unknown> })
      .trigger;
    expect("to" in trigger).toBe(false);
  });

  it("exposes the first inbound image attachment as {{trigger.image}}", async () => {
    const attachments = [
      { filename: "notes.pdf", mime_type: "application/pdf", size_bytes: 9, storage_path: "inbound/m/0-notes.pdf" },
      // Foreign-bucket ref (outbound screenshot shape) is not inbound mail media.
      {
        filename: "shot.png",
        mime_type: "image/png",
        size_bytes: 9,
        storage_path: "shots/1.png",
        bucket: "aiflow-screenshots"
      },
      // Defensive: a legacy row missing mime_type must not crash the scan.
      { filename: "x", size_bytes: 1, storage_path: "inbound/m/1-x" },
      { filename: "pic.jpg", mime_type: "IMAGE/JPEG ", size_bytes: 9, storage_path: "inbound/m/2-pic.jpg" }
    ];
    const { db } = emailLogDb({ data: [{ ...ROW, attachments }], error: null });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-3" });
    await replayInboundEmails("biz-1", "flow-1", { emailLogIds: ["mail-1"] }, db);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({ image: "email-attachments:inbound/m/2-pic.jpg" })
      }),
      db
    );
  });

  it("keeps going when one row's enqueue fails (Error and non-Error)", async () => {
    const rows = [
      { ...ROW, id: "mail-a", provider_message_id: "<a@ses>" },
      { ...ROW, id: "mail-b", provider_message_id: "<b@ses>" },
      { ...ROW, id: "mail-c", provider_message_id: "<c@ses>" }
    ];
    const { db } = emailLogDb({ data: rows, error: null });
    enqueueAiFlowRun
      .mockRejectedValueOnce(new Error("telnyx down"))
      .mockRejectedValueOnce("weird")
      .mockResolvedValueOnce({ id: "run-c" });
    const summary = await replayInboundEmails(
      "biz-1",
      "flow-1",
      { emailLogIds: ["mail-a", "mail-b", "mail-c"] },
      db
    );
    expect(summary.errors).toBe(2);
    expect(summary.enqueued).toBe(1);
    expect(summary.outcomes).toEqual([
      { emailLogId: "mail-a", status: "error", reason: "telnyx down" },
      { emailLogId: "mail-b", status: "error", reason: "Unexpected error" },
      { emailLogId: "mail-c", status: "enqueued", runId: "run-c" }
    ]);
  });

  it("treats a failed email_log stamp as best-effort (run stays enqueued)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = emailLogDb({ data: [ROW], error: null }, { error: { message: "rls" } });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-9" });
    const summary = await replayInboundEmails(
      "biz-1",
      "flow-1",
      { emailLogIds: ["mail-1"] },
      db
    );
    expect(summary.enqueued).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("replayInboundEmails stamp", "rls");
    errorSpy.mockRestore();
  });

  it("dedupes repeated ids and caps a request at MAX_REPLAY_EMAILS", async () => {
    const ids = Array.from({ length: MAX_REPLAY_EMAILS + 20 }, (_, i) => `mail-${i}`);
    const { db } = emailLogDb({ data: [], error: null });
    const summary = await replayInboundEmails(
      "biz-1",
      "flow-1",
      { emailLogIds: [...ids, "mail-0", "mail-1"] },
      db
    );
    expect(summary.total).toBe(MAX_REPLAY_EMAILS);
    expect(summary.skipped).toBe(MAX_REPLAY_EMAILS);
  });
});
