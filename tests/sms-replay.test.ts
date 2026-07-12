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
  MAX_REPLAY_SMS,
  flowHasSmsTrigger,
  replayInboundSms,
  smsTriggersOf
} from "@/lib/sms/replay";
import { BACKFILL_SKIP_EXISTING_TRIGGER_KEY } from "../supabase/functions/_shared/ai_flows/backfill";

type Result = { data: unknown; error: { message: string } | null };

/**
 * Table-aware db stub for the SMS replay's four query shapes:
 *  - sms_inbound_jobs select (.select().eq().is().gte().order().limit() → `jobs`)
 *  - ai_flow_runs wait-consumption select (…in().gte().limit() → `waitRuns`)
 *  - ai_flow_runs dedupe lookup (.maybeSingle() → `runLookup`)
 *  - contacts select (from_matches ref resolution .maybeSingle() → `contacts`)
 */
function replayDb(opts: {
  jobs: Result;
  waitRuns?: Result;
  runLookup?: Result;
  contacts?: Result;
}) {
  const isFilters: [string, unknown][] = [];
  const from = vi.fn((table: string) => {
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.in = vi.fn(() => builder);
    builder.is = vi.fn((col: string, v: unknown) => {
      isFilters.push([col, v]);
      return builder;
    });
    builder.gte = vi.fn(() => builder);
    builder.order = vi.fn(() => builder);
    builder.limit = vi.fn(() =>
      Promise.resolve(
        table === "ai_flow_runs" ? (opts.waitRuns ?? { data: [], error: null }) : opts.jobs
      )
    );
    builder.maybeSingle = vi.fn(() =>
      Promise.resolve(
        table === "ai_flow_runs"
          ? (opts.runLookup ?? { data: null, error: null })
          : (opts.contacts ?? { data: null, error: null })
      )
    );
    return builder;
  });
  return { db: { from } as never, isFilters };
}

/** One persisted Telnyx inbound envelope, as sms_inbound_jobs stores it. */
function job(
  id: string,
  opts: {
    from?: string | null;
    text?: string;
    atMsAgo?: number;
    eventId?: string | null;
    to?: string;
    cc?: string[];
    createdAt?: string;
  } = {}
) {
  const payload: Record<string, unknown> = {
    ...(opts.from !== null
      ? { from: { phone_number: opts.from ?? "+14165550001" } }
      : {}),
    to: [{ phone_number: opts.to ?? "+18885550100" }],
    ...(opts.cc ? { cc: opts.cc.map((n) => ({ phone_number: n })) } : {}),
    text: opts.text ?? "hi there"
  };
  return {
    id,
    payload: {
      data: {
        ...(opts.eventId === null ? {} : { id: opts.eventId ?? `evt-${id}` }),
        payload
      }
    },
    created_at:
      opts.createdAt ?? new Date(Date.now() - (opts.atMsAgo ?? 60_000)).toISOString()
  };
}

/** A flow whose single SMS trigger has no conditions — matches every text. */
const FLOW = {
  id: "flow-1",
  definition: { trigger: { channel: "sms", conditions: [] } }
};

beforeEach(() => {
  defaultClientSpy.mockReset();
  enqueueAiFlowRun.mockReset();
  recordSystemLog.mockReset();
  recordSystemLog.mockResolvedValue(undefined);
});

describe("smsTriggersOf / flowHasSmsTrigger", () => {
  it("collects the primary and extra sms triggers, in order", () => {
    const def = {
      trigger: { channel: "sms", conditions: [{ type: "contains", value: "a" }] },
      triggers: [
        { channel: "tenant_email", conditions: [] },
        { channel: "sms", conditions: [] }
      ]
    };
    expect(smsTriggersOf(def)).toHaveLength(2);
    expect(flowHasSmsTrigger(def)).toBe(true);
  });

  it("drops malformed sms triggers (no conditions array) and non-sms channels", () => {
    expect(smsTriggersOf({ trigger: { channel: "sms" } })).toHaveLength(0);
    expect(smsTriggersOf({ trigger: { channel: "webhook", conditions: [] } })).toHaveLength(0);
    expect(smsTriggersOf(null)).toHaveLength(0);
    expect(flowHasSmsTrigger({ trigger: { channel: "webhook", conditions: [] } })).toBe(false);
  });
});

