import { beforeAll, describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFlow, enqueueRun, seedBusiness, seedContact, serviceDb, tickWorker } from "./harness";

/**
 * The shape of the owner_assigned contact event a route_to_team claim emits.
 *
 * Amy Laidlaw's "Clever - Spoke Check & Weekly Call Follow-Up" flow triggers
 * on owner_assigned with a `contains "clever"` condition, which reads the
 * `tags: …` line of the event text. The claim path knows the lead's phone
 * and nothing else, so the event rendered as three lines (event / phone /
 * owner) and that condition could never match. The flow sat enabled with
 * zero runs while the tenant was billed for it.
 *
 * The worker is where this has to be proven: the identity fields are read
 * from the contacts row, so a mocked client can only show that the code
 * asks for them, not that a real claim produces a matching run.
 */

const LEAD = "+14165550177";
const AGENT_PHONE = "+14165550991";

/** Auto-assign turns one tick into a full claim, which is what fires the event. */
function claimingFlow(): Record<string, unknown> {
  const def = {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [
      {
        id: "route",
        type: "route_to_team",
        offerTemplate: "New lead, reply 1 to claim.",
        ownerFallbackTemplate: "No one claimed it, back to you.",
        responseMinutes: 10
      }
    ]
  };
  parseAiFlowDefinition(def);
  return def;
}

/** The Clever spoke-check trigger, verbatim: a tag condition on the event text. */
function spokeCheckFlow(): Record<string, unknown> {
  const def = {
    version: 1,
    trigger: {
      channel: "owner_assigned",
      conditions: [{ type: "contains", value: "clever", caseInsensitive: true }]
    },
    steps: [{ id: "week_1_sleep", type: "sleep", minutes: 10080 }]
  };
  parseAiFlowDefinition(def);
  return def;
}

let db: SupabaseClient;

async function seedRoster(biz: string): Promise<string> {
  const { data, error } = await db
    .from("ai_flow_team_members")
    .insert({ business_id: biz, name: "Dave Lane", phone_e164: AGENT_PHONE, active: true })
    .select("id")
    .single();
  if (error) throw new Error(`seedRoster: ${error.message}`);
  return (data as { id: string }).id;
}

/** Every run of a flow, with the trigger scope the enqueue wrote. */
async function runsFor(
  flowId: string
): Promise<Array<{ context: { trigger?: Record<string, unknown> } }>> {
  const { data, error } = await db.from("ai_flow_runs").select("context").eq("flow_id", flowId);
  if (error) throw new Error(`runsFor: ${error.message}`);
  return data as Array<{ context: { trigger?: Record<string, unknown> } }>;
}

/** One business set up to claim LEAD on the next tick. */
async function seedClaimScenario(
  name: string,
  contactOver: Record<string, unknown>
): Promise<{ biz: string; watcherId: string }> {
  const biz = await seedBusiness(db, name);
  await db.from("businesses").update({ lead_auto_assign: true }).eq("id", biz);
  await seedRoster(biz);
  await seedContact(db, biz, LEAD, contactOver);
  const watcherId = await createFlow(db, biz, spokeCheckFlow());
  const claimId = await createFlow(db, biz, claimingFlow());
  // No extract_text step: leadContactPhone falls back to the trigger's
  // `from`, which keeps this test off the AI path entirely.
  await enqueueRun(db, claimId, biz, {
    channel: "sms",
    from: LEAD,
    windowText: `New lead submitted. Phone: ${LEAD}.`
  });
  return { biz, watcherId };
}

beforeAll(() => {
  db = serviceDb();
});

describe("owner_assigned event shape (real worker)", () => {
  it("a claim gives the event the contact's name, email, and tags, so a tag condition matches", async () => {
    const { watcherId } = await seedClaimScenario("IT owner event hydrated", {
      display_name: "Joe Seller",
      email: "joe.seller@example.com",
      tags: ["Clever", "Seller"]
    });

    await tickWorker();

    const runs = await runsFor(watcherId);
    expect(runs).toHaveLength(1);
    const text = String(runs[0].context.trigger?.windowText ?? "");
    // The documented shape, not just the three lines the claim had in hand.
    expect(text).toContain("name: Joe Seller");
    expect(text).toContain(`phone: ${LEAD}`);
    expect(text).toContain("email: joe.seller@example.com");
    expect(text).toContain("tags: Clever, Seller");
    expect(text).toContain("owner: Dave Lane");
    // Templates and extract_text read these too.
    expect(runs[0].context.trigger?.contact_name).toBe("Joe Seller");
    expect(runs[0].context.trigger?.contact_email).toBe("joe.seller@example.com");
  });

  it("still enrolls nobody when the contact does not carry the tag", async () => {
    // Hydration must not turn a narrow trigger into a catch-all: the same
    // claim on an untagged lead enqueues nothing.
    const { watcherId } = await seedClaimScenario("IT owner event untagged", {
      display_name: "Pat Buyer",
      tags: ["Buyer"]
    });

    await tickWorker();

    expect(await runsFor(watcherId)).toHaveLength(0);
  });
});
