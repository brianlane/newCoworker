import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  enqueueSmsJob,
  seedBusiness,
  seedContact,
  serviceDb,
  tickSmsWorker
} from "./harness";
import { startFakeRowboat, type FakeRowboat } from "./fake-rowboat";

/**
 * The texting coworker's flow-enrollment DISCOVERY block, on the real
 * Rowboat wire: when (and only when) the business has an enabled flow the
 * owner flagged `options.agentInvocable`, the customer preamble carries an
 * "Automations you may start" section naming it — so the model knows what
 * the start_aiflow_for_contact tool may target. Tenants with no flagged
 * flows get a byte-identical preamble (zero prompt change platform-wide).
 */

const LEAD = "+17805550310";

let db: SupabaseClient;
let rowboat: FakeRowboat;

beforeAll(async () => {
  db = serviceDb();
  rowboat = await startFakeRowboat();
});

beforeEach(async () => {
  await db
    .from("sms_inbound_jobs")
    .update({ status: "dead_letter", last_error: "itest_isolation_sweep" })
    .eq("status", "pending");
  rowboat.clearScript();
});

afterAll(async () => {
  await rowboat.close();
});

async function seedFlow(
  biz: string,
  name: string,
  over: { enabled?: boolean; agentInvocable?: boolean } = {}
): Promise<void> {
  const { error } = await db.from("ai_flows").insert({
    business_id: biz,
    name,
    enabled: over.enabled ?? true,
    definition: {
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        { id: "s1", type: "send_sms", to: "{{vars.lead_phone}}", body: "checking in!" }
      ],
      ...(over.agentInvocable === undefined
        ? {}
        : { options: { agentInvocable: over.agentInvocable } })
    }
  });
  if (error) throw new Error(`seedFlow: ${error.message}`);
}

describe("agent-invocable flows in the SMS preamble (real worker, fake Rowboat)", () => {
  it("names flagged flows in an 'Automations you may start' block (fails pre-fix)", async () => {
    const biz = await seedBusiness(db, "IT agent flows preamble");
    await seedContact(db, biz, LEAD);
    await seedFlow(biz, "Rebook follow-up", { agentInvocable: true });
    // Flows that are flagged-but-disabled or enabled-but-unflagged must NOT
    // be offered to the model.
    await seedFlow(biz, "Winback drip", { agentInvocable: true, enabled: false });
    await seedFlow(biz, "Lead intake", { agentInvocable: false });
    rowboat.scriptReply("Happy to help!");
    const callsBefore = rowboat.calls.length;
    await enqueueSmsJob(db, biz, LEAD, "I need to rebook my appointment");
    await tickSmsWorker();

    expect(rowboat.calls.length).toBe(callsBefore + 1);
    const system = rowboat.calls[callsBefore].body.messages.find((m) => m.role === "system");
    expect(system?.content).toContain("Automations you may start");
    expect(system?.content).toContain("Rebook follow-up");
    expect(system?.content).toContain("start_aiflow_for_contact");
    expect(system?.content).not.toContain("Winback drip");
    expect(system?.content).not.toContain("Lead intake");
  });

  it("a tenant with NO flagged flows gets no block at all", async () => {
    const biz = await seedBusiness(db, "IT agent flows preamble none");
    await seedContact(db, biz, LEAD);
    await seedFlow(biz, "Lead intake", { agentInvocable: false });
    rowboat.scriptReply("Hello!");
    const callsBefore = rowboat.calls.length;
    await enqueueSmsJob(db, biz, LEAD, "hello");
    await tickSmsWorker();

    const system = rowboat.calls[callsBefore].body.messages.find((m) => m.role === "system");
    expect(system?.content).not.toContain("Automations you may start");
    expect(system?.content).not.toContain("start_aiflow_for_contact");
  });
});
