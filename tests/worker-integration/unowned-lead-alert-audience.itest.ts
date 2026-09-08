import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveContactOwnerTarget } from "../../supabase/functions/_shared/contact_owner_target";
import { createFlow, seedBusiness, seedContact, serviceDb } from "./harness";

/**
 * Unowned claim-alert audience against the local stack. A mocked query
 * builder happily "passes" a filter against `context->vars->>lead_phone`
 * or a column that does not exist; this is the proof that an omitted
 * leadTag still reads the stored seller type and does not page a
 * buyer-only teammate (Jason Lane, Amy Laidlaw, Sep 2026).
 *
 * Also pins the availability filter: a seller who is on time off is
 * dropped from the unowned broadcast, and an owned-lead page stays
 * schedule-blind.
 */

const LEAD = "+14165550194";
const DAVE = "+14165550984";
const GABBY = "+14165550985";
const JASON = "+14165550986";

let db: SupabaseClient;

type RosterIds = { dave: string; gabby: string; jason: string };

async function seedAmyLikeRoster(biz: string): Promise<RosterIds> {
  const { data, error } = await db
    .from("ai_flow_team_members")
    .insert([
      {
        business_id: biz,
        name: "Dave Lane",
        phone_e164: DAVE,
        active: true,
        tags: ["buyer", "seller", "both"]
      },
      {
        business_id: biz,
        name: "Gabrielle Mota",
        phone_e164: GABBY,
        active: true,
        tags: ["buyer", "seller", "both"]
      },
      {
        business_id: biz,
        name: "Jason Lane",
        phone_e164: JASON,
        active: true,
        tags: ["buyer"]
      }
    ])
    .select("id, name");
  if (error) throw new Error(`seedRoster: ${error.message}`);
  const byName = new Map((data ?? []).map((r) => [r.name as string, r.id as string]));
  return {
    dave: byName.get("Dave Lane")!,
    gabby: byName.get("Gabrielle Mota")!,
    jason: byName.get("Jason Lane")!
  };
}

async function insertTypedRun(biz: string, leadType: string): Promise<void> {
  const flowId = await createFlow(db, biz, {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [{ id: "noop", type: "send_sms", bodyTemplate: "type" }]
  });
  const { error } = await db.from("ai_flow_runs").insert({
    flow_id: flowId,
    business_id: biz,
    status: "completed",
    context: { vars: { lead_phone: LEAD, lead_type: leadType } }
  });
  if (error) throw new Error(`insertTypedRun: ${error.message}`);
}

async function insertTimeOff(biz: string, memberId: string): Promise<void> {
  const { error } = await db.from("employee_time_off").insert({
    business_id: biz,
    member_id: memberId,
    starts_on: "2000-01-01",
    ends_on: "2099-12-31"
  });
  if (error) throw new Error(`insertTimeOff: ${error.message}`);
}

beforeAll(() => {
  db = serviceDb();
});

describe("unowned lead alert audience (real JSON-path filter)", () => {
  it("unknown type fail-safes to every eligible teammate, including Jason", async () => {
    const biz = await seedBusiness(db, "IT unowned alert unknown type");
    await seedAmyLikeRoster(biz);
    await seedContact(db, biz, LEAD);

    const out = await resolveContactOwnerTarget(db, biz, LEAD);
    expect(out.target).toBe("team_broadcast");
    expect(out.team.map((m) => m.phone).sort()).toEqual([DAVE, GABBY, JASON].sort());
  });

  it("a stored seller run pages Dave and Gabby, not Jason, with no leadTag", async () => {
    const biz = await seedBusiness(db, "IT unowned alert seller run");
    await seedAmyLikeRoster(biz);
    await seedContact(db, biz, LEAD);
    await insertTypedRun(biz, "seller");

    const out = await resolveContactOwnerTarget(db, biz, LEAD);
    expect(out.target).toBe("team_broadcast");
    expect(out.team.map((m) => m.phone).sort()).toEqual([DAVE, GABBY].sort());
  });

  it("a contact note lead_type: seller is enough when no run established one", async () => {
    const biz = await seedBusiness(db, "IT unowned alert seller note");
    await seedAmyLikeRoster(biz);
    await seedContact(db, biz, LEAD, { pinned_md: "auto_first_contact; lead_type: seller" });

    const out = await resolveContactOwnerTarget(db, biz, LEAD);
    expect(out.target).toBe("team_broadcast");
    expect(out.team.map((m) => m.phone).sort()).toEqual([DAVE, GABBY].sort());
  });

  it("time off on both sellers falls to the owner, never onto Jason", async () => {
    const biz = await seedBusiness(db, "IT unowned alert sellers off");
    const roster = await seedAmyLikeRoster(biz);
    await seedContact(db, biz, LEAD);
    await insertTypedRun(biz, "seller");
    await insertTimeOff(biz, roster.dave);
    await insertTimeOff(biz, roster.gabby);

    const out = await resolveContactOwnerTarget(db, biz, LEAD);
    expect(out.target).toBe("business_owner");
    expect(out.reason).toBe("contact_unowned");
    expect(out.team).toEqual([]);
  });

  it("owned-lead pages stay schedule-blind even when the owner is on time off", async () => {
    const biz = await seedBusiness(db, "IT owned alert time off");
    const roster = await seedAmyLikeRoster(biz);
    await seedContact(db, biz, LEAD, { owner_employee_id: roster.dave });
    await insertTimeOff(biz, roster.dave);

    const out = await resolveContactOwnerTarget(db, biz, LEAD);
    expect(out.target).toBe("contact_owner");
    expect(out.phone).toBe(DAVE);
    expect(out.memberId).toBe(roster.dave);
  });
});
