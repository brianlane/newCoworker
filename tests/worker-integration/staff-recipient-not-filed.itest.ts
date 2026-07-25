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
 * THE DAVE LANE DEFECT (Amy Laidlaw Real Estate, Jul 25 2026), pinned against
 * the REAL served ai-flow-worker and a REAL local Postgres.
 *
 * Amy's HomeLight flow hands the claimed lead to the claimer with
 * `to: "{{vars.claimed_agent_phone}}"`. That raw templated recipient was not
 * one of the forms the worker recognized as internal (toAgentName / employee
 * toRef), so the send filed a lead customer profile for the number. The only
 * guard checked for an EXISTING non-customer contacts row, and the teammate had
 * none at all, so he was inserted as a NEW CUSTOMER. The portal extraction had
 * produced no lead phone that run, which made the engine treat the recipient AS
 * the lead, so the row was stamped with the LEAD's name: the dashboard showed
 * "New customer: Dave Lane" on a row whose display_name read "Salma A.".
 *
 * What must hold now, all through the same enrichCustomerProfile choke point:
 *   1. a flow text to an active roster number files NO contact, however the
 *      step addressed it (raw `to`, or the new toAgentNameVar);
 *   2. it never renames an existing row for that number either;
 *   3. an owner/self number is skipped the same way;
 *   4. a genuine LEAD number is still filed, with its extracted name. The
 *      guard must not be a blanket "stop filing".
 *
 * The Telnyx hop is real (TELNYX_API_BASE points at the fake app), so the send
 * genuinely happens and the absence of a contact row is a fact about the
 * post-send filing path, not about a send that never left.
 */

const ROSTER_MEMBER = "+16025245719";
const OWNER_CELL = "+16026951142";
const BUSINESS_DID = "+16028053377";
const LEAD = "+14805550143";
/** The lead's name, as an extraction would have produced it. */
const LEAD_NAME = "Salma A.";

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

/** Business that can actually SEND, with a roster and a known owner cell. */
async function seedRosteredBusiness(name: string): Promise<string> {
  const biz = await seedBusiness(db, name);
  const { error: telnyxErr } = await db.from("business_telnyx_settings").insert({
    business_id: biz,
    telnyx_messaging_profile_id: "itest-profile",
    telnyx_sms_from_e164: BUSINESS_DID,
    forward_to_e164: OWNER_CELL
  });
  if (telnyxErr) throw new Error(`seedRosteredBusiness telnyx: ${telnyxErr.message}`);
  const { error: rosterErr } = await db.from("ai_flow_team_members").insert({
    business_id: biz,
    name: "Dave Lane",
    phone_e164: ROSTER_MEMBER,
    active: true
  });
  if (rosterErr) throw new Error(`seedRosteredBusiness roster: ${rosterErr.message}`);
  return biz;
}

async function contactRow(
  biz: string,
  e164: string
): Promise<{ display_name: string | null; type: string } | null> {
  const { data, error } = await db
    .from("contacts")
    .select("display_name, type")
    .eq("business_id", biz)
    .eq("customer_e164", e164)
    .maybeSingle();
  if (error) throw new Error(`contactRow: ${error.message}`);
  return (data as { display_name: string | null; type: string } | null) ?? null;
}

/**
 * Run a one-step send flow to completion. `vars` carries the lead identity the
 * filing path reads (lead_name, and lead_phone only when the flow captured one),
 * mirroring what the HomeLight run had in scope at the hand-off step.
 */
async function runSendFlow(
  biz: string,
  step: Record<string, unknown>,
  vars: Record<string, unknown>
): Promise<Array<{ step_type: string; status: string; result: unknown }>> {
  const flowId = await createFlow(db, biz, {
    version: 1,
    trigger: { channel: "manual" },
    steps: [{ id: "s1", ...step }]
  });
  const runId = await enqueueRun(db, flowId, biz, {}, vars);
  // claim_ai_flow_runs leases only CLAIM_LIMIT runs per tick, oldest first, so
  // one tick is not guaranteed to reach THIS run when the queue already holds
  // others (a sibling suite's parked scenario, a previous session on the same
  // local stack). Tick until it is claimed rather than sweeping the table:
  // retiring other suites' runs to guarantee a free lease made broadcast-offer
  // flake. Bounded so a genuinely stuck run still fails the test.
  for (let i = 0; i < 10; i++) {
    await tickWorker();
    if ((await getRun(db, runId)).status !== "queued") break;
  }
  return getSteps(db, runId);
}

