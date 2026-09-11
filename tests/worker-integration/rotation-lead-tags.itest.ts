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
 * Unpinned route_to_team rotation honors roster tags.
 *
 * The shape this exists for (Amy Laidlaw, Sep 2026): Jason Lane is
 * routing_enabled with tags ["buyer"] only. Unclaimed Clever spoke-check
 * offers used to text him every seller because rotation ignored tags. Jason
 * is first in last_offered_at order here, so "Dave was offered" can only
 * mean the tag filter skipped him, never that the cursor favored Dave.
 *
 * Offer SMS cannot leave this harness (no Telnyx env). Those sends are
 * best-effort by design, so every scenario completes.
 */

const LEAD = "+14165550177";
const DAVE = "+14165550981";
const JASON = "+14165550982";

function rotationFlow(over: Record<string, unknown> = {}): Record<string, unknown> {
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
        responseMinutes: 10,
        ...over
      }
    ]
  };
  parseAiFlowDefinition(def);
  return def;
}

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

const TRIGGER = {
  channel: "sms",
  from: LEAD,
  windowText: `New lead submitted. Phone: ${LEAD}. Product: Auto.`
};

let db: SupabaseClient;

async function seedRoster(biz: string) {
  const { error } = await db.from("ai_flow_team_members").insert([
    {
      business_id: biz,
      name: "Dave Lane",
      phone_e164: DAVE,
      active: true,
      routing_enabled: true,
      named_routing_enabled: true,
      named_broadcast_enabled: true,
      team_broadcast_enabled: true,
      tags: ["buyer", "seller", "both"],
      last_offered_at: new Date().toISOString()
    },
    {
      business_id: biz,
      name: "Jason Lane",
      phone_e164: JASON,
      active: true,
      routing_enabled: true,
      named_routing_enabled: true,
      named_broadcast_enabled: true,
      team_broadcast_enabled: true,
      tags: ["buyer"]
    }
  ]);
  if (error) throw new Error(`seedRoster: ${error.message}`);
}

async function seedRun(
  name: string,
  definition: Record<string, unknown>,
  contactOver: Record<string, unknown> = {}
): Promise<{ biz: string; runId: string }> {
  const biz = await seedBusiness(db, name);
  await seedRoster(biz);
  await seedContact(db, biz, LEAD, contactOver);
  const flowId = await createFlow(db, biz, definition);
  return {
    biz,
    runId: await enqueueRun(db, flowId, biz, TRIGGER, { lead_phone: LEAD })
  };
}

function routingOf(run: Awaited<ReturnType<typeof getRun>>): Record<string, unknown> {
  return ((run.context as { routing?: Record<string, unknown> }).routing ?? {}) as Record<
    string,
    unknown
  >;
}

beforeAll(() => {
  db = serviceDb();
});

describe("rotation honors roster tags (real worker)", () => {
  it("a seller contact skips buyer-only Jason and offers Dave", async () => {
    const { runId } = await seedRun("IT rotation tag seller", rotationFlow(), {
      pinned_md: "lead_type: seller"
    });

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    expect(routingOf(run).offered).toBe(DAVE);
  });

  it("a buyer contact still offers Jason first", async () => {
    const { runId } = await seedRun("IT rotation tag buyer", rotationFlow(), {
      pinned_md: "lead_type: buyer"
    });

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    expect(routingOf(run).offered).toBe(JASON);
  });

  it("a missing type fails safe and still offers Jason first", async () => {
    const { runId } = await seedRun("IT rotation tag none", rotationFlow());

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    expect(routingOf(run).offered).toBe(JASON);
  });

  it("an explicit teamTagTemplate seller skips Jason without stored type", async () => {
    const { runId } = await seedRun(
      "IT rotation tag template",
      rotationFlow({ teamTagTemplate: "seller" })
    );

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    expect(routingOf(run).offered).toBe(DAVE);
  });

  it("a pin to Jason on a seller still reaches him", async () => {
    const { runId } = await seedRun("IT rotation tag pin", pinnedFlow("Jason Lane"), {
      pinned_md: "lead_type: seller"
    });

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("awaiting_agent");
    expect(routingOf(run).offered).toBe(JASON);
  });
});
