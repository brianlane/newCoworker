import { beforeAll, describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createFlow,
  enqueueRun,
  getRun,
  seedBusiness,
  seedContact,
  serviceDb,
  tickWorker
} from "./harness";

/**
 * Owned-contact routing against the REAL worker + Postgres (Austin Happ,
 * 2026-08-08: the same person arrived as two leads two seconds apart, and
 * the second run's rotation race handed him to a second teammate 28 minutes
 * after the first claim). Once a contact has an ACTIVE owning teammate,
 * a route_to_team step must assign their new leads to that owner instead of
 * racing the roster, in both rotation and broadcast modes; an ex-teammate's
 * ownership must not.
 */

const DAVE = "+14165550981";
const GABBY = "+14165550982";

let db: SupabaseClient;

async function seedRoster(biz: string): Promise<{ dave: string; gabby: string }> {
  const { data, error } = await db
    .from("ai_flow_team_members")
    .insert([
      { business_id: biz, name: "Dave Lane", phone_e164: DAVE, active: true },
      { business_id: biz, name: "Gabrielle Mota", phone_e164: GABBY, active: true }
    ])
    .select("id, name");
  if (error) throw new Error(`seedRoster: ${error.message}`);
  const byName = new Map((data ?? []).map((r) => [r.name as string, r.id as string]));
  return { dave: byName.get("Dave Lane")!, gabby: byName.get("Gabrielle Mota")! };
}

function routeFlow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const def = {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [
      {
        id: "extract",
        type: "extract_text",
        fields: [{ name: "lead_phone", description: "The lead's phone number" }]
      },
      {
        id: "route",
        type: "route_to_team",
        offerTemplate: "New lead {{vars.lead_phone}}. Reply 1 to claim or 2 to pass.",
        ownerFallbackTemplate: "No one claimed {{vars.lead_phone}}.",
        responseMinutes: 10,
        ...extra
      }
    ]
  };
  parseAiFlowDefinition(def);
  return def;
}

/**
 * The HomeLight shape: the roster is raced BEFORE anything is known about
 * the lead, and the step that declares lead_phone comes after. At route
 * time `vars.lead_phone` does not exist, so only the definition can say
 * this is a relay flow.
 */
function routeBeforeExtractFlow(): Record<string, unknown> {
  const def = {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [
      {
        id: "route",
        type: "route_to_team",
        offerTemplate: "New referral. Reply 1 to claim or 2 to pass.",
        ownerFallbackTemplate: "No one claimed the referral.",
        responseMinutes: 10
      },
      {
        id: "card",
        type: "extract_text",
        fields: [{ name: "lead_phone", description: "The lead's phone number" }]
      }
    ]
  };
  parseAiFlowDefinition(def);
  return def;
}

/** A flow that never deals in lead phones: the sender genuinely is the lead. */
function noLeadPhoneFlow(): Record<string, unknown> {
  const def = {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [
      {
        id: "route",
        type: "route_to_team",
        offerTemplate: "New inquiry. Reply 1 to claim or 2 to pass.",
        ownerFallbackTemplate: "No one claimed the inquiry.",
        responseMinutes: 10
      }
    ]
  };
  parseAiFlowDefinition(def);
  return def;
}

function trigger(lead: string): Record<string, unknown> {
  return { channel: "sms", from: lead, windowText: `New lead. Phone: ${lead}.` };
}

async function setOwner(biz: string, lead: string, memberId: string): Promise<void> {
  const { error } = await db
    .from("contacts")
    .update({ owner_employee_id: memberId })
    .eq("business_id", biz)
    .eq("customer_e164", lead);
  if (error) throw new Error(`setOwner: ${error.message}`);
}

beforeAll(() => {
  db = serviceDb();
});

