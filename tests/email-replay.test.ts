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
  flowUpsertsBeforeOutreach,
  replayInboundEmails
} from "@/lib/email/replay";
import {
  BACKFILL_SKIP_EXISTING_TRIGGER_KEY,
  isBackfillSkipExistingTrigger
} from "../supabase/functions/_shared/ai_flows/backfill";

type Result = { data: unknown; error: { message: string } | null };

/**
 * Table-aware db stub for the replay's four query shapes:
 *  - email_log select  (.select().eq()×3.is().in() → `emailLog`)
 *  - email_log update  (.update().eq().eq() thenable → `update`, patches recorded)
 *  - ai_flow_runs select (.select().eq()×3.maybeSingle() → `runLookup`)
 *  - contacts select     (from_matches ref resolution .maybeSingle() → `contacts`)
 */
function replayDb(opts: {
  emailLog: Result;
  update?: { error: { message: string } | null };
  runLookup?: Result;
  contacts?: Result;
}) {
  const updates: Record<string, unknown>[] = [];
  const from = vi.fn((table: string) => {
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.is = vi.fn(() => builder);
    builder.in = vi.fn(() => Promise.resolve(opts.emailLog));
    builder.maybeSingle = vi.fn(() =>
      Promise.resolve(
        table === "ai_flow_runs"
          ? (opts.runLookup ?? { data: null, error: null })
          : (opts.contacts ?? { data: null, error: null })
      )
    );
    builder.update = vi.fn((patch: Record<string, unknown>) => {
      updates.push(patch);
      const ub: Record<string, unknown> = {};
      ub.eq = vi.fn(() => ub);
      ub.then = (resolve: (v: unknown) => void) => resolve(opts.update ?? { error: null });
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

/** A tenant_email flow with no conditions — matches every message. */
const FLOW = { id: "flow-1", definition: { trigger: { channel: "tenant_email" } } };

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

describe("flowUpsertsBeforeOutreach", () => {
  it("accepts upsert-then-text and rejects text-then-upsert", () => {
    expect(
      flowUpsertsBeforeOutreach({
        steps: [{ type: "extract_text" }, { type: "upsert_customer" }, { type: "send_sms" }]
      })
    ).toBe(true);
    expect(
      flowUpsertsBeforeOutreach({
        steps: [{ type: "send_sms" }, { type: "upsert_customer" }]
      })
    ).toBe(false);
  });

  it("rejects a flow with outreach and no upsert at all", () => {
    expect(flowUpsertsBeforeOutreach({ steps: [{ type: "send_email" }] })).toBe(false);
  });

  it("accepts a flow with no outreach steps (nothing to guard)", () => {
    expect(
      flowUpsertsBeforeOutreach({ steps: [{ type: "extract_text" }, { type: "notify_owner" }] })
    ).toBe(true);
    expect(flowUpsertsBeforeOutreach(null)).toBe(true);
  });

  it("checks branch arms and else paths with the state at the branch point", () => {
    // Upsert before the branch protects sends inside every arm.
    expect(
      flowUpsertsBeforeOutreach({
        steps: [
          { type: "upsert_customer" },
          {
            type: "branch",
            branches: [{ steps: [{ type: "send_sms" }] }],
            else: [{ type: "send_email" }]
          }
        ]
      })
    ).toBe(true);
    // A send inside an arm with no prior upsert fails.
    expect(
      flowUpsertsBeforeOutreach({
        steps: [
          {
            type: "branch",
            branches: [{ steps: [{ type: "send_sms" }] }]
          }
        ]
      })
    ).toBe(false);
    // An else-path send with no prior upsert fails.
    expect(
      flowUpsertsBeforeOutreach({
        steps: [{ type: "branch", branches: [], else: [{ type: "route_to_team" }] }]
      })
    ).toBe(false);
    // Conservative: an upsert INSIDE one arm does not credit steps after the
    // branch (the other arm may have skipped it).
    expect(
      flowUpsertsBeforeOutreach({
        steps: [
          { type: "branch", branches: [{ steps: [{ type: "upsert_customer" }] }] },
          { type: "send_sms" }
        ]
      })
    ).toBe(false);
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
    const { db } = replayDb({ emailLog: { data: [], error: null } });
    const summary = await replayInboundEmails("biz-1", FLOW, { emailLogIds: [] }, db);
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
    const { db } = replayDb({ emailLog: { data: null, error: { message: "boom" } } });
    await expect(
      replayInboundEmails("biz-1", FLOW, { emailLogIds: ["mail-1"] }, db)
    ).rejects.toThrow("replayInboundEmails: boom");
  });

  it("enqueues a backfill run with the live path's dedupe key and stamps the row", async () => {
    const { db, updates } = replayDb({ emailLog: { data: [ROW], error: null } });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-9" });

    const summary = await replayInboundEmails("biz-1", FLOW, { emailLogIds: ["mail-1"] }, db);

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
    const { db } = replayDb({ emailLog: { data: [ROW], error: null } });
    defaultClientSpy.mockResolvedValue(db);
    enqueueAiFlowRun.mockResolvedValue({ id: "run-1" });
    const summary = await replayInboundEmails("biz-1", FLOW, { emailLogIds: ["mail-1"] });
    expect(defaultClientSpy).toHaveBeenCalled();
    expect(summary.enqueued).toBe(1);
  });

  it("skips a message the flow's trigger conditions don't match", async () => {
    const { db } = replayDb({ emailLog: { data: [ROW], error: null } });
    const flow = {
      id: "flow-1",
      definition: {
        trigger: {
          channel: "tenant_email",
          conditions: [{ type: "contains", value: "zillow" }]
        }
      }
    };
    const summary = await replayInboundEmails("biz-1", flow, { emailLogIds: ["mail-1"] }, db);
    expect(summary.skipped).toBe(1);
    expect(summary.outcomes[0]).toEqual({
      emailLogId: "mail-1",
      status: "skipped",
      reason: "the flow's trigger conditions don't match this email"
    });
    expect(enqueueAiFlowRun).not.toHaveBeenCalled();
  });

  it("ORs across the flow's tenant_email triggers (extra-trigger conditions match)", async () => {
    const { db } = replayDb({ emailLog: { data: [ROW], error: null } });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-9" });
    const flow = {
      id: "flow-1",
      definition: {
        trigger: {
          channel: "tenant_email",
          conditions: [{ type: "contains", value: "zillow" }]
        },
        triggers: [
          { channel: "sms" },
          { channel: "tenant_email", conditions: [{ type: "from_matches", value: "privyr.com" }] }
        ]
      }
    };
    const summary = await replayInboundEmails("biz-1", flow, { emailLogIds: ["mail-1"] }, db);
    expect(summary.enqueued).toBe(1);
  });

  it("resolves from_matches contact refs against live rows (match fires)", async () => {
    const { db } = replayDb({
      emailLog: { data: [ROW], error: null },
      contacts: {
        data: { customer_e164: "+14165550001", alias_e164s: [], email: "alerts-noreply@privyr.com" },
        error: null
      }
    });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-9" });
    const flow = {
      id: "flow-1",
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
    };
    const summary = await replayInboundEmails("biz-1", flow, { emailLogIds: ["mail-1"] }, db);
    expect(summary.enqueued).toBe(1);
  });

  it("fails CLOSED when a from_matches ref cannot be resolved", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = replayDb({
      emailLog: { data: [ROW], error: null },
      contacts: { data: null, error: { message: "boom" } }
    });
    const flow = {
      id: "flow-1",
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
    };
    const summary = await replayInboundEmails("biz-1", flow, { emailLogIds: ["mail-1"] }, db);
    expect(summary.skipped).toBe(1);
    expect(enqueueAiFlowRun).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("re-stamps the log row on a dedupe hit using the existing run's id", async () => {
    const { db, updates } = replayDb({
      emailLog: { data: [ROW], error: null },
      runLookup: { data: { id: "run-live", status: "done" }, error: null }
    });
    enqueueAiFlowRun.mockResolvedValue(null);
    const summary = await replayInboundEmails("biz-1", FLOW, { emailLogIds: ["mail-1"] }, db);
    expect(summary.duplicates).toBe(1);
    expect(summary.outcomes[0]).toEqual({ emailLogId: "mail-1", status: "duplicate" });
    expect(updates).toEqual([{ flow_id: "flow-1", run_id: "run-live" }]);
  });

  it("reports a key-holding failed run as an error and leaves the row unstamped", async () => {
    for (const status of ["failed", "canceled"]) {
      const { db, updates } = replayDb({
        emailLog: { data: [ROW], error: null },
        runLookup: { data: { id: "run-dead", status }, error: null }
      });
      enqueueAiFlowRun.mockResolvedValue(null);
      const summary = await replayInboundEmails("biz-1", FLOW, { emailLogIds: ["mail-1"] }, db);
      expect(summary.errors).toBe(1);
      expect(summary.duplicates).toBe(0);
      expect(summary.outcomes[0]).toEqual({
        emailLogId: "mail-1",
        status: "error",
        reason:
          "an earlier run for this email failed and still holds its slot — check the flow's runs page"
      });
      expect(updates).toEqual([]);
    }
  });

  it("leaves a dedupe hit unstamped when the existing run can't be found", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = replayDb({
      emailLog: { data: [ROW], error: null },
      runLookup: { data: null, error: null }
    });
    enqueueAiFlowRun.mockResolvedValue(null);
    await replayInboundEmails("biz-1", FLOW, { emailLogIds: ["mail-1"] }, missing.db);
    expect(missing.updates).toEqual([]);

    const failing = replayDb({
      emailLog: { data: [ROW], error: null },
      runLookup: { data: null, error: { message: "rls" } }
    });
    enqueueAiFlowRun.mockResolvedValue(null);
    await replayInboundEmails("biz-1", FLOW, { emailLogIds: ["mail-1"] }, failing.db);
    expect(failing.updates).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith("replayInboundEmails duplicate lookup", "rls");
    errorSpy.mockRestore();
  });

  it("skips ids that are not unmatched inbound AI-mailbox rows", async () => {
    const { db } = replayDb({ emailLog: { data: [], error: null } });
    const summary = await replayInboundEmails(
      "biz-1",
      FLOW,
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
    const { db } = replayDb({
      emailLog: {
        data: [
          { ...ROW, id: "mail-empty", subject: null, body_full: null, body_preview: "   " },
          { ...ROW, id: "mail-null", subject: "  ", body_full: null, body_preview: null }
        ],
        error: null
      }
    });
    const summary = await replayInboundEmails(
      "biz-1",
      FLOW,
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
    const { db } = replayDb({ emailLog: { data: null, error: null } });
    const summary = await replayInboundEmails("biz-1", FLOW, { emailLogIds: ["mail-1"] }, db);
    expect(summary.skipped).toBe(1);
  });

  it("falls back to body_preview, a log-row message id, and no sender/recipient", async () => {
    const { db } = replayDb({
      emailLog: {
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
      }
    });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-2" });
    const summary = await replayInboundEmails("biz-1", FLOW, { emailLogIds: ["mail-2"] }, db);
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
    const { db } = replayDb({ emailLog: { data: [{ ...ROW, attachments }], error: null } });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-3" });
    await replayInboundEmails("biz-1", FLOW, { emailLogIds: ["mail-1"] }, db);
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
    const { db } = replayDb({ emailLog: { data: rows, error: null } });
    enqueueAiFlowRun
      .mockRejectedValueOnce(new Error("telnyx down"))
      .mockRejectedValueOnce("weird")
      .mockResolvedValueOnce({ id: "run-c" });
    const summary = await replayInboundEmails(
      "biz-1",
      FLOW,
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
    const { db } = replayDb({
      emailLog: { data: [ROW], error: null },
      update: { error: { message: "rls" } }
    });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-9" });
    const summary = await replayInboundEmails("biz-1", FLOW, { emailLogIds: ["mail-1"] }, db);
    expect(summary.enqueued).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("replayInboundEmails stamp", "rls");
    errorSpy.mockRestore();
  });

  it("dedupes repeated ids and caps a request at MAX_REPLAY_EMAILS", async () => {
    const ids = Array.from({ length: MAX_REPLAY_EMAILS + 20 }, (_, i) => `mail-${i}`);
    const { db } = replayDb({ emailLog: { data: [], error: null } });
    const summary = await replayInboundEmails(
      "biz-1",
      FLOW,
      { emailLogIds: [...ids, "mail-0", "mail-1"] },
      db
    );
    expect(summary.total).toBe(MAX_REPLAY_EMAILS);
    expect(summary.skipped).toBe(MAX_REPLAY_EMAILS);
  });
});
