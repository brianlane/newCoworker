/**
 * start_aiflow_for_contact — the texting coworker's ONLY path into AiFlows
 * (src/lib/ai-flows/agent-start-flow.ts).
 *
 * The customer-facing SMS persona is deliberately barred from the owner's
 * automations (rowboat-gates.ts: "customers must never enumerate or start
 * the owner's automations"). This tool is the narrow, double-gated
 * exception: it may enroll ONLY the current texter, ONLY into flows the
 * owner explicitly flagged `options.agentInvocable`, and NEVER when that
 * person already has a live run of the flow (the loop guard — a flow-sent
 * text must not cause the model to re-enroll the same contact).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn() }));

import {
  startAiflowForContactArgsSchema,
  startAiFlowForContactTool,
  type AgentStartFlowDeps
} from "@/lib/ai-flows/agent-start-flow";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { hasActiveRunForLead } from "../supabase/functions/_shared/ai_flows/reentry";
import { recordSystemLog } from "@/lib/db/system-logs";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PHONE = "+17808039935";

function flowRow(over: Record<string, unknown> = {}) {
  return {
    id: "flow-1",
    business_id: BIZ,
    name: "Rebook follow-up",
    enabled: true,
    definition: {
      version: 1,
      trigger: { channel: "manual" },
      steps: [{ id: "s1", type: "send_sms", to: "{{vars.lead_phone}}", body: "hi" }],
      options: { agentInvocable: true }
    },
    ...over
  } as never;
}

function deps(overrides: Partial<AgentStartFlowDeps> = {}): AgentStartFlowDeps {
  return {
    listFlows: vi.fn().mockResolvedValue([flowRow()]),
    enqueueFlowRun: vi.fn().mockResolvedValue({ id: "run-1" }),
    hasLiveRun: vi.fn().mockResolvedValue(false),
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("options.agentInvocable schema flag", () => {
  it("parseAiFlowDefinition keeps the flag", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "manual" },
      steps: [{ id: "s1", type: "notify_owner", message: "x" }],
      options: { agentInvocable: true }
    });
    expect(def.options?.agentInvocable).toBe(true);
  });

  it("rejects a non-boolean flag", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "manual" },
        steps: [{ id: "s1", type: "notify_owner", message: "x" }],
        options: { agentInvocable: "yes" }
      })
    ).toThrow();
  });
});

describe("startAiflowForContactArgsSchema", () => {
  it("accepts a flow ref + E.164 phone + optional reason", () => {
    expect(
      startAiflowForContactArgsSchema.safeParse({
        flow: "Rebook follow-up",
        phone: PHONE,
        reason: "asked to rebook"
      }).success
    ).toBe(true);
  });

  it("rejects a non-E.164 phone (the model must pass the texter's exact number)", () => {
    expect(
      startAiflowForContactArgsSchema.safeParse({ flow: "x", phone: "780-803-9935" }).success
    ).toBe(false);
  });
});

describe("startAiFlowForContactTool refusal matrix", () => {
  it("refuses an unknown flow with steering", async () => {
    const d = deps({ listFlows: vi.fn().mockResolvedValue([]) });
    const out = await startAiFlowForContactTool(BIZ, { flow: "nope", phone: PHONE }, d);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("No automation you may start matches");
    expect(d.enqueueFlowRun).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous ref, naming the candidates", async () => {
    const d = deps({
      listFlows: vi
        .fn()
        .mockResolvedValue([
          flowRow({ id: "f1", name: "Rebook follow-up A" }),
          flowRow({ id: "f2", name: "Rebook follow-up B" })
        ])
    });
    const out = await startAiFlowForContactTool(BIZ, { flow: "rebook", phone: PHONE }, d);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("matches 2");
  });

  it("a disabled flow is INVISIBLE — same generic refusal as an unknown name", async () => {
    const d = deps({ listFlows: vi.fn().mockResolvedValue([flowRow({ enabled: false })]) });
    const out = await startAiFlowForContactTool(
      BIZ,
      { flow: "Rebook follow-up", phone: PHONE },
      d
    );
    expect(out.ok).toBe(false);
    // The refusal must not confirm the flow exists (name-enumeration guard).
    if (!out.ok) expect(out.message).toContain("No automation you may start matches");
  });

  it("an unflagged flow is INVISIBLE — refusal text never leaks owner-only names", async () => {
    const d = deps({
      listFlows: vi.fn().mockResolvedValue([
        flowRow({
          name: "Secret owner-only winback",
          definition: {
            version: 1,
            trigger: { channel: "manual" },
            steps: [{ id: "s1", type: "notify_owner", message: "x" }],
            options: { suppressDefaultReply: true }
          }
        })
      ])
    });
    const out = await startAiFlowForContactTool(
      BIZ,
      // A guessed partial ref that WOULD match the owner-only flow by name.
      { flow: "winback", phone: PHONE },
      d
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toContain("No automation you may start matches");
      expect(out.message).not.toContain("Secret owner-only winback");
    }
    expect(d.enqueueFlowRun).not.toHaveBeenCalled();
  });

  it("ambiguity messages can only ever name agent-invocable flows", async () => {
    const d = deps({
      listFlows: vi
        .fn()
        .mockResolvedValue([
          flowRow({ id: "f1", name: "Rebook follow-up A" }),
          flowRow({ id: "f2", name: "Rebook follow-up B" }),
          flowRow({
            id: "f3",
            name: "Rebook secret internal",
            definition: {
              version: 1,
              trigger: { channel: "manual" },
              steps: [{ id: "s1", type: "notify_owner", message: "x" }],
              options: {}
            }
          })
        ])
    });
    const out = await startAiFlowForContactTool(BIZ, { flow: "rebook", phone: PHONE }, d);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toContain("matches 2");
      expect(out.message).not.toContain("Rebook secret internal");
    }
  });

  it("refuses voice flows (they run on the call path)", async () => {
    const d = deps({
      listFlows: vi.fn().mockResolvedValue([
        flowRow({
          definition: {
            version: 1,
            trigger: { channel: "voice", fromE164: "+15550001111" },
            steps: [{ id: "s1", type: "notify_owner", message: "x" }],
            options: { agentInvocable: true }
          }
        })
      ])
    });
    const out = await startAiFlowForContactTool(
      BIZ,
      { flow: "Rebook follow-up", phone: PHONE },
      d
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("voice");
  });

  it("refuses when the texter already has a LIVE run of the flow (loop guard)", async () => {
    const d = deps({ hasLiveRun: vi.fn().mockResolvedValue(true) });
    const out = await startAiFlowForContactTool(
      BIZ,
      { flow: "Rebook follow-up", phone: PHONE },
      d
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("already");
    expect(d.hasLiveRun).toHaveBeenCalledWith(BIZ, "flow-1", PHONE);
    expect(d.enqueueFlowRun).not.toHaveBeenCalled();
  });
});

describe("startAiFlowForContactTool success path", () => {
  it("enqueues a run for exactly the current texter, attributed to the sms coworker", async () => {
    const d = deps();
    const out = await startAiFlowForContactTool(
      BIZ,
      { flow: "Rebook follow-up", phone: PHONE, reason: "asked to rebook after a no-show" },
      d
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.runId).toBe("run-1");
      expect(out.flowName).toBe("Rebook follow-up");
    }
    const input = vi.mocked(d.enqueueFlowRun!).mock.calls[0][0] as {
      businessId: string;
      flowId: string;
      trigger: Record<string, unknown>;
      vars?: Record<string, unknown>;
      dedupeKey?: string | null;
    };
    expect(input.businessId).toBe(BIZ);
    expect(input.flowId).toBe("flow-1");
    // Identity rides the trigger sender AND a seeded lead_phone var, so
    // {{vars.lead_phone}} sends, reentry checks, and stop-on-response all
    // see the texter without an extraction step.
    expect(input.trigger.channel).toBe("manual");
    expect(input.trigger.from).toBe(PHONE);
    expect(input.trigger.started_by).toBe("sms_coworker");
    expect(String(input.trigger.windowText)).toContain(`phone: ${PHONE}`);
    expect(String(input.trigger.windowText)).toContain("asked to rebook after a no-show");
    expect(input.vars).toMatchObject({ lead_phone: PHONE });
    expect(String(input.dedupeKey)).toMatch(/^agent:/);
    // Attribution lands in system logs for the run history.
    expect(vi.mocked(recordSystemLog)).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai_flow_run_enqueued_by_sms_coworker" })
    );
  });

  it("resolves by exact id and by unique substring", async () => {
    const d = deps();
    expect((await startAiFlowForContactTool(BIZ, { flow: "flow-1", phone: PHONE }, d)).ok).toBe(
      true
    );
    expect((await startAiFlowForContactTool(BIZ, { flow: "rebook", phone: PHONE }, d)).ok).toBe(
      true
    );
  });

  it("treats a null enqueue (re-entry/dedupe blocked) as already-enrolled, not success", async () => {
    const d = deps({ enqueueFlowRun: vi.fn().mockResolvedValue(null) });
    const out = await startAiFlowForContactTool(
      BIZ,
      { flow: "Rebook follow-up", phone: PHONE },
      d
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("already");
  });
});

describe("hasActiveRunForLead (shared reentry helper)", () => {
  type QueuedResult = { data?: unknown; error?: { message: string } | null };

  /** Chainable fake: every ai_flow_runs/contacts query resolves the queued result. */
  function fakeDb(queues: Record<string, QueuedResult[]>) {
    return {
      from(table: string) {
        const q = queues[table] ?? [];
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "eq", "or", "in", "not", "limit"]) {
          (chain as Record<string, (...a: unknown[]) => unknown>)[m] = () => chain;
        }
        (chain as { then: unknown }).then = (
          resolve: (v: { data: unknown; error: unknown }) => unknown
        ) => {
          const r = q.shift() ?? { data: [], error: null };
          // Pass an explicit null through (a real PostgREST "no rows" shape).
          return Promise.resolve(
            resolve({ data: r.data === undefined ? [] : r.data, error: r.error ?? null })
          );
        };
        return chain;
      }
    } as never;
  }

  it("true when a live (non-terminal) run matches the contact", async () => {
    const db = fakeDb({
      contacts: [{ data: [] }],
      ai_flow_runs: [{ data: [{ id: "r1", status: "awaiting_reply", context: {} }] }]
    });
    expect(await hasActiveRunForLead(db, BIZ, "flow-1", PHONE)).toBe(true);
  });

  it("false when nothing live matches, and fails OPEN on lookup errors", async () => {
    const none = fakeDb({ contacts: [{ data: [] }], ai_flow_runs: [{ data: [] }] });
    expect(await hasActiveRunForLead(none, BIZ, "flow-1", PHONE)).toBe(false);
    const errored = fakeDb({
      contacts: [{ data: [] }],
      ai_flow_runs: [{ error: { message: "boom" }, data: null }]
    });
    expect(await hasActiveRunForLead(errored, BIZ, "flow-1", PHONE)).toBe(false);
    // A null (no-rows) payload with no error is also "nothing live".
    const nullData = fakeDb({ contacts: [{ data: [] }], ai_flow_runs: [{ data: null }] });
    expect(await hasActiveRunForLead(nullData, BIZ, "flow-1", PHONE)).toBe(false);
  });

  it("false for an empty key (nothing to match on)", async () => {
    expect(await hasActiveRunForLead(fakeDb({}), BIZ, "flow-1", "")).toBe(false);
  });

  it("fails OPEN when the client itself throws", async () => {
    const throwing = {
      from() {
        throw new Error("client exploded");
      }
    } as never;
    expect(await hasActiveRunForLead(throwing, BIZ, "flow-1", PHONE)).toBe(false);
  });

  it("a live TEST run does not count (defense in depth behind the query filter)", async () => {
    const db = fakeDb({
      contacts: [{ data: [] }],
      ai_flow_runs: [
        { data: [{ id: "r1", status: "queued", context: { trigger: { test_mode: true } } }] }
      ]
    });
    expect(await hasActiveRunForLead(db, BIZ, "flow-1", PHONE)).toBe(false);
  });
});
