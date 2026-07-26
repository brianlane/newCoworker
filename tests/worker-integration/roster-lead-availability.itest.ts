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
 * PER-EMPLOYEE LEAD AVAILABILITY, pinned against the REAL served worker and a
 * REAL local Postgres.
 *
 * The shape this exists for (Amy Laidlaw, Jul 2026): routing HomeLight to Amy
 * AND Dave simultaneously required Amy on the roster, because broadcast claims
 * are matched by roster phone. Roster membership is global, so that one change
 * also entered the owner into the round-robin rotation of every unpinned
 * route_to_team step in the tenant. Three independent flags separate the three
 * ways the engine picks a recipient, and the case below is exactly hers:
 * rotation OFF, named group offers ON, whole-team offers OFF.
 *
 * Offer SMS cannot leave this harness (no Telnyx env). Those sends are
 * best-effort by design (the park/claim state is the durable fact), so every
 * scenario completes, which doubles as coverage for that failure path.
 */

const LEAD = "+14165550166";
const DAVE = "+14165550991";
const AMY = "+14165550992";

/** Unpinned route step: the whole active roster rotates through it. */
function rotationFlow(): Record<string, unknown> {
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
        offerTemplate: "New lead {{vars.lead_phone}}, reply 1 to claim.",
        ownerFallbackTemplate: "No one claimed {{vars.lead_phone}}, back to you.",
        responseMinutes: 10
      }
    ]
  };
  parseAiFlowDefinition(def);
  return def;
}

/** Pinned to ONE named member: the case the rotation flag also governs. */
function pinnedFlow(agentName: string): Record<string, unknown> {
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
        agentName,
        offerTemplate: "New lead {{vars.lead_phone}}, reply 1 to claim.",
        ownerFallbackTemplate: "No one claimed {{vars.lead_phone}}, back to you.",
        responseMinutes: 10
      }
    ]
  };
  parseAiFlowDefinition(def);
  return def;
}

