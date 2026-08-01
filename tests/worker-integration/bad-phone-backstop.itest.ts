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
 * The pre-Telnyx NANP backstop (KYP Ads, Aug 1 2026), pinned against the REAL
 * served ai-flow-worker.
 *
 * A lead typed +16133439985030 into a Facebook form: structurally valid
 * E.164 (14 digits), impossible as a +1 number (NANP is exactly 10 national
 * digits), guaranteed Telnyx 40310. Templated recipients are now coerced by
 * the planner (coerceDialableE164) and SKIP before the worker ever runs, but
 * roster phones and saved refs resolve inside sendSmsStep with no planner
 * pass. The backstop must fail those immediately, with the readable
 * permanent-failure message and NO carrier call.
 */

const BUSINESS_DID = "+16028053377";
const OWNER_CELL = "+16026951142";
/** Structurally E.164, never dialable: +1 with 13 national digits. */
const BAD_ROSTER_PHONE = "+16133439985030";

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

describe("sendSmsStep NANP backstop", () => {
  it("fails a roster send to an impossible +1 number without calling the carrier", async () => {
    const biz = await seedBusiness(db, "Bad-phone backstop");
    const { error: telnyxErr } = await db.from("business_telnyx_settings").insert({
      business_id: biz,
      telnyx_messaging_profile_id: "itest-profile",
      telnyx_sms_from_e164: BUSINESS_DID,
      forward_to_e164: OWNER_CELL
    });
    if (telnyxErr) throw new Error(`telnyx settings: ${telnyxErr.message}`);
    // The roster CHECK constraint is structural (+ then 7-15 digits), so this
    // number seeds cleanly, exactly like a legacy row filed before the fix.
    const { error: rosterErr } = await db.from("ai_flow_team_members").insert({
      business_id: biz,
      name: "Badnum Bee",
      phone_e164: BAD_ROSTER_PHONE,
      active: true
    });
    if (rosterErr) throw new Error(`roster: ${rosterErr.message}`);

    const flowId = await createFlow(db, biz, {
      version: 1,
      trigger: { channel: "manual" },
      steps: [{ id: "s1", type: "send_sms", toAgentName: "Badnum Bee", body: "team ping" }]
    });
    const runId = await enqueueRun(db, flowId, biz, {}, {});
    for (let i = 0; i < 10; i++) {
      await tickWorker();
      if ((await getRun(db, runId)).status !== "queued") break;
    }

    const run = await getRun(db, runId);
    expect(run.status).toBe("failed");
    expect(run.last_error ?? "").toContain(BAD_ROSTER_PHONE);
    expect(run.last_error ?? "").toContain("isn't a real dialable line");

    const steps = await getSteps(db, runId);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.status).toBe("failed");

    // The whole point: the carrier was never asked.
    expect(app.telnyxSends).toHaveLength(0);
  });
});
