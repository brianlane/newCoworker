import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createFlow,
  enqueueRun,
  getRun,
  getSteps,
  seedBusiness,
  serviceDb,
  tickWorker
} from "./harness";
import { startFakeApp, type FakeApp } from "./fake-app";

/**
 * International SMS with NO P2P gateway configured (the itest env never sets
 * TELNYX_INTL_GATEWAY_E164): the send has no route, tenant A2P long codes
 * are domestic-only (Telnyx ticket #557577), so the step must SKIP with a
 * designed reason and the run must CONTINUE.
 *
 * Pinned against the real served worker because what this replaces was a
 * run-killer: KYP Ads / VFM, Aug 12 2026. A Meta lead arrived with a real
 * Indian mobile (+91...), the greeting send_sms hit Telnyx's permanent 409
 * 40306 ("Alpha sender not configured"), and the terminal step failure
 * killed the run with 13 steps never run: the whole nurture ladder, the
 * "lead went quiet" human flag, and the contact wrap-up.
 *
 * Contrast with bad-phone-backstop.itest.ts: an impossible +1 number is a
 * DATA bug and still fails the step (the number is not real). A valid
 * international number is a ROUTE gap: the number is real, the platform
 * just cannot text it yet, and the flow's remaining steps are exactly how
 * the lead still gets handled.
 */

const BUSINESS_DID = "+16028053377";
/** A real, structurally valid Indian mobile (the Aug 12 2026 lead's shape). */
const INDIAN_LEAD = "+917782876437";
/** Hong Kong roster phone: the KYP owner-cell class from the tenant dossier. */
const HK_ROSTER_PHONE = "+85260100607";
const DOMESTIC_LEAD = "+16025550144";

let db: SupabaseClient;
let app: FakeApp;

beforeAll(async () => {
  db = serviceDb();
  app = await startFakeApp();
});

beforeEach(() => {
  app.clearScript();
  app.telnyxSends.length = 0;
});

afterAll(async () => {
  await app.close();
});

async function seedTelnyx(biz: string): Promise<void> {
  const { error } = await db.from("business_telnyx_settings").insert({
    business_id: biz,
    telnyx_messaging_profile_id: "itest-profile",
    telnyx_sms_from_e164: BUSINESS_DID
  });
  if (error) throw new Error(`telnyx settings: ${error.message}`);
}

async function settleRun(runId: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await tickWorker();
    const status = (await getRun(db, runId)).status;
    if (status !== "queued" && status !== "running") break;
  }
}

describe("send_sms international no-gateway skip", () => {
  it("skips an international lead text and keeps the rest of the run alive", async () => {
    const biz = await seedBusiness(db, "Intl SMS skip");
    await seedTelnyx(biz);

    const flowId = await createFlow(db, biz, {
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        { id: "s_greet", type: "send_sms", to: INDIAN_LEAD, body: "hello from the flow" },
        { id: "s_after", type: "send_sms", to: DOMESTIC_LEAD, body: "the run kept going" }
      ]
    });
    const runId = await enqueueRun(db, flowId, biz, {}, {});
    await settleRun(runId);

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    expect(run.last_error).toBeNull();

    const steps = await getSteps(db, runId);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.status).toBe("skipped");
    expect(steps[0]?.result).toMatchObject({
      skipped: "international_sms_no_gateway",
      to: INDIAN_LEAD,
      country: "IN"
    });
    expect(steps[1]?.status).toBe("done");

    // Only the domestic text reached the carrier.
    expect(app.telnyxSends).toHaveLength(1);
    expect(JSON.stringify(app.telnyxSends[0]?.body ?? {})).toContain(DOMESTIC_LEAD);

    // The skip is operator-visible: a run note and a warn in the log tail.
    const actions = String(run.context.vars?.actions_taken ?? "");
    expect(actions).toContain("could not text");
    expect(actions).toContain(INDIAN_LEAD);

    const { data: logs, error: logErr } = await db
      .from("system_logs")
      .select("level, event, message, payload")
      .eq("business_id", biz)
      .eq("event", "ai_flow_sms_international_skipped");
    if (logErr) throw new Error(`system_logs read: ${logErr.message}`);
    expect(logs ?? []).toHaveLength(1);
    expect(logs?.[0]?.level).toBe("warn");
    expect(String(logs?.[0]?.message ?? "")).toContain(INDIAN_LEAD);
  });

  it("skips a roster text to an international teammate instead of failing the run", async () => {
    const biz = await seedBusiness(db, "Intl roster skip");
    await seedTelnyx(biz);
    const { error: rosterErr } = await db.from("ai_flow_team_members").insert({
      business_id: biz,
      name: "Hong Kong Harry",
      phone_e164: HK_ROSTER_PHONE,
      active: true
    });
    if (rosterErr) throw new Error(`roster: ${rosterErr.message}`);

    const flowId = await createFlow(db, biz, {
      version: 1,
      trigger: { channel: "manual" },
      steps: [{ id: "s1", type: "send_sms", toAgentName: "Hong Kong Harry", body: "team ping" }]
    });
    const runId = await enqueueRun(db, flowId, biz, {}, {});
    await settleRun(runId);

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");

    const steps = await getSteps(db, runId);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.status).toBe("skipped");
    expect(steps[0]?.result).toMatchObject({
      skipped: "international_sms_no_gateway",
      to: HK_ROSTER_PHONE,
      country: "HK"
    });

    // The carrier was never asked.
    expect(app.telnyxSends).toHaveLength(0);
  });
});
