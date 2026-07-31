import { beforeAll, describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ageRun,
  createFlow,
  enqueueRun,
  getContactTags,
  getRun,
  minutesAgo,
  seedBusiness,
  seedContact,
  serviceDb,
  tickWorker
} from "./harness";

/**
 * wait_for_call waiting for a call to START (Amy Laidlaw, 2026-07-31).
 *
 * The step only ever attached to a call that was ALREADY live at the instant
 * it ran. With no session it returned "no_call" in zero seconds, which made
 * `timeoutMinutes` dead config: that is the ceiling on waiting for a live call
 * to END, and nothing ever waited for one to begin.
 *
 * `awaitStartMinutes` (opt-in, default 0) polls for one instead, as a DEFER
 * rather than a park: with no call_control_id there is nothing for
 * voice_link_call_run to attach to and resume_overdue_call_waits would never
 * fire, whereas earliest_claim_at needs no new plumbing.
 *
 * Needs a real worker and a real Postgres because the whole behavior IS the
 * persistence: earliest_claim_at written, the deadline var surviving the
 * round trip, the attempt handed back, and the run continuing on time.
 */

const LEAD = "+14165550188";
const PARTNER = "+14159851909";

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

const TRIGGER = {
  channel: "sms",
  from: LEAD,
  windowText: `New referral. Phone: ${LEAD}. Please follow up.`
};

let db: SupabaseClient;

beforeAll(() => {
  db = serviceDb();
});

describe("wait_for_call awaitStartMinutes (real worker)", () => {
  it("defers while it waits for a call to start, then continues once the deadline lapses", async () => {
    const biz = await seedBusiness(db, "IT await call start");
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(
      db,
      biz,
      flow([
        {
          id: "wait_call",
          type: "wait_for_call",
          fromE164: PARTNER,
          awaitStartMinutes: 5,
          saveAs: "hl_call_outcome"
        },
        { id: "tag_after", type: "update_contact", addTags: ["Continued"], phoneVar: "lead_phone" }
      ])
    );
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    // No voice_handoff_sessions row exists for this business, so the step has
    // nothing to attach to. It must WAIT rather than resolve no_call.
    await tickWorker();
    const deferred = await getRun(db, runId);
    expect(deferred.status).toBe("queued");
    expect(deferred.earliest_claim_at).not.toBeNull();
    // One minute out, never the whole window: it re-reads every tick so a call
    // that starts is picked up promptly.
    const resumeMs = new Date(deferred.earliest_claim_at!).getTime();
    expect(resumeMs).toBeLessThanOrEqual(Date.now() + 61_000);
    // The deadline is stamped once and survives the round trip, so the poll is
    // bounded rather than restarting its window on every pass.
    const deadlineVar = Object.keys(deferred.context.vars ?? {}).find((k) =>
      k.endsWith("_await_until")
    );
    expect(deadlineVar).toBeDefined();
    const deadline = Number((deferred.context.vars ?? {})[deadlineVar!]);
    expect(Number.isFinite(deadline)).toBe(true);

    // Downstream steps have NOT run: it is waiting, not sailing past.
    expect((await getContactTags(db, biz, LEAD)).includes("Continued")).toBe(false);

    // Still inside the window: it defers again on the same deadline.
    await ageRun(db, runId, { earliest_claim_at: minutesAgo(1) });
    await tickWorker();
    const again = await getRun(db, runId);
    expect(again.status).toBe("queued");
    expect(Number((again.context.vars ?? {})[deadlineVar!])).toBe(deadline);
    expect((await getContactTags(db, biz, LEAD)).includes("Continued")).toBe(false);

    // Past the deadline with no call: resolve no_call and carry on. The point
    // of the whole fix is that the run CONTINUES rather than stalling.
    await ageRun(db, runId, { earliest_claim_at: minutesAgo(1) });
    await db
      .from("ai_flow_runs")
      .update({
        context: {
          ...again.context,
          vars: { ...(again.context.vars ?? {}), [deadlineVar!]: String(Date.now() - 1000) }
        }
      })
      .eq("id", runId);
    await tickWorker();

    const done = await getRun(db, runId);
    expect(done.status).toBe("done");
    expect((done.context.vars ?? {}).hl_call_outcome).toBe("no_call");
    expect(await getContactTags(db, biz, LEAD)).toContain("Continued");
  });

  it("re-stamps a junk deadline instead of treating it as already lapsed", async () => {
    // Number("") is 0, which would read as a deadline in the past and silently
    // turn the wait into an instant give-up. Run context is persisted JSON that
    // outlives flow edits, so junk must re-stamp rather than disable the wait.
    const biz = await seedBusiness(db, "IT await call junk deadline");
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(
      db,
      biz,
      flow([
        {
          id: "wait_call",
          type: "wait_for_call",
          fromE164: PARTNER,
          awaitStartMinutes: 5,
          saveAs: "hl_call_outcome"
        },
        { id: "tag_after", type: "update_contact", addTags: ["Continued"], phoneVar: "lead_phone" }
      ])
    );
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();
    const first = await getRun(db, runId);
    const deadlineVar = Object.keys(first.context.vars ?? {}).find((k) =>
      k.endsWith("_await_until")
    )!;

    // Poison it, then let the step run again.
    await db
      .from("ai_flow_runs")
      .update({
        context: {
          ...first.context,
          vars: { ...(first.context.vars ?? {}), [deadlineVar]: "" }
        }
      })
      .eq("id", runId);
    await ageRun(db, runId, { earliest_claim_at: minutesAgo(1) });
    await tickWorker();

    const after = await getRun(db, runId);
    expect(after.status).toBe("queued");
    expect(Number((after.context.vars ?? {})[deadlineVar])).toBeGreaterThan(Date.now());
    expect((await getContactTags(db, biz, LEAD)).includes("Continued")).toBe(false);
  });

  it("without awaitStartMinutes it still resolves no_call on the first pass", async () => {
    const biz = await seedBusiness(db, "IT await call start off");
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(
      db,
      biz,
      flow([
        { id: "wait_call", type: "wait_for_call", fromE164: PARTNER, saveAs: "hl_call_outcome" },
        { id: "tag_after", type: "update_contact", addTags: ["Continued"], phoneVar: "lead_phone" }
      ])
    );
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    expect((run.context.vars ?? {}).hl_call_outcome).toBe("no_call");
    expect(await getContactTags(db, biz, LEAD)).toContain("Continued");
  });
});
