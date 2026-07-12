import { beforeAll, describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ageRun,
  createFlow,
  enqueueRun,
  getContactTags,
  getRun,
  getSteps,
  minutesAgo,
  seedBusiness,
  seedContact,
  serviceDb,
  tickWorker
} from "./harness";

/**
 * The REAL ai-flow-worker against a REAL local Postgres: run claiming,
 * persistence, revision bumps, wait_for_reply park + timeout resume (the
 * `resume_overdue_reply_waits` RPC), sleep deferral via earliest_claim_at,
 * stale-lease reclaim, and test-mode simulation — the layer the in-process
 * suites cannot reach (the Truly incident's dead-end lived exactly in this
 * park/resume state machine).
 *
 * Each test seeds its own business so scenarios are isolated; the local
 * stack is throwaway (fresh `supabase start` per CI run).
 */

const LEAD = "+14165550123";

/**
 * Schema-validated fixture (a broken fixture must fail loudly here). Every
 * flow opens with the extract step real flows use — the semantic validator
 * requires {{vars.lead_phone}} to be produced before it is consumed, and
 * with no GOOGLE_API_KEY in the served worker the extraction falls back to
 * the regex phone scan over the trigger windowText (also a real prod path).
 */
function flow(steps: unknown[]): Record<string, unknown> {
  const def = {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    options: { suppressDefaultReply: false },
    steps: [
      {
        id: "extract",
        type: "extract_text",
        fields: [{ name: "lead_phone", description: "The lead's phone number" }]
      },
      ...steps
    ]
  };
  parseAiFlowDefinition(def);
  return def;
}

/** Steps in `flow()` fixtures sit after the extract step at index 0. */
const STEP_OFFSET = 1;

const TRIGGER = {
  channel: "sms",
  from: LEAD,
  windowText: `New integration lead. Phone: ${LEAD}. Please follow up.`
};

let db: SupabaseClient;

beforeAll(() => {
  db = serviceDb();
});

describe("run persistence", () => {
  it("executes a run to done: step rows, contact write, current_step, revision bump", async () => {
    const biz = await seedBusiness(db, "IT persistence");
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(
      db,
      biz,
      flow([
        { id: "tag", type: "update_contact", addTags: ["Integration"], phoneVar: "lead_phone" },
        { id: "milestone", type: "goal", label: "Reached", events: [{ kind: "replied" }] }
      ])
    );
    // vars deliberately empty: lead_phone must come from the extract step's
    // keyless regex fallback over the trigger windowText (a real prod path).
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);
    const before = await getRun(db, runId);

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    expect(run.current_step).toBe(3);
    expect(run.last_error).toBeNull();
    expect(run.revision).toBeGreaterThan(before.revision);
    expect(run.context.vars?.lead_phone).toBe(LEAD);

    const steps = await getSteps(db, runId);
    expect(steps.map((s) => [s.step_type, s.status])).toEqual([
      ["extract_text", "done"],
      ["update_contact", "done"],
      ["goal", "done"]
    ]);
    expect((steps[2].result as { reached_via?: string }).reached_via).toBe("passed_inline");
    expect(await getContactTags(db, biz, LEAD)).toContain("Integration");
  });

  it("a disabled flow's queued run is canceled, not executed", async () => {
    const biz = await seedBusiness(db, "IT disabled");
    const flowId = await createFlow(
      db,
      biz,
      flow([{ id: "milestone", type: "goal", label: "Never", events: [{ kind: "replied" }] }]),
      false
    );
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);
    await tickWorker();
    const run = await getRun(db, runId);
    expect(run.status).toBe("canceled");
    expect((await getSteps(db, runId)).every((s) => s.status !== "done")).toBe(true);
  });
});

