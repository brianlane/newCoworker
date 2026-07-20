import { beforeAll, describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createFlow,
  enqueueRun,
  getRun,
  getSteps,
  minutesAgo,
  seedBusiness,
  serviceDb,
  tickWorker
} from "./harness";

/**
 * Post-extraction lead-dedupe gate (options.dedupeLeadRuns — Amy's
 * Realtor.com $1.75M double-route, 2026-07-19): a run whose extracted lead
 * identity (phone/email) — and property, when both runs carry an address —
 * matches an EARLIER non-failed run of the same flow must be canceled
 * before its first communication step. Sender-keyed re-entry can't cover
 * this: realtor.com's relay texts arrive with an empty shared sender.
 *
 * Real worker + real Postgres: the gate lives in the worker's executeRun
 * loop, so only this suite can pin the cancel-before-send behavior.
 */

const LEAD = "+16025550144";
const ADDR = "24027 S 121st Pl, Chandler, AZ 85249, USA";
const OTHER_ADDR = "409 E Woodman Dr, Tempe, AZ 85283, USA";

/** SMS relay trigger with an EMPTY sender, like realtor.com notifications. */
const TRIGGER = {
  channel: "sms",
  from: "",
  windowText: "New inquiry relay (identity comes from extracted vars)"
};

function dedupeFlow(options: Record<string, unknown> = { dedupeLeadRuns: true }): Record<
  string,
  unknown
> {
  const def = {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [{ id: "notify", type: "notify_owner", message: "A new lead arrived" }],
    options
  };
  parseAiFlowDefinition(def);
  return def;
}

/**
 * Vars pre-seeded as extract_text would have produced them (the itest stack
 * has no Gemini key, and an extract step would overwrite seeded vars with
 * empties). The gate reads scope.vars either way — extraction correctness
 * is pinned by its own suites.
 */
function leadVars(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { lead_phone: LEAD, lead_email: "lead@example.com", lead_address: ADDR, ...over };
}

let db: SupabaseClient;

beforeAll(() => {
  db = serviceDb();
});

describe("post-extraction lead-dedupe gate (real worker)", () => {
  it("cancels a re-trigger for the same person + property before any send", async () => {
    const biz = await seedBusiness(db, "IT lead dedupe blocks");
    const flowId = await createFlow(db, biz, dedupeFlow());

    const first = await enqueueRun(db, flowId, biz, TRIGGER, leadVars(), {
      created_at: minutesAgo(20)
    });
    await tickWorker();
    expect((await getRun(db, first)).status).toBe("done");

    const second = await enqueueRun(db, flowId, biz, TRIGGER, leadVars());
    await tickWorker();

    const run = await getRun(db, second);
    expect(run.status).toBe("canceled");
    expect(run.last_error).toContain("duplicate lead");
    expect(String(run.context.vars?.actions_taken)).toContain("duplicate of an earlier run");

    // The comm step (and everything after it) is recorded skipped, not run.
    const steps = await getSteps(db, second);
    const notify = steps.find((s) => s.step_type === "notify_owner");
    expect(notify?.status).toBe("skipped");
    expect((notify?.result as { skipped?: string }).skipped).toBe("duplicate_lead");

    // Audit trail for the business.
    const { data: logs } = await db
      .from("system_logs")
      .select("event")
      .eq("business_id", biz)
      .eq("event", "ai_flow_run_skipped_duplicate_lead");
    expect((logs ?? []).length).toBe(1);
  });

  it("a FAILED prior run never blocks — the repeat inquiry is the recovery path", async () => {
    const biz = await seedBusiness(db, "IT lead dedupe failed prior");
    const flowId = await createFlow(db, biz, dedupeFlow());

    await enqueueRun(db, flowId, biz, TRIGGER, leadVars(), {
      created_at: minutesAgo(30),
      status: "failed"
    });
    const retry = await enqueueRun(db, flowId, biz, TRIGGER, leadVars());
    await tickWorker();
    expect((await getRun(db, retry)).status).toBe("done");
  });

  it("the same person asking about a DIFFERENT property is a new lead", async () => {
    const biz = await seedBusiness(db, "IT lead dedupe other property");
    const flowId = await createFlow(db, biz, dedupeFlow());

    const first = await enqueueRun(db, flowId, biz, TRIGGER, leadVars(), {
      created_at: minutesAgo(20)
    });
    await tickWorker();
    expect((await getRun(db, first)).status).toBe("done");

    const second = await enqueueRun(
      db,
      flowId,
      biz,
      TRIGGER,
      leadVars({ lead_address: OTHER_ADDR })
    );
    await tickWorker();
    expect((await getRun(db, second)).status).toBe("done");
  });

  it("no extracted identity → the gate no-ops (nothing to key on)", async () => {
    const biz = await seedBusiness(db, "IT lead dedupe no keys");
    const flowId = await createFlow(db, biz, dedupeFlow());

    const first = await enqueueRun(db, flowId, biz, TRIGGER, leadVars(), {
      created_at: minutesAgo(20)
    });
    await tickWorker();
    expect((await getRun(db, first)).status).toBe("done");

    // A relay text the extraction got nothing from (the Jennifer Phillips
    // reply shape) — with the tightened trigger this run shouldn't exist at
    // all, but if one does enroll, the gate must not guess on a bare name.
    const second = await enqueueRun(db, flowId, biz, TRIGGER, {
      lead_name: "Jennifer Phillips"
    });
    await tickWorker();
    expect((await getRun(db, second)).status).toBe("done");
  });

  it("flows without options.dedupeLeadRuns keep today's behavior", async () => {
    const biz = await seedBusiness(db, "IT lead dedupe default off");
    const flowId = await createFlow(db, biz, dedupeFlow({}));

    const first = await enqueueRun(db, flowId, biz, TRIGGER, leadVars(), {
      created_at: minutesAgo(20)
    });
    await tickWorker();
    expect((await getRun(db, first)).status).toBe("done");

    const second = await enqueueRun(db, flowId, biz, TRIGGER, leadVars());
    await tickWorker();
    expect((await getRun(db, second)).status).toBe("done");
  });
});