describe("owned-contact routing short-circuit", () => {
  it("rotation: a new lead for an owned contact is assigned to the owner, no race", async () => {
    const LEAD = "+14165550171";
    const biz = await seedBusiness(db, "Owner Aware Rotation");
    const ids = await seedRoster(biz);
    await seedContact(db, biz, LEAD);
    await setOwner(biz, LEAD, ids.dave);

    const flowId = await createFlow(db, biz, routeFlow());
    const runId = await enqueueRun(db, flowId, biz, trigger(LEAD));
    await tickWorker();

    const run = await getRun(db, runId);
    const vars = (run.context as { vars?: Record<string, unknown> }).vars ?? {};
    expect(vars.claimed_agent).toBe("Dave Lane");
    expect(vars.claimed_agent_phone).toBe(DAVE);
    const routing = (run.context as { routing?: Record<string, unknown> }).routing ?? {};
    expect(routing.owner_assigned).toBe(true);
    expect(routing.claimed_by).toBe(DAVE);
    // No offer race ever started.
    expect(routing.offered_all).toBeUndefined();
    expect(run.status).toBe("done");
  }, 120_000);

  it("broadcast: the fan-out never starts for an owned contact", async () => {
    const LEAD = "+14165550172";
    const biz = await seedBusiness(db, "Owner Aware Broadcast");
    const ids = await seedRoster(biz);
    await seedContact(db, biz, LEAD);
    await setOwner(biz, LEAD, ids.gabby);

    const flowId = await createFlow(
      db,
      biz,
      routeFlow({ agentNames: ["Dave Lane", "Gabrielle Mota"] })
    );
    const runId = await enqueueRun(db, flowId, biz, trigger(LEAD));
    await tickWorker();

    const run = await getRun(db, runId);
    const vars = (run.context as { vars?: Record<string, unknown> }).vars ?? {};
    expect(vars.claimed_agent).toBe("Gabrielle Mota");
    const routing = (run.context as { routing?: Record<string, unknown> }).routing ?? {};
    expect(routing.owner_assigned).toBe(true);
    expect(routing.offered_all).toBeUndefined();
    expect(run.status).toBe("done");
  }, 120_000);

  it("an ex-teammate's ownership does not short-circuit: the race runs normally", async () => {
    const LEAD = "+14165550173";
    const biz = await seedBusiness(db, "Owner Aware Inactive");
    const ids = await seedRoster(biz);
    await seedContact(db, biz, LEAD);
    await setOwner(biz, LEAD, ids.dave);
    const { error } = await db
      .from("ai_flow_team_members")
      .update({ active: false })
      .eq("id", ids.dave);
    if (error) throw new Error(error.message);

    const flowId = await createFlow(db, biz, routeFlow());
    const runId = await enqueueRun(db, flowId, biz, trigger(LEAD));
    await tickWorker();

    const run = await getRun(db, runId);
    const routing = (run.context as { routing?: Record<string, unknown> }).routing ?? {};
    // A live offer went out to the remaining roster (Gabby) instead of an
    // assignment to the departed owner.
    expect(routing.owner_assigned).toBeUndefined();
    expect(routing.offered).toBe(GABBY);
    expect(run.status).toBe("awaiting_agent");
  }, 120_000);

  it("an extracted-but-empty lead phone never binds ownership to the SENDER (Danfar)", async () => {
    // The partner line texts the alert in; the flow extracts lead_phone but
    // the partner withholds it (""). The partner line's own contact row is
    // owned by Dave (poisoned by an earlier claim). The offer must still
    // race the roster, not owner-assign.
    const PARTNER = "+14165550175";
    const biz = await seedBusiness(db, "Owner Aware Empty Extraction");
    const ids = await seedRoster(biz);
    await seedContact(db, biz, PARTNER);
    await setOwner(biz, PARTNER, ids.dave);

    const flowId = await createFlow(db, biz, routeFlow());
    // vars.lead_phone seeded PRESENT and EMPTY, exactly the HomeLight shape
    // at route time.
    const runId = await enqueueRun(
      db,
      flowId,
      biz,
      { channel: "sms", from: PARTNER, windowText: "New referral, details on the portal." },
      { lead_phone: "" }
    );
    await tickWorker();

    const run = await getRun(db, runId);
    const routing = (run.context as { routing?: Record<string, unknown> }).routing ?? {};
    expect(routing.owner_assigned).toBeUndefined();
    // A live offer went out: the race ran.
    expect(typeof routing.offered).toBe("string");
    expect(run.status).toBe("awaiting_agent");
  }, 120_000);

  it("a pinned step keeps its pin even on an owned contact", async () => {
    const LEAD = "+14165550174";
    const biz = await seedBusiness(db, "Owner Aware Pinned");
    const ids = await seedRoster(biz);
    await seedContact(db, biz, LEAD);
    await setOwner(biz, LEAD, ids.dave);

    // Pinned to Gabby on purpose: the pin is the flow author's explicit
    // choice (e.g. the spoke check pinning to the claimer var) and wins.
    const flowId = await createFlow(db, biz, routeFlow({ agentName: "Gabrielle Mota" }));
    const runId = await enqueueRun(db, flowId, biz, trigger(LEAD));
    await tickWorker();

    const run = await getRun(db, runId);
    const routing = (run.context as { routing?: Record<string, unknown> }).routing ?? {};
    expect(routing.owner_assigned).toBeUndefined();
    expect(routing.offered).toBe(GABBY);
    expect(run.status).toBe("awaiting_agent");
  }, 120_000);

  it("a relay flow that routes BEFORE it extracts still never binds to the sender (Amy C.)", async () => {
    // Amy C., HomeLight, 2026-08-14. Same partner-line poisoning as Danfar
    // above, but the variable bag cannot see it: route_to_team runs at step
    // 0 and the step that declares lead_phone is step 1, so at route time
    // there is no lead_phone key to trip the guard. The flow DEFINITION
    // still says this flow deals in lead phones, which is the signal that
    // holds at every step.
    const PARTNER = "+14165550176";
    const biz = await seedBusiness(db, "Owner Aware Route Before Extract");
    const ids = await seedRoster(biz);
    await seedContact(db, biz, PARTNER);
    await setOwner(biz, PARTNER, ids.gabby);

    const flowId = await createFlow(db, biz, routeBeforeExtractFlow());
    // No vars seeded at all: the key is ABSENT, not empty.
    const runId = await enqueueRun(db, flowId, biz, {
      channel: "sms",
      from: PARTNER,
      windowText: "New HomeLight Referral: Amy - $644K seller in Mesa, AZ."
    });
    await tickWorker();

    const run = await getRun(db, runId);
    const routing = (run.context as { routing?: Record<string, unknown> }).routing ?? {};
    expect(routing.owner_assigned).toBeUndefined();
    // The race ran: a live offer went out instead of a silent assignment.
    expect(typeof routing.offered).toBe("string");
    expect(run.status).toBe("awaiting_agent");
  }, 120_000);

  it("a flow with no lead_phone anywhere keeps the sender fallback", async () => {
    // The other side of the same rule: when the customer texts in directly,
    // the sender IS the contact and their owner should still short-circuit
    // the race. This is what the definition check must not break.
    const LEAD = "+14165550177";
    const biz = await seedBusiness(db, "Owner Aware Sender Is Lead");
    const ids = await seedRoster(biz);
    await seedContact(db, biz, LEAD);
    await setOwner(biz, LEAD, ids.dave);

    const flowId = await createFlow(db, biz, noLeadPhoneFlow());
    const runId = await enqueueRun(db, flowId, biz, {
      channel: "sms",
      from: LEAD,
      windowText: "Hi, I would like to sell my house."
    });
    await tickWorker();

    const run = await getRun(db, runId);
    const routing = (run.context as { routing?: Record<string, unknown> }).routing ?? {};
    expect(routing.owner_assigned).toBe(true);
    expect(routing.claimed_by).toBe(DAVE);
    expect(routing.offered_all).toBeUndefined();
    expect(run.status).toBe("done");
  }, 120_000);
});
