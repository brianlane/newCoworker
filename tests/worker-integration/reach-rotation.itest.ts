import { beforeAll, describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createFlow,
  enqueueRun,
  seedBusiness,
  seedContact,
  serviceDb,
  tickWorker
} from "./harness";

/**
 * reachTeammate.rotateFirst against the REAL worker + Postgres: the
 * round-robin cursor (`ai_flow_team_members.last_reach_first_at`) must be
 * read and stamped at dial time, so two teammates genuinely alternate who
 * rings first across calls while the last resort keeps its slot.
 *
 * The rotation + stamp happen BEFORE the originate POST by design (the
 * chosen order IS what gets dialed), so these assertions hold even though
 * no real call can leave this harness. The ordering rule itself is pinned
 * exhaustively in tests/reach-rotation.test.ts; what needs a real database
 * is the persistence: cursor read, reorder, stamp, and alternation on the
 * NEXT run.
 */

const LEAD = "+14165550177";
const DAVE = "+14165550993";
const GABBY = "+14165550994";
const AMY = "+14165550995";

let db: SupabaseClient;

async function seedRoster(biz: string): Promise<{ dave: string; gabby: string; amy: string }> {
  const { data, error } = await db
    .from("ai_flow_team_members")
    .insert([
      { business_id: biz, name: "Dave Lane", phone_e164: DAVE, active: true },
      { business_id: biz, name: "Gabrielle Mota", phone_e164: GABBY, active: true },
      { business_id: biz, name: "Amy Laidlaw", phone_e164: AMY, active: true }
    ])
    .select("id, name");
  if (error) throw new Error(`seedRoster: ${error.message}`);
  const byName = new Map((data ?? []).map((r) => [r.name as string, r.id as string]));
  return {
    dave: byName.get("Dave Lane")!,
    gabby: byName.get("Gabrielle Mota")!,
    amy: byName.get("Amy Laidlaw")!
  };
}

function ladderFlow(ids: { dave: string; gabby: string; amy: string }): Record<string, unknown> {
  const ref = (id: string, label: string) => ({ source: "employee", id, label });
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
        id: "ai_call_1",
        type: "place_ai_call",
        toVar: "lead_phone",
        personaTemplate: "Hi, is now a good time?",
        notifyFirstReachTarget: true,
        reachTeammate: {
          refs: [
            ref(ids.dave, "Dave Lane"),
            ref(ids.gabby, "Gabrielle Mota"),
            ref(ids.amy, "Amy Laidlaw")
          ],
          rotateFirst: 2,
          ringSeconds: 20
        },
        saveAs: "call_outcome"
      }
    ]
  };
  parseAiFlowDefinition(def);
  return def;
}

const TRIGGER = {
  channel: "sms",
  from: LEAD,
  windowText: `New seller lead. Phone: ${LEAD}. Wants to sell.`
};

async function cursorOf(memberId: string): Promise<string | null> {
  const { data, error } = await db
    .from("ai_flow_team_members")
    .select("last_reach_first_at")
    .eq("id", memberId)
    .single();
  if (error) throw new Error(error.message);
  return (data as { last_reach_first_at: string | null }).last_reach_first_at;
}

beforeAll(() => {
  db = serviceDb();
});

describe("reach ladder rotation cursor", () => {
  it("stamps the never-first teammate on run one, the OTHER on run two, and never the last resort", async () => {
    const biz = await seedBusiness(db, "Rotation Ladder Test");
    const ids = await seedRoster(biz);
    await seedContact(db, biz, LEAD);

    // Dave rang first recently; Gabby never has. Gabby is owed the turn.
    const { error: preErr } = await db
      .from("ai_flow_team_members")
      .update({ last_reach_first_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
      .eq("id", ids.dave);
    if (preErr) throw new Error(preErr.message);

    const flowId = await createFlow(db, biz, ladderFlow(ids));
    await enqueueRun(db, flowId, biz, TRIGGER);
    await tickWorker();

    const gabbyStamp = await cursorOf(ids.gabby);
    expect(gabbyStamp).not.toBeNull();
    // Dave's old stamp is untouched: he did not ring first this time.
    const daveStamp = await cursorOf(ids.dave);
    expect(new Date(daveStamp!).getTime()).toBeLessThan(new Date(gabbyStamp!).getTime());
    // Amy sits past the rotation window and must never be stamped.
    expect(await cursorOf(ids.amy)).toBeNull();

    // Run two: Dave is now the least-recently-first, so HE gets stamped.
    await enqueueRun(db, flowId, biz, TRIGGER);
    await tickWorker();
    const daveStamp2 = await cursorOf(ids.dave);
    expect(new Date(daveStamp2!).getTime()).toBeGreaterThan(new Date(gabbyStamp!).getTime());
    // Gabby's stamp did not advance on run two.
    expect(await cursorOf(ids.gabby)).toBe(gabbyStamp);
    expect(await cursorOf(ids.amy)).toBeNull();
  }, 120_000);
});