/** Named broadcast (Amy's HomeLight shape) or a whole-roster fan-out. */
function broadcastFlow(mode: "named" | "all"): Record<string, unknown> {
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
        ...(mode === "named"
          ? { agentNames: ["Dave Lane", "Amy Laidlaw"] }
          : { broadcastAll: true }),
        offerTemplate: "New lead {{vars.lead_phone}}, reply 1 to claim or 2 to pass.",
        ownerFallbackTemplate: "No one claimed {{vars.lead_phone}}, back to you.",
        responseMinutes: 10
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

type Availability = {
  routing_enabled: boolean;
  named_routing_enabled: boolean;
  named_broadcast_enabled: boolean;
  team_broadcast_enabled: boolean;
};

/** Every flag on, the column defaults, spelled out. */
const ALL_ON: Availability = {
  routing_enabled: true,
  named_routing_enabled: true,
  named_broadcast_enabled: true,
  team_broadcast_enabled: true
};

let db: SupabaseClient;

/**
 * Amy is deliberately FIRST in rotation order (null last_offered_at sorts
 * ahead of Dave's recent stamp), so "Dave was offered the lead" can only mean
 * the flag excluded her, never that the cursor happened to favor him.
 *
 * Every flag is spelled out on BOTH rows: PostgREST unions the keys across a
 * multi-row insert, so a row that omits them would be sent an explicit NULL
 * and trip the NOT NULL constraint rather than falling to the default.
 */
async function seedRoster(biz: string, amy: Availability, dave: Availability = ALL_ON) {
  const { error } = await db.from("ai_flow_team_members").insert([
    {
      business_id: biz,
      name: "Dave Lane",
      phone_e164: DAVE,
      active: true,
      last_offered_at: new Date().toISOString(),
      ...dave
    },
    { business_id: biz, name: "Amy Laidlaw", phone_e164: AMY, active: true, ...amy }
  ]);
  if (error) throw new Error(`seedRoster: ${error.message}`);
}

/** Returns the business too, since some assertions read its system_logs. */
async function seedRun(
  name: string,
  amy: Availability,
  definition: Record<string, unknown>
): Promise<{ biz: string; runId: string }> {
  const biz = await seedBusiness(db, name);
  await seedRoster(biz, amy);
  await seedContact(db, biz, LEAD);
  const flowId = await createFlow(db, biz, definition);
  return { biz, runId: await enqueueRun(db, flowId, biz, TRIGGER) };
}

/** The newest no-agent-available log for a business, or undefined. */
async function noAgentLog(
  biz: string
): Promise<{ message: string; payload: Record<string, unknown> } | undefined> {
  const { data } = await db
    .from("system_logs")
    .select("message, payload")
    .eq("business_id", biz)
    .eq("event", "ai_flow_no_agent_available")
    .limit(1);
  return (data ?? [])[0] as
    | { message: string; payload: Record<string, unknown> }
    | undefined;
}

function routingOf(run: Awaited<ReturnType<typeof getRun>>): Record<string, unknown> {
  return ((run.context as { routing?: Record<string, unknown> }).routing ?? {}) as Record<
    string,
    unknown
  >;
}

/** Amy's live configuration: reachable by name, never by the engine's choice. */
const AMY_NAMED_ONLY: Availability = {
  routing_enabled: false,
  named_routing_enabled: true,
  named_broadcast_enabled: true,
  team_broadcast_enabled: false
};

beforeAll(() => {
  db = serviceDb();
});

describe("per-employee lead availability (real worker)", () => {
  it("ships all four flags default ON, so an existing roster keeps its behavior", async () => {
    const biz = await seedBusiness(db, "IT availability defaults");
    const { data, error } = await db
      .from("ai_flow_team_members")
      .insert({ business_id: biz, name: "Dave Lane", phone_e164: DAVE, active: true })
      .select(
        "routing_enabled, named_routing_enabled, named_broadcast_enabled, team_broadcast_enabled"
      )
      .single();
    if (error) throw new Error(error.message);
    expect(data).toEqual({
      routing_enabled: true,
      named_routing_enabled: true,
      named_broadcast_enabled: true,
      team_broadcast_enabled: true
    });
  });

  it("rotation skips the opted-out member and offers the lead to the next person", async () => {
    const { runId } = await seedRun(
      "IT availability rotation skip",
      AMY_NAMED_ONLY,
      rotationFlow()
    );

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    expect(routingOf(run).offered).toBe(DAVE);
  });

  it("a pin still reaches a rotation-off member: being asked for by name is its own permission", async () => {
    const { runId } = await seedRun(
      "IT availability pin by name",
      AMY_NAMED_ONLY,
      pinnedFlow("Amy Laidlaw")
    );

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    expect(routingOf(run).offered).toBe(AMY);
  });

  it("turning off named leads blocks the pin and falls through to the owner", async () => {
    const { biz, runId } = await seedRun(
      "IT availability pin blocked",
      { ...AMY_NAMED_ONLY, named_routing_enabled: false },
      pinnedFlow("Amy Laidlaw")
    );

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    // Never silently redirected to another teammate.
    expect(routingOf(run).offered).toBeUndefined();
    expect(run.context.vars?.claimed_agent).toBe("none");
    const route = (await getSteps(db, runId)).find((s) => s.step_type === "route_to_team");
    expect((route?.result as { routed?: string }).routed).toBe("owner_fallback");

    // The log must name the switch for the mode that was tried, or the owner
    // goes looking at "lead rotation" for a pin that named leads blocked.
    const log = await noAgentLog(biz);
    expect(log?.message).toContain("named leads turned off");
    expect(log?.payload?.mode).toBe("named_routing");
  });

  it("a pin on a member who still takes rotation leads is unaffected", async () => {
    const { runId } = await seedRun(
      "IT availability pin allowed",
      AMY_NAMED_ONLY,
      pinnedFlow("Dave Lane")
    );

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    expect(routingOf(run).offered).toBe(DAVE);
  });

  it("a named group offer still reaches her: rotation off does not mean unreachable", async () => {
    const { runId } = await seedRun(
      "IT availability named broadcast",
      AMY_NAMED_ONLY,
      broadcastFlow("named")
    );

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    const routing = routingOf(run);
    expect(routing.offered_all).toEqual([DAVE, AMY]);
    expect(routing.offered_names).toEqual({ [DAVE]: "Dave Lane", [AMY]: "Amy Laidlaw" });
  });

  it("the whole-team fan-out leaves her out while still reaching the rest of the team", async () => {
    const { runId } = await seedRun(
      "IT availability team broadcast",
      AMY_NAMED_ONLY,
      broadcastFlow("all")
    );

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    expect(routingOf(run).offered_all).toEqual([DAVE]);
  });

  it("opting out of named offers removes her from that list too", async () => {
    const { runId } = await seedRun(
      "IT availability named off",
      { ...ALL_ON, named_broadcast_enabled: false },
      broadcastFlow("named")
    );

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    expect(routingOf(run).offered_all).toEqual([DAVE]);
  });

  it("everyone opted out of rotation hands the lead to the owner and says why", async () => {
    const biz = await seedBusiness(db, "IT availability all off");
    await seedRoster(biz, AMY_NAMED_ONLY, { ...ALL_ON, routing_enabled: false });
    await seedContact(db, biz, LEAD);
    const flowId = await createFlow(db, biz, rotationFlow());
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    expect(run.context.vars?.claimed_agent).toBe("none");

    // The operator-facing log names the cause an owner can actually act on,
    // instead of blaming time off.
    const log = await noAgentLog(biz);
    expect(log?.message).toContain("lead rotation turned off");
    expect(log?.payload?.mode).toBe("rotation");
    expect(log?.payload?.opted_out).toBe(2);
  });
});
