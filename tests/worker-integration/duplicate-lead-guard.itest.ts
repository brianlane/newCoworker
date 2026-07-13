import { beforeAll, describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createFlow,
  enqueueRun,
  getContactTags,
  getRun,
  getSteps,
  minutesAgo,
  seedBusiness,
  serviceDb,
  tickWorker
} from "./harness";

/**
 * Duplicate lead submission guard (Truly Insurance, 2026-07-13): the same
 * lead source re-submitting the same phone within the window must UPDATE the
 * contact and stop — never re-run the introduction. Production showed five
 * intro texts to one number in four minutes (one per Privyr submission).
 *
 * Real worker + real Postgres: the guard lives in the ai-flow-worker's
 * upsert_customer execution, keyed on a prior non-test, non-failed run of
 * the SAME flow with the same extracted lead phone inside the 72h window.
 */

const LEAD = "+14165550177";

function leadFlow(): Record<string, unknown> {
  const def = {
    version: 1,
    trigger: { channel: "tenant_email", conditions: [] },
    steps: [
      {
        id: "extract",
        type: "extract_text",
        fields: [{ name: "lead_phone", description: "The lead's phone number" }]
      },
      { id: "file", type: "upsert_customer", phoneVar: "lead_phone" },
      { id: "tag", type: "update_contact", addTags: ["Introduced"], phoneVar: "lead_phone" }
    ]
  };
  parseAiFlowDefinition(def);
  return def;
}

/** Tenant-email lead trigger; keyless extract falls back to the phone regex. */
const TRIGGER = {
  channel: "tenant_email",
  from: "alerts-noreply@privyr.com",
  subject: "New Lead: Juhu",
  windowText: `New lead submitted. Phone: ${LEAD}. Product: Auto.`
};

let db: SupabaseClient;

beforeAll(() => {
  db = serviceDb();
});

describe("duplicate lead submission guard (real worker)", () => {
  it("a re-submission inside the window updates the contact but ends the run before any outreach step", async () => {
    const biz = await seedBusiness(db, "IT dup lead guard");
    const flowId = await createFlow(db, biz, leadFlow());

    // First submission: full run — contact filed and tagged.
    const firstRun = await enqueueRun(db, flowId, biz, TRIGGER, {}, {
      created_at: minutesAgo(10)
    });
    await tickWorker();
    expect((await getRun(db, firstRun)).status).toBe("done");
    expect(await getContactTags(db, biz, LEAD)).toContain("Introduced");

    // Second submission, 10 minutes later: guard trips at upsert_customer.
    const secondRun = await enqueueRun(db, flowId, biz, TRIGGER);
    await tickWorker();

    const run = await getRun(db, secondRun);
    expect(run.status).toBe("done");
    const steps = await getSteps(db, secondRun);
    const upsert = steps.find((s) => s.step_type === "upsert_customer");
    expect((upsert?.result as { skipped?: string }).skipped).toBe("duplicate_lead_submission");
    expect((upsert?.result as { duplicate_of?: string }).duplicate_of).toBe(firstRun);
    // endRun: the outreach-side steps after the guard never execute.
    const tag = steps.find((s) => s.step_type === "update_contact");
    expect(tag?.status ?? "absent").not.toBe("done");

    // Audit trail: the suppression is logged for the business.
    const { data: logs } = await db
      .from("system_logs")
      .select("event")
      .eq("business_id", biz)
      .eq("event", "ai_flow_duplicate_lead_suppressed");
    expect((logs ?? []).length).toBe(1);
  });

  it("a different flow handling the same phone is NOT suppressed (guard is per flow)", async () => {
    const biz = await seedBusiness(db, "IT dup lead other flow");
    const flowA = await createFlow(db, biz, leadFlow());
    const runA = await enqueueRun(db, flowA, biz, TRIGGER, {}, { created_at: minutesAgo(10) });
    await tickWorker();
    expect((await getRun(db, runA)).status).toBe("done");

    const flowB = await createFlow(db, biz, leadFlow());
    const runB = await enqueueRun(db, flowB, biz, TRIGGER);
    await tickWorker();

    const steps = await getSteps(db, runB);
    const upsert = steps.find((s) => s.step_type === "upsert_customer");
    expect((upsert?.result as { skipped?: string }).skipped).toBeUndefined();
    const tag = steps.find((s) => s.step_type === "update_contact");
    expect(tag?.status).toBe("done");
  });

  it("non-lead trigger channels are exempt: an SMS-triggered run re-handles the same phone freely", async () => {
    const biz = await seedBusiness(db, "IT dup lead sms exempt");
    const def = {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        {
          id: "extract",
          type: "extract_text",
          fields: [{ name: "lead_phone", description: "The lead's phone number" }]
        },
        { id: "file", type: "upsert_customer", phoneVar: "lead_phone" },
        { id: "tag", type: "update_contact", addTags: ["Reprocessed"], phoneVar: "lead_phone" }
      ]
    };
    parseAiFlowDefinition(def);
    const flowId = await createFlow(db, biz, def);
    const smsTrigger = {
      channel: "sms",
      from: LEAD,
      windowText: `New lead submitted. Phone: ${LEAD}. Product: Auto.`
    };

    const first = await enqueueRun(db, flowId, biz, smsTrigger, {}, { created_at: minutesAgo(10) });
    await tickWorker();
    expect((await getRun(db, first)).status).toBe("done");

    const second = await enqueueRun(db, flowId, biz, smsTrigger);
    await tickWorker();
    const steps = await getSteps(db, second);
    const upsert = steps.find((s) => s.step_type === "upsert_customer");
    expect((upsert?.result as { skipped?: string }).skipped).toBeUndefined();
    const tag = steps.find((s) => s.step_type === "update_contact");
    expect(tag?.status).toBe("done");
  });
});
