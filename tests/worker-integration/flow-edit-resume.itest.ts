import { beforeAll, describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  RESUME_END_MARKER,
  RESUME_STEP_ID_VAR
} from "../../supabase/functions/_shared/ai_flows/branching";
import {
  ageRun,
  createFlow,
  enqueueRun,
  getContactTags,
  getRun,
  getSteps,
  minutesAgo,
  resumeReplyLikeWebhook,
  seedBusiness,
  seedContact,
  serviceDb,
  tickWorker
} from "./harness";

/**
 * End-to-end replay of the Jul 18 KYP triple re-send incident (PR #753,
 * fix 1) through the REAL worker + REAL Postgres: a run parked on
 * wait_for_reply, the flow DEFINITION EDITED while it waited, then the
 * lead's reply resuming the run.
 *
 * `current_step` is a flat index into flattenSteps() output — only stable
 * while the definition never changes. Pre-fix, the edit shifted every
 * index and the resumed run marched from the stale one, re-executing
 * arbitrary steps: a real lead got the greeting + two nudges re-sent
 * back-to-back. The fix stamps the parked step's ID (`__resume_step_id`)
 * on every park/advance and relocates via resolveResumeIndex at claim
 * time. The unit layer pins the remap math; THIS layer pins that the
 * served worker actually stamps the marker on park, that the webhook
 * resume path preserves it, and that a resumed run against an edited
 * definition executes the right steps — and only those — in the database.
 *
 * Steps are update_contact tags (distinct per step) so every execution is
 * observable as a tag + step row, with no Telnyx dependency.
 */

const LEAD = "+14165550188";

const TRIGGER = {
  channel: "sms",
  from: LEAD,
  windowText: `New integration lead. Phone: ${LEAD}. Please follow up.`
};

/** extract (index 0, regex-fallback phone) + the scenario's steps. */
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

const tag = (id: string, tagName: string, when?: Record<string, unknown>) => ({
  id,
  type: "update_contact",
  addTags: [tagName],
  phoneVar: "lead_phone",
  ...(when ? { when } : {})
});

const WAIT = {
  id: "wait",
  type: "wait_for_reply",
  saveAs: "reply",
  phoneVar: "lead_phone",
  timeoutMinutes: 60
};

/** The pre-edit definition every scenario parks under. */
const V1 = () => flow([tag("greet", "Greeted"), WAIT, tag("followup", "FollowedUp")]);

async function editDefinition(
  db: SupabaseClient,
  flowId: string,
  definition: Record<string, unknown>
): Promise<void> {
  const { error } = await db.from("ai_flows").update({ definition }).eq("id", flowId);
  if (error) throw new Error(`editDefinition: ${error.message}`);
}

let db: SupabaseClient;

beforeAll(() => {
  db = serviceDb();
});

