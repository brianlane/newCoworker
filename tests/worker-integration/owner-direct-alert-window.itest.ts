import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveContactOwnerTarget } from "../../supabase/functions/_shared/contact_owner_target";
import { createFlow, seedBusiness, seedContact, serviceDb } from "./harness";

/**
 * The keep-for-owner window against the local stack (Robert Braid, Amy
 * Laidlaw, 2026-09-02). A mocked query builder happily "passes" a filter
 * against a JSON path the Data API does not understand, which is how the
 * erasure path shipped a delete against a dropped table. This itest is the
 * proof that `context->routing->>owner_direct` and
 * `context->vars->>lead_phone` actually select the parked run.
 *
 * While that park is live, an unowned contact's urgent alert goes to the
 * business owner, not the team. Once `owner_direct_done` is set, the
 * team-broadcast rung returns.
 */

const LEAD = "+14165550191";
const DAVE = "+14165550981";
const GABBY = "+14165550982";
const JASON = "+14165550983";

let db: SupabaseClient;

async function seedThreeMemberRoster(biz: string): Promise<void> {
  const { error } = await db.from("ai_flow_team_members").insert([
    { business_id: biz, name: "Dave Lane", phone_e164: DAVE, active: true },
    { business_id: biz, name: "Gabrielle Mota", phone_e164: GABBY, active: true },
    { business_id: biz, name: "Jason Lane", phone_e164: JASON, active: true }
  ]);
  if (error) throw new Error(`seedRoster: ${error.message}`);
}

async function insertParkedRun(
  biz: string,
  over: { owner_direct_done?: boolean; status?: string } = {}
): Promise<string> {
  const flowId = await createFlow(db, biz, {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [{ id: "noop", type: "send_sms", bodyTemplate: "park" }]
  });
  const { data, error } = await db
    .from("ai_flow_runs")
    .insert({
      flow_id: flowId,
      business_id: biz,
      status: over.status ?? "awaiting_agent",
      context: {
        vars: { lead_phone: LEAD, lead_name: "Robert Braid" },
        routing: {
          owner_direct: true,
          owner_direct_e164: "+16026951142",
          ...(over.owner_direct_done ? { owner_direct_done: true } : {})
        }
      }
    })
    .select("id")
    .single();
  if (error) throw new Error(`insertParkedRun: ${error.message}`);
  return (data as { id: string }).id;
}

beforeAll(() => {
  db = serviceDb();
});

describe("owner-direct alert window (real JSON-path filter)", () => {
  it("pages the owner, not the team, while a keep-for-owner park is live", async () => {
    const biz = await seedBusiness(db, "IT owner-direct window live");
    await seedThreeMemberRoster(biz);
    await seedContact(db, biz, LEAD);
    await insertParkedRun(biz);

    const out = await resolveContactOwnerTarget(db, biz, LEAD);
    expect(out.target).toBe("business_owner");
    expect(out.reason).toBe("owner_direct_live");
    expect(out.team).toEqual([]);
  });

  it("broadcasts to the team once owner_direct_done is set", async () => {
    const biz = await seedBusiness(db, "IT owner-direct window done");
    await seedThreeMemberRoster(biz);
    await seedContact(db, biz, LEAD);
    const runId = await insertParkedRun(biz);

    const live = await resolveContactOwnerTarget(db, biz, LEAD);
    expect(live.reason).toBe("owner_direct_live");

    const { data: row, error: readErr } = await db
      .from("ai_flow_runs")
      .select("context")
      .eq("id", runId)
      .single();
    if (readErr) throw new Error(readErr.message);
    const context = (row as { context: Record<string, unknown> }).context;
    const routing = { ...((context.routing as Record<string, unknown>) ?? {}), owner_direct_done: true };
    const { error: writeErr } = await db
      .from("ai_flow_runs")
      .update({ context: { ...context, routing }, updated_at: new Date().toISOString() })
      .eq("id", runId);
    if (writeErr) throw new Error(writeErr.message);

    const after = await resolveContactOwnerTarget(db, biz, LEAD);
    expect(after.target).toBe("team_broadcast");
    expect(after.reason).toBe("contact_unowned");
    expect(after.team.map((m) => m.phone).sort()).toEqual([DAVE, GABBY, JASON].sort());
  });

  it("a newer finished park does not hide an older live park", async () => {
    const biz = await seedBusiness(db, "IT owner-direct window newer-done");
    await seedThreeMemberRoster(biz);
    await seedContact(db, biz, LEAD);
    await insertParkedRun(biz);
    const doneId = await insertParkedRun(biz, { owner_direct_done: true });
    const { error } = await db
      .from("ai_flow_runs")
      .update({ updated_at: new Date(Date.now() + 60_000).toISOString() })
      .eq("id", doneId);
    if (error) throw new Error(error.message);

    const out = await resolveContactOwnerTarget(db, biz, LEAD);
    expect(out.target).toBe("business_owner");
    expect(out.reason).toBe("owner_direct_live");
  });
});