describe("replayInboundSms", () => {
  it("returns an empty summary without touching the db when the flow has no sms trigger", async () => {
    const { db } = replayDb({ jobs: { data: [], error: null } });
    const summary = await replayInboundSms(
      "biz-1",
      { id: "flow-1", definition: { trigger: { channel: "webhook", conditions: [] } } },
      { lookbackHours: 24 },
      db
    );
    expect(summary).toEqual({
      total: 0,
      enqueued: 0,
      duplicates: 0,
      skipped: 0,
      errors: 0,
      truncated: false,
      outcomes: []
    });
    expect(recordSystemLog).not.toHaveBeenCalled();
  });

  it("throws when the sms_inbound_jobs read fails", async () => {
    const { db } = replayDb({ jobs: { data: null, error: { message: "boom" } } });
    await expect(
      replayInboundSms("biz-1", FLOW, { lookbackHours: 24 }, db)
    ).rejects.toThrow("replayInboundSms: boom");
  });

  it("returns early (no system log) when the window holds no texts", async () => {
    const { db } = replayDb({ jobs: { data: null, error: null } });
    const summary = await replayInboundSms("biz-1", FLOW, { lookbackHours: 24 }, db);
    expect(summary.total).toBe(0);
    expect(recordSystemLog).not.toHaveBeenCalled();
  });

  it("enqueues a backfill run with the live trigger-scope shape and event-id dedupe key", async () => {
    const { db, isFilters } = replayDb({
      jobs: {
        data: [
          job("j1", {
            text: "I need a quote https://x.example/a",
            // "+1 416 555 0001" re-normalizes to the sender (duplicate, dropped);
            // "junk" is unparseable (dropped).
            cc: ["+14165550002", "+1 416 555 0001", "junk"]
          })
        ],
        error: null
      }
    });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-9" });

    const summary = await replayInboundSms("biz-1", FLOW, { lookbackHours: 24 }, db);

    expect(summary.enqueued).toBe(1);
    expect(summary.truncated).toBe(false);
    expect(summary.outcomes).toEqual([{ jobId: "j1", status: "enqueued", runId: "run-9" }]);
    // Staff (owner/team) texts never trigger flows on the live path, so the
    // replay's read excludes them at the query.
    expect(isFilters).toContainEqual(["staff_kind", null]);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      {
        businessId: "biz-1",
        flowId: "flow-1",
        dedupeKey: "evt-j1",
        trigger: {
          url: "https://x.example/a",
          windowText: "I need a quote https://x.example/a",
          from: "+14165550001",
          to: "+18885550100",
          participants: ["+14165550001", "+18885550100", "+14165550002"],
          group: true,
          event_id: "evt-j1",
          image: "",
          [BACKFILL_SKIP_EXISTING_TRIGGER_KEY]: "1"
        }
      },
      db
    );
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai_flow_sms_replay" }),
      db
    );
  });

  it("uses the default service client when none is passed", async () => {
    const { db } = replayDb({ jobs: { data: [job("j1")], error: null } });
    defaultClientSpy.mockResolvedValue(db);
    enqueueAiFlowRun.mockResolvedValue({ id: "run-1" });
    const summary = await replayInboundSms("biz-1", FLOW, { lookbackHours: 24 });
    expect(defaultClientSpy).toHaveBeenCalled();
    expect(summary.enqueued).toBe(1);
  });

  it("skips texts the flow's trigger conditions don't match (two-person thread, no group)", async () => {
    const { db } = replayDb({
      jobs: { data: [job("j1", { text: "just saying hi" })], error: null }
    });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-9" });
    const flow = {
      id: "flow-1",
      definition: {
        trigger: { channel: "sms", conditions: [{ type: "contains", value: "zillow" }] },
        triggers: [{ channel: "sms", conditions: [{ type: "contains", value: "quote" }] }]
      }
    };
    const summary = await replayInboundSms("biz-1", flow, { lookbackHours: 24 }, db);
    expect(summary.skipped).toBe(1);
    expect(summary.outcomes[0]).toEqual({
      jobId: "j1",
      status: "skipped",
      reason: "the flow's trigger conditions don't match this text"
    });
    expect(enqueueAiFlowRun).not.toHaveBeenCalled();

    // Second pass: the extra trigger's "quote" condition matches (OR set),
    // and a 1:1 thread is not a group.
    const { db: db2 } = replayDb({
      jobs: { data: [job("j2", { text: "please send a quote" })], error: null }
    });
    const summary2 = await replayInboundSms("biz-1", flow, { lookbackHours: 24 }, db2);
    expect(summary2.enqueued).toBe(1);
    const call = enqueueAiFlowRun.mock.calls[0][0] as { trigger: Record<string, unknown> };
    expect(call.trigger.group).toBe(false);
  });

  it("combines a sender's earlier texts inside the correlation window", async () => {
    // Two texts 2 minutes apart: the newer one alone lacks "quote", but the
    // combined window text carries it — exactly how the live path matched.
    const { db } = replayDb({
      jobs: {
        data: [
          job("j-new", { text: "the link is https://x.example/b", atMsAgo: 60_000 }),
          job("j-old", { text: "I want a quote", atMsAgo: 180_000 })
        ],
        error: null
      }
    });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-1" });
    const flow = {
      id: "flow-1",
      definition: {
        trigger: {
          channel: "sms",
          correlationWindowMinutes: 10,
          conditions: [
            { type: "contains", value: "quote" },
            { type: "has_url" }
          ]
        }
      }
    };
    const summary = await replayInboundSms("biz-1", flow, { lookbackHours: 24 }, db);
    // The old text alone doesn't match (no URL yet); the new one matches on
    // the combined window.
    expect(summary.enqueued).toBe(1);
    expect(summary.skipped).toBe(1);
    const enq = enqueueAiFlowRun.mock.calls[0][0] as { trigger: { windowText: string } };
    expect(enq.trigger.windowText).toBe("I want a quote\nthe link is https://x.example/b");
  });

  it("skips a text with no usable sender and tolerates a malformed envelope", async () => {
    const rows = [
      job("j-nofrom", { from: null }),
      // Envelope missing data.payload entirely + no event id + bad timestamp:
      // parsed defensively (fallback event key, now() timestamp), then skipped
      // for having no sender.
      { id: "j-bare", payload: {}, created_at: "not-a-date" }
    ];
    const { db } = replayDb({ jobs: { data: rows, error: null } });
    const summary = await replayInboundSms("biz-1", FLOW, { lookbackHours: 24 }, db);
    expect(summary.skipped).toBe(2);
    expect(summary.outcomes.every((o) => o.reason === "no usable sender")).toBe(true);
  });

  it("skips a text that answered a parked wait_for_reply (live-parity turn ownership)", async () => {
    const { db } = replayDb({
      jobs: {
        data: [
          job("j-reply", { text: "yes, tomorrow works", atMsAgo: 30_000 }),
          job("j-fresh", { text: "hi, I need a quote", atMsAgo: 60_000 })
        ],
        error: null
      },
      waitRuns: {
        data: [
          {
            context: {
              waiting_reply: { result: "reply", from: "+14165550001", save_as: "lead_reply" },
              vars: { lead_reply: "yes, tomorrow works" }
            }
          },
          // Defensive rows the scan must tolerate: no context, no from, a
          // blank save_as falling back to reply_text, and a non-string value.
          { context: null },
          { context: { waiting_reply: { result: "reply", save_as: "x" }, vars: { x: "y" } } },
          {
            context: {
              waiting_reply: { result: "reply", from: "+14165550001", save_as: "  " },
              vars: { reply_text: 42 }
            }
          }
        ],
        error: null
      }
    });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-1" });
    const summary = await replayInboundSms("biz-1", FLOW, { lookbackHours: 24 }, db);
    expect(summary.skipped).toBe(1);
    expect(summary.outcomes).toEqual([
      { jobId: "j-fresh", status: "enqueued", runId: "run-1" },
      {
        jobId: "j-reply",
        status: "skipped",
        reason: "this text answered a flow that was waiting for the sender's reply"
      }
    ]);
  });

  it("tolerates a null wait-consumption payload", async () => {
    const { db } = replayDb({
      jobs: { data: [job("j1")], error: null },
      waitRuns: { data: null, error: null }
    });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-1" });
    const summary = await replayInboundSms("biz-1", FLOW, { lookbackHours: 24 }, db);
    expect(summary.enqueued).toBe(1);
  });

  it("fails loudly when the wait-consumption read fails", async () => {
    const { db } = replayDb({
      jobs: { data: [job("j1")], error: null },
      waitRuns: { data: null, error: { message: "boom" } }
    });
    await expect(
      replayInboundSms("biz-1", FLOW, { lookbackHours: 24 }, db)
    ).rejects.toThrow("replayInboundSms: wait-consumption read: boom");
    expect(enqueueAiFlowRun).not.toHaveBeenCalled();
  });

  it("fails CLOSED when a from_matches ref cannot be resolved", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = replayDb({
      jobs: { data: [job("j1")], error: null },
      contacts: { data: null, error: { message: "boom" } }
    });
    const flow = {
      id: "flow-1",
      definition: {
        trigger: {
          channel: "sms",
          conditions: [
            {
              type: "from_matches",
              ref: { source: "contact", id: "22222222-2222-4222-8222-222222222222" }
            }
          ]
        }
      }
    };
    const summary = await replayInboundSms("biz-1", flow, { lookbackHours: 24 }, db);
    expect(summary.skipped).toBe(1);
    expect(enqueueAiFlowRun).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("resolves from_matches contact refs against live rows (match fires)", async () => {
    const { db } = replayDb({
      jobs: { data: [job("j1")], error: null },
      contacts: {
        data: { customer_e164: "+14165550001", alias_e164s: [], email: null },
        error: null
      }
    });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-1" });
    const flow = {
      id: "flow-1",
      definition: {
        trigger: {
          channel: "sms",
          conditions: [
            {
              type: "from_matches",
              ref: { source: "contact", id: "22222222-2222-4222-8222-222222222222" }
            }
          ]
        }
      }
    };
    const summary = await replayInboundSms("biz-1", flow, { lookbackHours: 24 }, db);
    expect(summary.enqueued).toBe(1);
  });

  it("counts a live-handled text (dedupe hit on a healthy run) as a duplicate", async () => {
    const { db } = replayDb({
      jobs: { data: [job("j1")], error: null },
      runLookup: { data: { id: "run-live", status: "done" }, error: null }
    });
    enqueueAiFlowRun.mockResolvedValue(null);
    const summary = await replayInboundSms("biz-1", FLOW, { lookbackHours: 24 }, db);
    expect(summary.duplicates).toBe(1);
    expect(summary.outcomes[0]).toEqual({ jobId: "j1", status: "duplicate" });
  });

  it("reports a key-holding failed/canceled run as an error", async () => {
    for (const status of ["failed", "canceled"]) {
      enqueueAiFlowRun.mockReset();
      enqueueAiFlowRun.mockResolvedValue(null);
      const { db } = replayDb({
        jobs: { data: [job("j1")], error: null },
        runLookup: { data: { id: "run-dead", status }, error: null }
      });
      const summary = await replayInboundSms("biz-1", FLOW, { lookbackHours: 24 }, db);
      expect(summary.errors).toBe(1);
      expect(summary.outcomes[0]).toEqual({
        jobId: "j1",
        status: "error",
        reason:
          "an earlier run for this text failed and still holds its slot — check the flow's runs page"
      });
    }
  });

  it("treats a failed duplicate lookup as a plain duplicate (logged)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = replayDb({
      jobs: { data: [job("j1")], error: null },
      runLookup: { data: null, error: { message: "rls" } }
    });
    enqueueAiFlowRun.mockResolvedValue(null);
    const summary = await replayInboundSms("biz-1", FLOW, { lookbackHours: 24 }, db);
    expect(summary.duplicates).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("replayInboundSms duplicate lookup", "rls");
    errorSpy.mockRestore();
  });

  it("keeps going when one text's enqueue fails (Error and non-Error)", async () => {
    const { db } = replayDb({
      jobs: {
        data: [
          job("j3", { atMsAgo: 30_000 }),
          job("j2", { atMsAgo: 60_000 }),
          job("j1", { atMsAgo: 90_000 })
        ],
        error: null
      }
    });
    enqueueAiFlowRun
      .mockRejectedValueOnce(new Error("telnyx down"))
      .mockRejectedValueOnce("weird")
      .mockResolvedValueOnce({ id: "run-3" });
    const summary = await replayInboundSms("biz-1", FLOW, { lookbackHours: 24 }, db);
    expect(summary.errors).toBe(2);
    expect(summary.enqueued).toBe(1);
    expect(summary.outcomes).toEqual([
      { jobId: "j1", status: "error", reason: "telnyx down" },
      { jobId: "j2", status: "error", reason: "Unexpected error" },
      { jobId: "j3", status: "enqueued", runId: "run-3" }
    ]);
  });

  it("only evaluates texts inside the lookback window (older rows are context)", async () => {
    // lookbackHours clamps up from 0 to 1h; the old row (2h ago) is loaded
    // as correlation context only and never gets an outcome.
    const { db } = replayDb({
      jobs: {
        data: [
          job("j-in", { atMsAgo: 10 * 60_000 }),
          job("j-ctx", { atMsAgo: 2 * 3_600_000 })
        ],
        error: null
      }
    });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-1" });
    const summary = await replayInboundSms("biz-1", FLOW, { lookbackHours: 0 }, db);
    expect(summary.total).toBe(1);
    expect(summary.outcomes).toEqual([{ jobId: "j-in", status: "enqueued", runId: "run-1" }]);
  });

  it("caps a request at the newest MAX_REPLAY_SMS texts and reports truncation", async () => {
    const rows = Array.from({ length: MAX_REPLAY_SMS + 10 }, (_, i) =>
      job(`j${i}`, { atMsAgo: (i + 1) * 1000, eventId: `evt-${i}` })
    );
    const { db } = replayDb({ jobs: { data: rows, error: null } });
    enqueueAiFlowRun.mockResolvedValue(null);
    const summary = await replayInboundSms("biz-1", FLOW, { lookbackHours: 24 }, db);
    expect(summary.total).toBe(MAX_REPLAY_SMS);
    expect(summary.truncated).toBe(true);
    // The DROPPED ones are the oldest (highest atMsAgo).
    expect(summary.outcomes.some((o) => o.jobId === `j${MAX_REPLAY_SMS + 9}`)).toBe(false);
    expect(summary.outcomes.some((o) => o.jobId === "j0")).toBe(true);
  });

  it("reports truncation when the row load maxes out before reaching the cutoff", async () => {
    // 300 loaded rows (the load cap), only 50 of them inside the window:
    // older in-window texts may exist beyond the cap, so the summary must
    // say so rather than read as complete.
    const rows = [
      ...Array.from({ length: 50 }, (_, i) =>
        job(`in${i}`, { atMsAgo: (i + 1) * 1000, eventId: `evt-in-${i}` })
      ),
      ...Array.from({ length: 250 }, (_, i) =>
        job(`ctx${i}`, { atMsAgo: 3_600_000 + (i + 1) * 1000, eventId: `evt-ctx-${i}` })
      )
    ];
    const { db } = replayDb({ jobs: { data: rows, error: null } });
    enqueueAiFlowRun.mockResolvedValue(null);
    const summary = await replayInboundSms("biz-1", FLOW, { lookbackHours: 1 }, db);
    expect(summary.total).toBe(50);
    expect(summary.truncated).toBe(true);
  });

  it("falls back to a stable per-row dedupe key when the envelope has no event id", async () => {
    const { db } = replayDb({ jobs: { data: [job("j1", { eventId: null })], error: null } });
    enqueueAiFlowRun.mockResolvedValue({ id: "run-1" });
    await replayInboundSms("biz-1", FLOW, { lookbackHours: 24 }, db);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: "sms-log:j1" }),
      db
    );
  });
});
