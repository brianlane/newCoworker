import { beforeAll, describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createFlow,
  enqueueRun,
  getRun,
  getSteps,
  seedBusiness,
  seedContact,
  serviceDb,
  tickWorker
} from "./harness";

/**
 * Lead auto-assignment (Truly feedback Issue 7): with
 * businesses.lead_auto_assign on, route_to_team hard-assigns the rotation
 * pick — the run records the claim immediately and continues instead of
 * parking awaiting_agent, and the contact gets an owner. Default (off)
 * keeps the offer-and-claim park, pinned here too so the flag can't leak
 * into existing tenants' behavior.
 *
 * The teammate FYI/offer SMS cannot leave this harness (no Telnyx env):
 * in auto-assign mode that send is best-effort by design (the assignment is
 * the durable fact), so the run still completes — which doubles as coverage
 * for exactly that failure path.
 */

const LEAD = "+14165550166";
const AGENT_PHONE = "+14165550990";

function routedFlow(): Record<string, unknown> {
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
        offerTemplate: "New lead {{vars.lead_phone}} — reply 1 to claim.",
        ownerFallbackTemplate: "No one claimed {{vars.lead_phone}} — back to you.",
        responseMinutes: 10
      },
      {
        id: "after-claim",
        type: "update_contact",
        addTags: ["Assigned"],
        phoneVar: "lead_phone",
        when: { var: "claimed_agent", notEquals: "none" }
      }
    ]
  };
  parseAiFlowDefinition(def);
  return def;
}

const TRIGGER = {
  channel: "sms",
  from: LEAD,
  windowText: `New lead submitted. Phone: ${LEAD}. Product: Auto.`
};

let db: SupabaseClient;

async function seedRoster(biz: string): Promise<string> {
  const { data, error } = await db
    .from("ai_flow_team_members")
    .insert({ business_id: biz, name: "Dave", phone_e164: AGENT_PHONE, active: true })
    .select("id")
    .single();
  if (error) throw new Error(`seedRoster: ${error.message}`);
  return (data as { id: string }).id;
}

beforeAll(() => {
  db = serviceDb();
});

describe("lead auto-assignment (real worker)", () => {
  it("the flag ships default OFF on the live schema — existing tenants keep offer-and-claim", async () => {
    const biz = await seedBusiness(db, "IT auto assign default");
    const { data, error } = await db
      .from("businesses")
      .select("lead_auto_assign")
      .eq("id", biz)
      .single();
    expect(error).toBeNull();
    expect((data as { lead_auto_assign?: boolean }).lead_auto_assign).toBe(false);
  });

  it("flag ON: the rotation pick is claimed immediately, the run completes, and the contact gets an owner", async () => {
    const biz = await seedBusiness(db, "IT auto assign on");
    await db.from("businesses").update({ lead_auto_assign: true }).eq("id", biz);
    const memberId = await seedRoster(biz);
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(db, biz, routedFlow());
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    expect(run.context.vars?.claimed_agent).toBe("Dave");
    const routing = (run.context as { routing?: Record<string, unknown> }).routing;
    expect(routing?.claimed_by).toBe(AGENT_PHONE);
    expect(routing?.auto_assigned).toBe(true);
    expect(routing?.offered).toBeUndefined(); // no live offer ever existed
    // The "86" unclaim rewind target: offer mode stamps it at park time;
    // auto-assign must stamp it too or the lead can never be handed back.
    expect(routing?.route_step_index).toBe(1);

    const steps = await getSteps(db, runId);
    const route = steps.find((s) => s.step_type === "route_to_team");
    expect((route?.result as { routed?: string }).routed).toBe("auto_assigned");
    expect((route?.result as { claimed_by?: string }).claimed_by).toBe(AGENT_PHONE);
    // Claim-gated later step ran — auto-assignment counts as a claim.
    expect(steps.find((s) => s.step_type === "update_contact")?.status).toBe("done");

    // Contact ownership followed the assignment.
    const { data: contact } = await db
      .from("contacts")
      .select("owner_employee_id")
      .eq("business_id", biz)
      .eq("customer_e164", LEAD)
      .maybeSingle();
    expect((contact as { owner_employee_id?: string } | null)?.owner_employee_id).toBe(memberId);
  });

  it("flag OFF (default): route_to_team parks awaiting_agent exactly as before", async () => {
    const biz = await seedBusiness(db, "IT auto assign off");
    await seedRoster(biz);
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(db, biz, routedFlow());
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    const routing = (run.context as { routing?: Record<string, unknown> }).routing;
    expect(routing?.offered).toBe(AGENT_PHONE);
    expect(routing?.auto_assigned).toBeUndefined();
    expect(run.context.vars?.claimed_agent).not.toBe("Dave");
  });
});