describe("AiFlow customer filing: a roster member is never a lead", () => {
  it("files nothing for a roster number reached through a templated `to`", async () => {
    const biz = await seedRosteredBusiness("Staff filing: raw to");
    const steps = await runSendFlow(
      biz,
      {
        type: "send_sms",
        to: "{{vars.claimed_agent_phone}}",
        body: "HomeLight lead is yours: {{vars.lead_name}}"
      },
      // The exact shape that stamped the lead's name on the teammate: a name in
      // scope, and NO usable lead_phone to tell recipient from lead.
      { claimed_agent_phone: ROSTER_MEMBER, lead_name: LEAD_NAME }
    );

    expect(steps.map((s) => [s.step_type, s.status])).toEqual([["send_sms", "done"]]);
    // The text really went out; only the filing was suppressed.
    expect(app.telnyxSends.map((s) => s.body.to)).toEqual([ROSTER_MEMBER]);
    expect(await contactRow(biz, ROSTER_MEMBER)).toBeNull();
  });

  it("files nothing for a roster number reached through toAgentNameVar", async () => {
    const biz = await seedRosteredBusiness("Staff filing: toAgentNameVar");
    const steps = await runSendFlow(
      biz,
      {
        type: "send_sms",
        toAgentNameVar: "claimed_agent",
        body: "{{agent.name}}, this lead is yours: {{vars.lead_name}}"
      },
      { claimed_agent: "Dave Lane", lead_name: LEAD_NAME }
    );

    expect(steps.map((s) => [s.step_type, s.status])).toEqual([["send_sms", "done"]]);
    expect(app.telnyxSends.map((s) => s.body.to)).toEqual([ROSTER_MEMBER]);
    // {{agent.*}} resolved from the roster, so the teammate is addressed by name.
    expect(app.telnyxSends[0]!.body.text).toContain("Dave Lane, this lead is yours");
    expect(await contactRow(biz, ROSTER_MEMBER)).toBeNull();
  });

  it("skips the hand-off, without failing the run, when nobody was named", async () => {
    const biz = await seedRosteredBusiness("Staff filing: unclaimed hand-off");
    // "none" is what route_to_team writes into claimed_agent when no teammate
    // took the lead. A hand-off then has nobody to text.
    const steps = await runSendFlow(
      biz,
      { type: "send_sms", toAgentNameVar: "claimed_agent", body: "yours" },
      { claimed_agent: "none" }
    );

    expect(steps.map((s) => [s.step_type, s.status])).toEqual([["send_sms", "skipped"]]);
    expect(steps[0]!.result).toMatchObject({ skipped: "no_teammate_named" });
    expect(app.telnyxSends).toHaveLength(0);
  });

  it("never RENAMES an existing row for a roster number", async () => {
    const biz = await seedRosteredBusiness("Staff filing: no rename");
    // A pre-existing row typed 'customer' with no name is the shape the OLD
    // guard let through: type='customer' meant "not a business contact", so the
    // lead's name was written into the empty display_name.
    const { error } = await db.from("contacts").insert({
      business_id: biz,
      customer_e164: ROSTER_MEMBER,
      display_name: null,
      type: "customer"
    });
    if (error) throw new Error(`seed existing row: ${error.message}`);

    await runSendFlow(
      biz,
      { type: "send_sms", to: "{{vars.claimed_agent_phone}}", body: "yours" },
      { claimed_agent_phone: ROSTER_MEMBER, lead_name: LEAD_NAME }
    );

    expect(await contactRow(biz, ROSTER_MEMBER)).toEqual({
      display_name: null,
      type: "customer"
    });
  });

  it("files nothing for the owner's own cell", async () => {
    const biz = await seedRosteredBusiness("Staff filing: owner cell");
    // The owner's number is DERIVED (the Safe Mode forward cell), not a stored
    // owner-typed contact and not on the roster, so this is the case only the self-number
    // arm of the guard catches. Exercised through upsert_customer because a
    // send_sms to a self number is refused before it can file anything (the
    // separate "extraction grabbed our own number" guard).
    const steps = await runSendFlow(
      biz,
      { type: "upsert_customer", phoneVar: "stray_phone", nameVar: "lead_name" },
      { stray_phone: OWNER_CELL, lead_name: LEAD_NAME }
    );

    expect(steps.map((s) => s.step_type)).toEqual(["upsert_customer"]);
    expect(await contactRow(biz, OWNER_CELL)).toBeNull();
  });

  it("still files a genuine lead, with the extracted name", async () => {
    const biz = await seedRosteredBusiness("Staff filing: real lead");
    const steps = await runSendFlow(
      biz,
      { type: "send_sms", to: "{{vars.lead_phone}}", body: "Hi {{vars.lead_name}}" },
      { lead_phone: LEAD, lead_name: LEAD_NAME }
    );

    expect(steps.map((s) => [s.step_type, s.status])).toEqual([["send_sms", "done"]]);
    expect(await contactRow(biz, LEAD)).toEqual({
      display_name: LEAD_NAME,
      type: "customer"
    });
  });

  it("upsert_customer skips a roster number too (same guard, explicit step)", async () => {
    const biz = await seedRosteredBusiness("Staff filing: upsert_customer");
    // A stray extraction landing on a roster phone must not file the teammate
    // as a customer either; upsert_customer shares enrichCustomerProfile.
    const steps = await runSendFlow(
      biz,
      { type: "upsert_customer", phoneVar: "stray_phone", nameVar: "lead_name" },
      { stray_phone: ROSTER_MEMBER, lead_name: LEAD_NAME }
    );

    expect(steps.map((s) => s.step_type)).toEqual(["upsert_customer"]);
    expect(await contactRow(biz, ROSTER_MEMBER)).toBeNull();
  });
});