describe("wait_for_reply park + timeout (resume_overdue_reply_waits RPC)", () => {
  it("parks awaiting_reply with a respond-by deadline, then times out into the no-reply branch", async () => {
    const biz = await seedBusiness(db, "IT waits");
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(
      db,
      biz,
      flow([
        {
          id: "wait",
          type: "wait_for_reply",
          saveAs: "reply",
          phoneVar: "lead_phone",
          timeoutMinutes: 30
        },
        {
          id: "tag_noreply",
          type: "update_contact",
          when: { var: "reply", equals: "no_reply" },
          addTags: ["NoReply"],
          phoneVar: "lead_phone"
        },
        {
          id: "tag_replied",
          type: "update_contact",
          when: { var: "reply", notEquals: "no_reply" },
          addTags: ["Replied"],
          phoneVar: "lead_phone"
        }
      ])
    );
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();
    const parked = await getRun(db, runId);
    expect(parked.status).toBe("awaiting_reply");
    expect(parked.respond_by_at).not.toBeNull();
    expect(new Date(parked.respond_by_at!).getTime()).toBeGreaterThan(Date.now());
    expect(parked.context.waiting_reply).toMatchObject({ from: LEAD });

    // Nothing to do while the deadline is in the future.
    await tickWorker();
    expect((await getRun(db, runId)).status).toBe("awaiting_reply");

    // Age the deadline into the past: the next tick's RPC resumes it with
    // the no-reply sentinel and the flow takes the no-reply arm.
    await ageRun(db, runId, { respond_by_at: minutesAgo(5) });
    await tickWorker();
    const done = await getRun(db, runId);
    expect(done.status).toBe("done");
    expect(done.context.vars?.reply).toBe("no_reply");
    const tags = await getContactTags(db, biz, LEAD);
    expect(tags).toContain("NoReply");
    expect(tags).not.toContain("Replied");
    const steps = await getSteps(db, runId);
    expect(steps.find((s) => s.step_index === 2 + STEP_OFFSET)?.status).toBe("skipped");
  });
});

describe("sleep deferral (earliest_claim_at)", () => {
  it("defers the run instead of busy-waiting, and resumes once the deferral lapses", async () => {
    const biz = await seedBusiness(db, "IT sleep");
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(
      db,
      biz,
      flow([
        { id: "nap", type: "sleep", minutes: 45 },
        { id: "tag_awake", type: "update_contact", addTags: ["Awake"], phoneVar: "lead_phone" }
      ])
    );
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();
    const deferred = await getRun(db, runId);
    expect(deferred.status).toBe("queued");
    expect(deferred.earliest_claim_at).not.toBeNull();
    const resumeMs = new Date(deferred.earliest_claim_at!).getTime();
    expect(resumeMs).toBeGreaterThan(Date.now() + 40 * 60_000);
    // The sleep marker is stamped so re-entry never re-sleeps.
    expect(Object.keys(deferred.context.vars ?? {}).some((k) => k.startsWith("__slept"))).toBe(
      true
    );

    // Still deferred: a tick must NOT claim it early.
    await tickWorker();
    expect((await getRun(db, runId)).status).toBe("queued");
    expect((await getContactTags(db, biz, LEAD)).includes("Awake")).toBe(false);

    await ageRun(db, runId, { earliest_claim_at: minutesAgo(1) });
    await tickWorker();
    expect((await getRun(db, runId)).status).toBe("done");
    expect(await getContactTags(db, biz, LEAD)).toContain("Awake");
  });
});

describe("stale-lease reclaim (reclaim_stale_ai_flow_runs RPC)", () => {
  it("a run stuck 'running' on a dead lease is reclaimed and finishes", async () => {
    const biz = await seedBusiness(db, "IT reclaim");
    const flowId = await createFlow(
      db,
      biz,
      flow([{ id: "milestone", type: "goal", label: "Reached", events: [{ kind: "replied" }] }])
    );
    const runId = await enqueueRun(db, flowId, biz, TRIGGER, {}, { status: "running" });
    await ageRun(db, runId, { claimed_at: minutesAgo(20) });

    await tickWorker();
    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
  });
});

describe("test-mode runs", () => {
  it("simulates side effects (no real sends) and bypasses the enabled check", async () => {
    const biz = await seedBusiness(db, "IT testmode");
    const flowId = await createFlow(
      db,
      biz,
      flow([
        { id: "text", type: "send_sms", to: "{{vars.lead_phone}}", body: "Hi {{vars.lead_phone}}!" }
      ]),
      false // disabled — test runs must still execute
    );
    const runId = await enqueueRun(db, flowId, biz, { ...TRIGGER, test_mode: true });
    await tickWorker();
    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    const steps = await getSteps(db, runId);
    const send = steps[STEP_OFFSET];
    expect(send.status).toBe("done");
    expect((send.result as { simulated?: string }).simulated).toBe("send_sms");
    expect((send.result as { body?: string }).body).toBe(`Hi ${LEAD}!`);

    // No real outbound was logged — the send never left the simulator.
    const { data: outbound } = await db
      .from("sms_outbound_log")
      .select("id")
      .eq("business_id", biz);
    expect(outbound ?? []).toHaveLength(0);
  });
});
