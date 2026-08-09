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
});