describe("flow edited while a run is parked (the KYP triple re-send incident)", () => {
  it("parks stamp the resume marker; an unchanged definition resumes exactly as before", async () => {
    const biz = await seedBusiness(db, "IT edit-resume unchanged");
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(db, biz, V1());
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();
    const parked = await getRun(db, runId);
    expect(parked.status).toBe("awaiting_reply");
    // The fix's load-bearing write: the park carries the step ID the flat
    // index points at, so a later edit can be survived at all.
    expect(parked.context.vars?.[RESUME_STEP_ID_VAR]).toBe("wait");

    expect(await resumeReplyLikeWebhook(db, biz, LEAD, "sounds good")).toEqual([runId]);
    await tickWorker();

    const done = await getRun(db, runId);
    expect(done.status).toBe("done");
    expect(done.context.vars?.reply).toBe("sounds good");
    expect(done.context.vars?.[RESUME_STEP_ID_VAR]).toBe(RESUME_END_MARKER);
    expect(await getContactTags(db, biz, LEAD)).toEqual(
      expect.arrayContaining(["Greeted", "FollowedUp"])
    );
  });

  it("steps inserted BEFORE the parked wait shift the indexes but are never executed on resume", async () => {
    const biz = await seedBusiness(db, "IT edit-resume inserted");
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(db, biz, V1());
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();
    expect((await getRun(db, runId)).status).toBe("awaiting_reply");

    // The incident's edit shape: new steps land ahead of the wait, so the
    // parked flat index (2: the wait) now points at inserted step "new1".
    // Pre-fix, the resume would march from there — re-running sends the
    // lead already received. Post-fix it must relocate to "wait"'s new
    // index and continue with ONLY the steps after it.
    await editDefinition(
      db,
      flowId,
      flow([
        tag("greet", "Greeted"),
        tag("new1", "InsertedOne"),
        tag("new2", "InsertedTwo"),
        WAIT,
        tag("followup", "FollowedUp")
      ])
    );

    expect(await resumeReplyLikeWebhook(db, biz, LEAD, "yes please")).toEqual([runId]);
    await tickWorker();

    const done = await getRun(db, runId);
    expect(done.status).toBe("done");
    expect(done.context.vars?.reply).toBe("yes please");

    const tags = await getContactTags(db, biz, LEAD);
    expect(tags).toContain("Greeted");
    expect(tags).toContain("FollowedUp");
    // The re-send class: nothing that sits before the resume point may run.
    expect(tags).not.toContain("InsertedOne");
    expect(tags).not.toContain("InsertedTwo");

    // Exactly two update_contact executions total (greet pre-park,
    // followup post-resume) — a stale-index resume would have produced
    // more done rows here, the DB shape of the triple re-send.
    const steps = await getSteps(db, runId);
    const contactDone = steps.filter(
      (s) => s.step_type === "update_contact" && s.status === "done"
    );
    expect(contactDone).toHaveLength(2);

    // Prove the REMAP path ran (not an accidental pass): the worker logs
    // ai_flow_run_resume_remapped when the marker relocates the cursor.
    const { data: remapLogs } = await db
      .from("system_logs")
      .select("event, payload")
      .eq("business_id", biz)
      .eq("event", "ai_flow_run_resume_remapped");
    expect((remapLogs ?? []).length).toBeGreaterThan(0);
    expect((remapLogs![0].payload as { run_id?: string }).run_id).toBe(runId);
  });

  it("deleting the parked step cancels the run with a readable error instead of guessing", async () => {
    const biz = await seedBusiness(db, "IT edit-resume deleted");
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(db, biz, V1());
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();
    expect((await getRun(db, runId)).status).toBe("awaiting_reply");

    // The edit removes the wait entirely — the marked step no longer
    // exists, so there is no correct place to resume. resolveResumeIndex
    // returns null and the worker must stop the run cleanly.
    await editDefinition(
      db,
      flowId,
      flow([tag("greet", "Greeted"), tag("followup", "FollowedUp")])
    );

    expect(await resumeReplyLikeWebhook(db, biz, LEAD, "hello?")).toEqual([runId]);
    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("canceled");
    expect(run.last_error).toMatch(/edited while this run was waiting/i);
    // Nothing after the park executed — the lead was not texted from a
    // wrong index on the way down.
    expect(await getContactTags(db, biz, LEAD)).not.toContain("FollowedUp");
  });

  it("a legacy run parked WITHOUT a marker still resumes by raw index on an unchanged definition", async () => {
    const biz = await seedBusiness(db, "IT edit-resume legacy");
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(db, biz, V1());
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();
    const parked = await getRun(db, runId);
    expect(parked.status).toBe("awaiting_reply");

    // Simulate a run parked by a pre-#753 worker: strip the marker var.
    // resolveResumeIndex must fall back to the stored index (the pre-fix
    // behavior, correct while the definition is untouched).
    const vars = { ...(parked.context.vars ?? {}) } as Record<string, unknown>;
    delete vars[RESUME_STEP_ID_VAR];
    const { error } = await db
      .from("ai_flow_runs")
      .update({ context: { ...parked.context, vars } })
      .eq("id", runId);
    expect(error).toBeNull();

    expect(await resumeReplyLikeWebhook(db, biz, LEAD, "still here")).toEqual([runId]);
    await tickWorker();

    const done = await getRun(db, runId);
    expect(done.status).toBe("done");
    expect(await getContactTags(db, biz, LEAD)).toContain("FollowedUp");
  });

  it("the timeout resume path also survives an edit (no reply, definition changed)", async () => {
    const biz = await seedBusiness(db, "IT edit-resume timeout");
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(
      db,
      biz,
      flow([
        tag("greet", "Greeted"),
        WAIT,
        tag("noreply", "NoReply", { var: "reply", equals: "no_reply" })
      ])
    );
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();
    expect((await getRun(db, runId)).status).toBe("awaiting_reply");

    // Same insertion shape as the incident, then the wait TIMES OUT (the
    // resume_overdue_reply_waits RPC re-queues it) — the other real-world
    // way a parked run meets an edited definition.
    await editDefinition(
      db,
      flowId,
      flow([
        tag("greet", "Greeted"),
        tag("new1", "InsertedOne"),
        WAIT,
        tag("noreply", "NoReply", { var: "reply", equals: "no_reply" })
      ])
    );
    await ageRun(db, runId, { respond_by_at: minutesAgo(5) });
    await tickWorker();

    const done = await getRun(db, runId);
    expect(done.status).toBe("done");
    expect(done.context.vars?.reply).toBe("no_reply");
    const tags = await getContactTags(db, biz, LEAD);
    expect(tags).toContain("NoReply");
    expect(tags).not.toContain("InsertedOne");
  });
});
