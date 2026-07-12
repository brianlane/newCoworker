import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { applyGoalEvent, GOAL_JUMP_SKIP } from "../../supabase/functions/_shared/ai_flows/goal_events";
import type { FlowStep } from "../../supabase/functions/_shared/ai_flows/types";
import {
  createFlow,
  enqueueRun,
  getContactTags,
  getRun,
  getSteps,
  resumeReplyLikeWebhook,
  seedBusiness,
  seedContact,
  serviceDb,
  tickWorker
} from "./harness";

/**
 * Event-driven run transitions against the REAL worker + REAL Postgres:
 * the reply-resume path (webhook-shaped), Goal Event forward jumps
 * (applyGoalEvent — the same shared module every production hook calls,
 * here against the real ai_flow_runs/ai_flows tables), and the
 * route_to_team owner-fallback when nobody on the roster is on shift —
 * the exact `tried: 0` signature from the Truly Insurance incident.
 */

const LEAD = "+14165550199";
const TRIGGER = {
  channel: "sms",
  from: LEAD,
  windowText: `New integration lead. Phone: ${LEAD}. Please follow up.`
};

/** Same fixture convention as ai-flow-worker.itest.ts (extract feeds lead_phone). */
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

let db: SupabaseClient;

beforeAll(() => {
  db = serviceDb();
});

describe("wait_for_reply resume by reply (webhook-shaped)", () => {
  it("a parked run resumes with the reply text and takes the replied arm", async () => {
    const biz = await seedBusiness(db, "IT reply-resume");
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
          timeoutMinutes: 120
        },
        {
          id: "tag_replied",
          type: "update_contact",
          when: { var: "reply", notEquals: "no_reply" },
          addTags: ["Replied"],
          phoneVar: "lead_phone"
        },
        {
          id: "tag_noreply",
          type: "update_contact",
          when: { var: "reply", equals: "no_reply" },
          addTags: ["NoReply"],
          phoneVar: "lead_phone"
        }
      ])
    );
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();
    expect((await getRun(db, runId)).status).toBe("awaiting_reply");

    const resumed = await resumeReplyLikeWebhook(db, biz, LEAD, "Yes, I'm still interested!");
    expect(resumed).toEqual([runId]);

    await tickWorker();
    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    expect(run.context.vars?.reply).toBe("Yes, I'm still interested!");
    const tags = await getContactTags(db, biz, LEAD);
    expect(tags).toContain("Replied");
    expect(tags).not.toContain("NoReply");
  });
});

describe("Goal Event forward jump (applyGoalEvent → real DB → real worker)", () => {
  it("a replied milestone jumps a parked run past its follow-ups to the goal", async () => {
    const biz = await seedBusiness(db, "IT goal-jump");
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
          timeoutMinutes: 120
        },
        // The follow-up the jump must SKIP (in production this is the nudge
        // text; here a tag write so the harness needs no Telnyx).
        { id: "tag_nudged", type: "update_contact", addTags: ["Nudged"], phoneVar: "lead_phone" },
        { id: "milestone", type: "goal", label: "Lead replied", events: [{ kind: "replied" }] },
        {
          id: "tag_after_goal",
          type: "update_contact",
          addTags: ["GoalReached"],
          phoneVar: "lead_phone"
        }
      ])
    );
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();
    expect((await getRun(db, runId)).status).toBe("awaiting_reply");

    // The milestone lands (e.g. the inbound webhook observed a reply that a
    // DIFFERENT run consumed): jump THIS run forward to its goal.
    const { jumpedRuns } = await applyGoalEvent(db, biz, LEAD, { kind: "replied" });
    expect(jumpedRuns).toBe(1);

    const jumped = await getRun(db, runId);
    expect(jumped.status).toBe("queued");
    expect(jumped.current_step).toBe(3); // the goal's flattened index
    expect((jumped.context.waiting_reply as { result?: string } | null)?.result).toBe(
      GOAL_JUMP_SKIP
    );

    await tickWorker();
    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    const steps = await getSteps(db, runId);
    // The wait and the skipped-over follow-up carry the goal_jump skip...
    expect(steps.find((s) => s.step_index === 1)?.status).toBe("skipped");
    expect((steps.find((s) => s.step_index === 2)?.result as { skipped?: string }).skipped).toBe(
      GOAL_JUMP_SKIP
    );
    // ...the goal records how the run arrived, and post-goal steps ran.
    expect((steps.find((s) => s.step_index === 3)?.result as { reached_via?: string }).reached_via).toBe(
      "replied"
    );
    const tags = await getContactTags(db, biz, LEAD);
    expect(tags).toContain("GoalReached");
    expect(tags).not.toContain("Nudged");
  });
});

describe("route_to_team owner fallback (the Truly `tried: 0` regression)", () => {
  it("a roster with nobody on shift falls back to the owner without offering anyone", async () => {
    const biz = await seedBusiness(db, "IT route-fallback");
    await seedContact(db, biz, LEAD);
    // One active broker whose ONLY shift is 3 days from now — deterministic
    // "not on shift at test time" regardless of when CI runs (the exact
    // state of Truly's roster at 8:39 AM on incident day).
    const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
    const offShiftDay = DAYS[(new Date().getUTCDay() + 3) % 7];
    const { error: rosterErr } = await db.from("ai_flow_team_members").insert({
      business_id: biz,
      name: "Off Shift Broker",
      phone_e164: "+14165550111",
      active: true,
      weekly_schedule: { [offShiftDay]: [["09:00", "17:00"]] }
    });
    if (rosterErr) throw new Error(rosterErr.message);

    const flowId = await createFlow(
      db,
      biz,
      flow([
        {
          id: "offer",
          type: "route_to_team",
          responseMinutes: 10,
          offerTemplate: "New lead: {{vars.lead_phone}}. Reply 1 to claim.",
          ownerFallbackTemplate: "No broker claimed {{vars.lead_phone}}. Back to you."
        }
      ])
    );
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);
    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    const steps = await getSteps(db, runId);
    const offer = steps.find((s) => s.step_type === "route_to_team");
    expect(offer?.status).toBe("done");
    // The incident signature: the offer skipped the whole roster (nobody on
    // shift) and fell straight back to the owner.
    expect((offer?.result as { routed?: string }).routed).toBe("owner_fallback");
    expect((offer?.result as { tried?: number }).tried).toBe(0);
  });
});
