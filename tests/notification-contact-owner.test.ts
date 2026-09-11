import { describe, expect, it } from "vitest";
import {
  CONTACT_SCOPED_TASK_TYPES,
  contactIdentityPhones,
  decideOwnerRedirect,
  filterUnownedBroadcastTeam,
  resolveContactOwnerTarget,
  resolveRotationLeadTag,
  type OwnerContactRow,
  type OwnerMemberRow
} from "../supabase/functions/_shared/contact_owner_target";
/**
 * Who receives an urgent alert about one contact. The bug this fixes: a lead
 * Dave Lane had claimed texted asking for a callback, and all four
 * notification rows went to the business owner instead.
 *
 * Every negative path must fall DOWN to the business owner, never out, an
 * alert that reaches nobody is strictly worse than one that reaches the
 * wrong-but-responsible person.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const LEAD = "+16026160662";
const DAVE = "+16025245719";
const JASON = "+14807039575";

/** A roster row as the broadcast lookup selects it. */
const roster = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  name: "Dave Lane",
  phone_e164: DAVE,
  team_broadcast_enabled: null,
  tags: ["seller", "buyer"],
  ...over
});

const owned: OwnerContactRow = { id: "c1", owner_employee_id: "m1" };
/** Scripted empty park lookup. Must sit after every unowned-contact result. */
const noPark = { data: [] as unknown[] };
const dave = (over: Partial<OwnerMemberRow> = {}): OwnerMemberRow => ({
  id: "m1",
  name: "Dave Lane",
  phone_e164: DAVE,
  email: null,
  active: true,
  ...over
});

describe("contactIdentityPhones", () => {
  it("always includes the inbound number", () => {
    expect(contactIdentityPhones(LEAD, null)).toEqual([LEAD]);
  });

  it("unions the primary and aliases, dropping junk and duplicates", () => {
    expect(
      contactIdentityPhones("+1 (602) 616-0662", {
        customer_e164: LEAD,
        alias_e164s: [LEAD, "+16025550177", "", 12, "not-a-phone"]
      })
    ).toEqual([LEAD, "+16025550177"]);
  });
});

describe("decideOwnerRedirect: redirecting", () => {
  it("routes to the owning employee", () => {
    const out = decideOwnerRedirect(owned, dave());
    expect(out).toMatchObject({
      target: "contact_owner",
      memberId: "m1",
      memberName: "Dave Lane",
      phone: DAVE,
      matchedBy: "phone"
    });
  });

  it("keeps email with the business owner when the roster row has none", () => {
    // Every one of Amy's four employees has a null email, so this is the
    // live path, not an edge case. Dropping the email instead would leave a
    // redirected alert with exactly one delivery channel.
    const out = decideOwnerRedirect(owned, dave({ email: null }));
    expect(out.target).toBe("contact_owner");
    expect(out.emailTarget).toBe("business_owner");
    expect(out.email).toBeNull();
    expect(out.reason).toBe("employee_no_email");
  });

  it("redirects email too when the roster row has an address", () => {
    const out = decideOwnerRedirect(owned, dave({ email: "dave@example.com" }));
    expect(out.emailTarget).toBe("contact_owner");
    expect(out.email).toBe("dave@example.com");
    expect(out.reason).toBeNull();
  });

  it("treats a whitespace-only email as absent", () => {
    const out = decideOwnerRedirect(owned, dave({ email: "   " }));
    expect(out.emailTarget).toBe("business_owner");
    expect(out.email).toBeNull();
  });

  it("trims the phone and normalizes a blank name to null", () => {
    const out = decideOwnerRedirect(owned, dave({ phone_e164: `  ${DAVE} `, name: "  " }));
    expect(out.phone).toBe(DAVE);
    expect(out.memberName).toBeNull();
  });

  it("normalizes a null name to null", () => {
    expect(decideOwnerRedirect(owned, dave({ name: null })).memberName).toBeNull();
  });
});

describe("decideOwnerRedirect: every fallback reaches the business owner", () => {
  const cases: Array<[string, OwnerContactRow | null, OwnerMemberRow | null, string]> = [
    ["no contact row", null, null, "contact_not_found"],
    ["contact nobody owns", { id: "c1", owner_employee_id: null }, null, "contact_unowned"],
    ["roster row gone", owned, null, "member_missing"],
    ["employee left the roster", owned, dave({ active: false }), "member_inactive"],
    ["active flag absent", owned, dave({ active: null }), "member_inactive"],
    ["no phone on file", owned, dave({ phone_e164: null }), "member_no_phone"],
    ["whitespace phone", owned, dave({ phone_e164: "   " }), "member_no_phone"]
  ];
  for (const [label, contact, member, reason] of cases) {
    it(label, () => {
      const out = decideOwnerRedirect(contact, member);
      expect(out.target).toBe("business_owner");
      expect(out.emailTarget).toBe("business_owner");
      expect(out.phone).toBeNull();
      expect(out.memberId).toBeNull();
      expect(out.matchedBy).toBeNull();
      expect(out.reason).toBe(reason);
    });
  }
});

/** Chainable fake client: one scripted result per terminal await. */
type Scripted = { data?: unknown; error?: unknown; throws?: boolean };
function makeDb(results: Scripted[], rpcMode: "ok" | "error" | "throws" = "ok") {
  const tables: string[] = [];
  const orFilters: string[] = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  let idx = 0;
  const from = (table: string) => {
    tables.push(table);
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit", "maybeSingle"]) {
      builder[m] = () => builder;
    }
    builder["or"] = (arg: string) => {
      orFilters.push(arg);
      return builder;
    };
    builder["then"] = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const r = results[idx++] ?? { data: null, error: null };
      if (r.throws) return Promise.reject(new Error("boom")).catch(reject ?? (() => {}));
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null }).then(resolve);
    };
    return builder;
  };
  const rpc = async (fn: string, args: unknown) => {
    rpcCalls.push({ fn, args });
    if (rpcMode === "throws") throw new Error("telemetry down");
    return { error: rpcMode === "error" ? { message: "nope" } : null };
  };
  return { db: { from, rpc }, tables, rpcCalls, orFilters };
}

describe("resolveContactOwnerTarget", () => {
  it("resolves the owning employee end to end", async () => {
    const { db, tables } = makeDb([
      { data: owned },
      { data: dave() }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.target).toBe("contact_owner");
    expect(out.phone).toBe(DAVE);
    expect(tables).toEqual(["contacts", "ai_flow_team_members"]);
  });

  it("issues NO query at all without a usable phone", async () => {
    for (const phone of ["", "   ", null, undefined, "not a phone"]) {
      const { db, tables } = makeDb([]);
      const out = await resolveContactOwnerTarget(db, BIZ, phone);
      expect(out.target).toBe("business_owner");
      expect(out.reason).toBe("no_contact_phone");
      expect(tables).toEqual([]);
    }
  });

  /**
   * This test used to assert the OPPOSITE: that an unowned contact skipped
   * the roster query, because the answer was the business owner either way.
   * Amy's rule (2026-08-15) makes the roster the whole point of an unowned
   * lead: "unowned/unclaimed should go to all employees respective to seller
   * vs buyer employees before Amy broadcasted". The lead that forced it sat
   * two days while both of its alerts went to Amy alone.
   */
  it("reads the roster for an unowned contact and broadcasts to the team", async () => {
    // A single-row roster also consults the three owner-number sources (the
    // solo-owner rung); Dave is not the owner, so the broadcast still wins.
    const { db, tables } = makeDb([
      { data: { id: "c1", owner_employee_id: null } },
      noPark,
      { data: [roster()] },
      { data: { forward_to_e164: "+19998887777" } },
      { data: { phone_number: null } },
      { data: { phone: null } }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.target).toBe("team_broadcast");
    expect(out.reason).toBe("contact_unowned");
    expect(out.team.map((m) => m.phone)).toEqual([DAVE]);
    expect(tables).toEqual([
      "contacts",
      "ai_flow_runs",
      "ai_flow_team_members",
      "business_telnyx_settings",
      "notification_preferences",
      "businesses",
      "ai_flow_runs",
      "businesses",
      "employee_time_off"
    ]);
  });

  it("skips the owner-number reads entirely for a multi-member roster", async () => {
    const { db, tables } = makeDb([
      { data: { id: "c1", owner_employee_id: null } },
      noPark,
      { data: [roster(), roster({ id: "m2", name: "Jason Lane", phone_e164: JASON })] }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.target).toBe("team_broadcast");
    expect(tables).toEqual([
      "contacts",
      "ai_flow_runs",
      "ai_flow_team_members",
      "ai_flow_runs",
      "businesses",
      "employee_time_off"
    ]);
  });

  it("narrows the broadcast to the teammates covering that lead type", async () => {
    const { db } = makeDb([
      { data: { id: "c1", owner_employee_id: null } },
      noPark,
      { data: [roster(), roster({ id: "m2", name: "Jason Lane", phone_e164: JASON, tags: ["buyer"] })] }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD, "seller");
    expect(out.team.map((m) => m.name)).toEqual(["Dave Lane"]);
  });

  it("keeps the EMAIL with the business owner on a team broadcast", async () => {
    // Roster rows carry no address on Amy's account, so redirecting the email
    // would mean no email at all for a lead nobody has claimed.
    const { db } = makeDb([
      { data: { id: "c1", owner_employee_id: null } },
      noPark,
      { data: [roster()] }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.emailTarget).toBe("business_owner");
    expect(out.phone).toBeNull();
  });

  it("falls to the business owner when nobody is broadcast-eligible", async () => {
    const { db } = makeDb([
      { data: { id: "c1", owner_employee_id: null } },
      noPark,
      { data: [roster({ team_broadcast_enabled: false })] }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.target).toBe("business_owner");
    expect(out.reason).toBe("contact_unowned");
    expect(out.team).toEqual([]);
  });

  it("falls to the business owner when the roster read fails", async () => {
    const { db } = makeDb([
      { data: { id: "c1", owner_employee_id: null } },
      noPark,
      { error: { message: "roster down" } }
    ]);
    expect((await resolveContactOwnerTarget(db, BIZ, LEAD)).target).toBe("business_owner");
  });

  it("falls to the business owner when the roster read throws", async () => {
    const { db } = makeDb([
      { data: { id: "c1", owner_employee_id: null } },
      noPark,
      { throws: true }
    ]);
    expect((await resolveContactOwnerTarget(db, BIZ, LEAD)).target).toBe("business_owner");
  });

  it("skips the roster query when there is no contact row", async () => {
    const { db, tables } = makeDb([{ data: null }]);
    expect((await resolveContactOwnerTarget(db, BIZ, LEAD)).reason).toBe("contact_not_found");
    expect(tables).toEqual(["contacts"]);
  });

  it("falls back to the owner when the contact read errors", async () => {
    const { db } = makeDb([{ error: { message: "nope" } }]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.target).toBe("business_owner");
    expect(out.reason).toBe("lookup_failed");
  });

  it("falls back to the owner when the roster read errors", async () => {
    const { db } = makeDb([{ data: owned }, { error: { message: "nope" } }]);
    expect((await resolveContactOwnerTarget(db, BIZ, LEAD)).reason).toBe("lookup_failed");
  });

  it("falls back to the owner when a read throws", async () => {
    const { db } = makeDb([{ throws: true }]);
    expect((await resolveContactOwnerTarget(db, BIZ, LEAD)).reason).toBe("lookup_failed");
  });

  it("normalizes a loose NANP number before matching", async () => {
    const { db, tables } = makeDb([{ data: owned }, { data: dave() }]);
    const out = await resolveContactOwnerTarget(db, BIZ, "(602) 616-0662");
    expect(out.target).toBe("contact_owner");
    expect(tables).toEqual(["contacts", "ai_flow_team_members"]);
  });
});

describe("resolveContactOwnerTarget: live owner-direct park", () => {
  const unownedContact = { data: { id: "c1", owner_employee_id: null } };

  it("pages the business owner, not the team, while a keep-for-owner park is live", async () => {
    const { db, tables, rpcCalls } = makeDb([
      unownedContact,
      {
        data: [
          {
            id: "run-1",
            context: { routing: { owner_direct: true }, vars: { lead_phone: LEAD } }
          }
        ]
      }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.target).toBe("business_owner");
    expect(out.reason).toBe("owner_direct_live");
    expect(out.team).toEqual([]);
    expect(tables).toEqual(["contacts", "ai_flow_runs"]);
    const ev = rpcCalls.find((c) => c.fn === "telemetry_record")?.args as {
      p_payload: Record<string, unknown>;
    };
    expect(ev.p_payload).toMatchObject({ reason: "owner_direct_live", target: "business_owner" });
  });

  it("a newer finished park does not hide an older live one", async () => {
    // Bugbot: limit(1) + newest-first meant a just-exhausted row (still
    // queued, owner_direct_done already set) hid the live park behind it
    // and re-offered the team.
    const { db } = makeDb([
      unownedContact,
      {
        data: [
          {
            id: "run-done",
            context: { routing: { owner_direct: true, owner_direct_done: true } }
          },
          {
            id: "run-live",
            context: { routing: { owner_direct: true } }
          }
        ]
      }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.target).toBe("business_owner");
    expect(out.reason).toBe("owner_direct_live");
  });

  it("ignores a park that already finished (owner_direct_done) and broadcasts", async () => {
    const { db } = makeDb([
      unownedContact,
      {
        data: [
          {
            id: "run-1",
            context: { routing: { owner_direct: true, owner_direct_done: true } }
          }
        ]
      },
      { data: [roster(), roster({ id: "m2", name: "Jason Lane", phone_e164: JASON })] }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.target).toBe("team_broadcast");
    expect(out.reason).toBe("contact_unowned");
  });

  it("falls to the owner when the park lookup errors, never to the team", async () => {
    const { db } = makeDb([unownedContact, { error: { message: "runs down" } }]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.target).toBe("business_owner");
    expect(out.reason).toBe("lookup_failed");
  });

  it("falls to the owner when the park lookup throws, never to the team", async () => {
    const { db } = makeDb([unownedContact, { throws: true }]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.target).toBe("business_owner");
    expect(out.reason).toBe("lookup_failed");
  });
});

/**
 * The solo-owner rung (PR after #1500): a roster of exactly one ACTIVE
 * member who is provably the business owner has nobody to broadcast to but
 * themselves, so the unowned branch resolves to a plain contact-owner page
 * instead of a claim-invite broadcast. The rule must fail toward the
 * broadcast on any doubt.
 */
describe("resolveContactOwnerTarget: solo owner", () => {
  const BRIAN_PHONE = "+16026866672";
  const brianRow = (over: Record<string, unknown> = {}) => ({
    id: "m-brian",
    name: "Brian",
    phone_e164: BRIAN_PHONE,
    email: "brian@example.com",
    team_broadcast_enabled: null,
    tags: [],
    ...over
  });
  const unowned = { data: { id: "c1", owner_employee_id: null } };

  it("resolves a solo owner-only roster to the owner, not a broadcast", async () => {
    const { db, tables } = makeDb([
      unowned,
      noPark,
      { data: [brianRow()] },
      { data: { forward_to_e164: BRIAN_PHONE } },
      { data: { phone_number: null } },
      { data: { phone: null } }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out).toMatchObject({
      target: "contact_owner",
      emailTarget: "contact_owner",
      memberId: "m-brian",
      memberName: "Brian",
      phone: BRIAN_PHONE,
      email: "brian@example.com",
      matchedBy: "phone",
      reason: "solo_owner"
    });
    expect(out.team).toEqual([]);
    expect(tables).toEqual([
      "contacts",
      "ai_flow_runs",
      "ai_flow_team_members",
      "business_telnyx_settings",
      "notification_preferences",
      "businesses"
    ]);
  });

  it("keeps the email with the business owner when the roster row has none", async () => {
    const { db } = makeDb([
      unowned,
      noPark,
      { data: [brianRow({ email: null })] },
      { data: { forward_to_e164: BRIAN_PHONE } },
      { data: { phone_number: null } },
      { data: { phone: null } }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.target).toBe("contact_owner");
    expect(out.reason).toBe("solo_owner");
    expect(out.emailTarget).toBe("business_owner");
    expect(out.email).toBeNull();
  });

  it("a solo ASSISTANT keeps the team-broadcast rung", async () => {
    // The owner really can hand this lead over, so "unowned" is still news.
    const { db } = makeDb([
      unowned,
      noPark,
      { data: [brianRow({ id: "m-a", name: "Dana", phone_e164: DAVE })] },
      { data: { forward_to_e164: BRIAN_PHONE } },
      { data: { phone_number: null } },
      { data: { phone: null } }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.target).toBe("team_broadcast");
    expect(out.reason).toBe("contact_unowned");
    expect(out.team.map((m) => m.phone)).toEqual([DAVE]);
  });

  it("unreadable owner numbers fail open to the broadcast, never to a false solo match", async () => {
    const { db } = makeDb([
      unowned,
      noPark,
      { data: [brianRow()] },
      { error: { message: "down" } },
      { error: { message: "down" } },
      { error: { message: "down" } }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.target).toBe("team_broadcast");
    expect(out.reason).toBe("contact_unowned");
    expect(out.team.map((m) => m.phone)).toEqual([BRIAN_PHONE]);
  });

  it("records solo_owner routing telemetry", async () => {
    const { db, rpcCalls } = makeDb([
      unowned,
      noPark,
      { data: [brianRow()] },
      { data: { forward_to_e164: BRIAN_PHONE } },
      { data: { phone_number: null } },
      { data: { phone: null } }
    ]);
    await resolveContactOwnerTarget(db, BIZ, LEAD);
    const ev = rpcCalls.find((c) => c.fn === "telemetry_record")?.args as {
      p_event_type: string;
      p_payload: Record<string, unknown>;
    };
    expect(ev.p_event_type).toBe("notification_contact_owner_routed");
    expect(ev.p_payload).toMatchObject({
      target: "contact_owner",
      matched_by: "phone",
      reason: "solo_owner",
      team_size: 0
    });
  });
});

describe("routing telemetry", () => {
  const eventOf = (rpcCalls: Array<{ fn: string; args: unknown }>) =>
    rpcCalls.find((c) => c.fn === "telemetry_record")?.args as
      | { p_event_type: string; p_payload: Record<string, unknown> }
      | undefined;

  it("records a redirect with the reason it landed where it did", async () => {
    const { db, rpcCalls } = makeDb([{ data: owned }, { data: dave() }]);
    await resolveContactOwnerTarget(db, BIZ, LEAD);
    const ev = eventOf(rpcCalls);
    expect(ev?.p_event_type).toBe("notification_contact_owner_routed");
    expect(ev?.p_payload).toMatchObject({
      business_id: BIZ,
      target: "contact_owner",
      email_target: "business_owner",
      matched_by: "phone",
      reason: "employee_no_email"
    });
  });

  it("records the fallback too, so the ratio is measurable", async () => {
    const { db, rpcCalls } = makeDb([{ data: { id: "c1", owner_employee_id: null } }]);
    await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(eventOf(rpcCalls)?.p_payload).toMatchObject({
      target: "business_owner",
      reason: "contact_unowned"
    });
  });

  it("records a failed lookup", async () => {
    const { db, rpcCalls } = makeDb([{ throws: true }]);
    await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(eventOf(rpcCalls)?.p_payload).toMatchObject({ reason: "lookup_failed" });
  });

  it("stays silent when there was no phone to route on", async () => {
    // That path touches no database at all; an rpc would be its only IO.
    const { db, rpcCalls } = makeDb([]);
    await resolveContactOwnerTarget(db, BIZ, "");
    expect(rpcCalls).toEqual([]);
  });

  it("still returns the verdict when telemetry errors", async () => {
    const { db } = makeDb([{ data: owned }, { data: dave() }], "error");
    expect((await resolveContactOwnerTarget(db, BIZ, LEAD)).target).toBe("contact_owner");
  });

  it("still returns the verdict when telemetry throws", async () => {
    // Telemetry must never be able to break an alert.
    const { db } = makeDb([{ data: owned }, { data: dave() }], "throws");
    expect((await resolveContactOwnerTarget(db, BIZ, LEAD)).target).toBe("contact_owner");
  });
});

const GABBY = "+14807202013";
const jasonBuyer = roster({
  id: "m2",
  name: "Jason Lane",
  phone_e164: JASON,
  tags: ["buyer"]
});
const gabby = roster({
  id: "m3",
  name: "Gabrielle Mota",
  phone_e164: GABBY,
  tags: ["buyer", "seller", "both"]
});
const amyRoster = [
  roster({ tags: ["buyer", "seller", "both"] }),
  jasonBuyer
];
const amyTrio = [
  roster({ tags: ["buyer", "seller", "both"] }),
  gabby,
  jasonBuyer
];
const unowned = { data: { id: "c1", owner_employee_id: null } };
const availOk = [
  { data: { timezone: "UTC" } },
  { data: [] as unknown[] }
];

describe("resolveContactOwnerTarget: infer lead type when the caller omits it", () => {
  it("a stored seller run excludes Jason even with no leadTag argument", async () => {
    const { db } = makeDb([
      unowned,
      noPark,
      { data: amyTrio },
      { data: [{ context: { vars: { lead_phone: LEAD, lead_type: "seller" } } }] },
      ...availOk
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.team.map((m) => m.name)).toEqual(["Dave Lane", "Gabrielle Mota"]);
  });

  it("a both-type run reaches Dave and Gabby, not Jason", async () => {
    const { db } = makeDb([
      unowned,
      noPark,
      { data: amyTrio },
      { data: [{ context: { vars: { lead_type: "both" } } }] },
      ...availOk
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.team.map((m) => m.name)).toEqual(["Dave Lane", "Gabrielle Mota"]);
  });

  it("reads lead_type off the contact note when no run established one", async () => {
    const { db } = makeDb([
      { data: { id: "c1", owner_employee_id: null, pinned_md: "auto_first_contact; lead_type: seller" } },
      noPark,
      { data: amyRoster },
      { data: [] },
      ...availOk
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.team.map((m) => m.name)).toEqual(["Dave Lane"]);
  });

  it("fail-safes to everyone when stored types disagree", async () => {
    const { db } = makeDb([
      { data: { id: "c1", owner_employee_id: null, pinned_md: "lead_type: seller" } },
      noPark,
      { data: amyRoster },
      { data: [{ context: { vars: { lead_phone: LEAD, lead_type: "buyer" } } }] },
      ...availOk
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.team.map((m) => m.phone).sort()).toEqual([DAVE, JASON].sort());
  });

  it("skips the run lookup when the caller already passed a tag", async () => {
    const { db, tables } = makeDb([unowned, noPark, { data: amyRoster }, ...availOk]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD, "seller");
    expect(out.team.map((m) => m.name)).toEqual(["Dave Lane"]);
    expect(tables).toEqual([
      "contacts",
      "ai_flow_runs",
      "ai_flow_team_members",
      "businesses",
      "employee_time_off"
    ]);
  });

  it("fail-safes when the type lookup errors", async () => {
    const { db } = makeDb([
      unowned,
      noPark,
      { data: amyRoster },
      { error: { message: "runs down" } },
      ...availOk
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.team.map((m) => m.phone).sort()).toEqual([DAVE, JASON].sort());
  });

  it("fail-safes when the type lookup throws", async () => {
    const { db } = makeDb([unowned, noPark, { data: amyRoster }, { throws: true }, ...availOk]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.team.map((m) => m.phone).sort()).toEqual([DAVE, JASON].sort());
  });

  it("fail-safes when the run lookup returns a non-array payload", async () => {
    const { db } = makeDb([
      unowned,
      noPark,
      { data: amyRoster },
      { data: { context: { vars: { lead_type: "seller" } } } },
      ...availOk
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.team.map((m) => m.phone).sort()).toEqual([DAVE, JASON].sort());
  });

  it("a seller run stored on the primary still matches a text from an alias", async () => {
    const alias = "+16025550177";
    const { db, orFilters } = makeDb([
      {
        data: {
          id: "c1",
          owner_employee_id: null,
          customer_e164: LEAD,
          alias_e164s: [alias]
        }
      },
      noPark,
      { data: amyTrio },
      { data: [{ context: { vars: { lead_phone: LEAD, lead_type: "seller" } } }] },
      ...availOk
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, alias);
    expect(out.team.map((m) => m.name)).toEqual(["Dave Lane", "Gabrielle Mota"]);
    const typeLookup = orFilters.find(
      (f) => f.includes(`lead_phone.eq.${LEAD}`) && f.includes(`lead_phone.eq.${alias}`)
    );
    expect(typeLookup).toBeTruthy();
  });
});

describe("resolveContactOwnerTarget: unowned availability", () => {
  it("drops a tagged teammate who is on time off, and falls to the owner if nobody remains", async () => {
    const { db } = makeDb([
      unowned,
      noPark,
      { data: amyRoster },
      { data: [{ context: { vars: { lead_type: "seller" } } }] },
      { data: { timezone: "UTC" } },
      {
        data: [
          {
            member_id: "m1",
            starts_on: "2000-01-01",
            ends_on: "2099-12-31"
          }
        ]
      }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.target).toBe("business_owner");
    expect(out.reason).toBe("contact_unowned");
    expect(out.team).toEqual([]);
  });

  it("still pages the tagged team when the time-off lookup errors", async () => {
    const { db } = makeDb([
      unowned,
      noPark,
      { data: amyRoster },
      { data: [{ context: { vars: { lead_type: "seller" } } }] },
      { data: { timezone: "UTC" } },
      { error: { message: "time off down" } }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.team.map((m) => m.name)).toEqual(["Dave Lane"]);
  });

  it("ignores a time-off row that does not cover today", async () => {
    const { db } = makeDb([
      unowned,
      noPark,
      { data: amyRoster },
      { data: [{ context: { vars: { lead_type: "seller" } } }] },
      { data: { timezone: "UTC" } },
      {
        data: [
          {
            member_id: "m1",
            starts_on: "1999-01-01",
            ends_on: "1999-12-31"
          }
        ]
      }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.team.map((m) => m.name)).toEqual(["Dave Lane"]);
  });

  it("UTC-and-nobody-out when the availability lookup throws", async () => {
    const { db } = makeDb([
      unowned,
      noPark,
      { data: amyRoster },
      { data: [{ context: { vars: { lead_type: "seller" } } }] },
      { throws: true }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.team.map((m) => m.name)).toEqual(["Dave Lane"]);
  });

  it("UTC clock when the timezone row is missing, then still pages the tagged team", async () => {
    const { db } = makeDb([
      unowned,
      noPark,
      { data: amyRoster },
      { data: [{ context: { vars: { lead_type: "seller" } } }] },
      { data: null },
      { data: [] }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.team.map((m) => m.name)).toEqual(["Dave Lane"]);
  });

  it("UTC clock when the timezone lookup errors, then still pages the tagged team", async () => {
    const { db } = makeDb([
      unowned,
      noPark,
      { data: amyRoster },
      { data: [{ context: { vars: { lead_type: "seller" } } }] },
      { error: { message: "timezone down" } },
      { data: [] }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.team.map((m) => m.name)).toEqual(["Dave Lane"]);
  });

  it("UTC clock when the timezone column is null", async () => {
    const { db } = makeDb([
      unowned,
      noPark,
      { data: amyRoster },
      { data: [{ context: { vars: { lead_type: "seller" } } }] },
      { data: { timezone: null } },
      { data: [] }
    ]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.team.map((m) => m.name)).toEqual(["Dave Lane"]);
  });
});

describe("filterUnownedBroadcastTeam", () => {
  const clock = { isoDate: "2026-09-07", weekday: "mon" as const, minutes: 10 * 60 };
  const daveRow = roster({ tags: ["seller", "buyer", "both"] });
  const jasonRow = jasonBuyer;

  it("keeps the tagged set and drops people on time off", () => {
    const out = filterUnownedBroadcastTeam(
      [daveRow, jasonRow],
      "seller",
      new Set(["m1"]),
      clock
    );
    expect(out).toEqual([]);
  });

  it("drops a tagged teammate outside their weekly schedule", () => {
    const morning = { ...clock, minutes: 8 * 60 };
    const scheduled = roster({
      tags: ["seller"],
      weekly_schedule: { mon: [["09:00", "17:00"]] }
    });
    const out = filterUnownedBroadcastTeam([scheduled], "seller", new Set(), morning);
    expect(out).toEqual([]);
  });

  it("does not fail-safe onto Jason when the tagged sellers are all unavailable", () => {
    const out = filterUnownedBroadcastTeam(
      [daveRow, jasonRow],
      "seller",
      new Set(["m1"]),
      clock
    );
    expect(out.map((m) => m.phone)).toEqual([]);
  });

  it("leaves an untagged fail-safe audience in place when nobody is off", () => {
    const out = filterUnownedBroadcastTeam([daveRow, jasonRow], null, new Set(), clock);
    expect(out.map((m) => m.phone).sort()).toEqual([DAVE, JASON].sort());
  });

  it("returns empty when the roster itself is empty", () => {
    const out = filterUnownedBroadcastTeam([], "seller", new Set(), clock);
    expect(out).toEqual([]);
  });
});

describe("CONTACT_SCOPED_TASK_TYPES", () => {
  it("redirects the two alert kinds that are about one contact", () => {
    expect([...CONTACT_SCOPED_TASK_TYPES].sort()).toEqual([
      "sms_customer_reply",
      "sms_needs_human"
    ]);
  });

  it("leaves business-level alerts owner-addressed", () => {
    // Billing, plan and system health belong to the owner, not to whoever
    // happens to own a lead.
    for (const kind of [
      "sms_cap_reached",
      "chat_spend_cap_reached",
      "missed_call_spike",
      "aiflow_run_failed",
      "provisioning"
    ]) {
      expect(CONTACT_SCOPED_TASK_TYPES.has(kind), kind).toBe(false);
    }
  });

  it("does not gate the notify_team kinds, which redirect caller-side", () => {
    // This set gates only the Deno notifications function, which routes by
    // coworker_logs task_type. The Node dispatcher's notify_team callers
    // pass contactE164 explicitly instead, so they are correctly absent.
    for (const kind of ["sms_team_notify", "voice_team_notify"]) {
      expect(CONTACT_SCOPED_TASK_TYPES.has(kind), kind).toBe(false);
    }
  });
});

describe("resolveRotationLeadTag", () => {
  it("an explicit tag wins and issues NO query", async () => {
    const { db, tables } = makeDb([]);
    const out = await resolveRotationLeadTag(db, BIZ, LEAD, "  Seller  ", {
      vars: { lead_type: "buyer" }
    });
    expect(out).toBe("Seller");
    expect(tables).toEqual([]);
  });

  it("without a phone, returns this run's type and skips the contact lookup", async () => {
    const { db, tables } = makeDb([]);
    const out = await resolveRotationLeadTag(db, BIZ, null, undefined, {
      vars: { lead_type: "seller" }
    });
    expect(out).toBe("seller");
    expect(tables).toEqual([]);
  });

  it("infers seller from the contact note when this run has no type", async () => {
    const { db, tables } = makeDb([
      { data: { pinned_md: "auto_first_contact; lead_type: seller", customer_e164: LEAD } },
      { data: [] }
    ]);
    const out = await resolveRotationLeadTag(db, BIZ, LEAD, undefined, { vars: {} });
    expect(out).toBe("seller");
    expect(tables).toEqual(["contacts", "ai_flow_runs"]);
  });

  it("infers seller from a recent run when the contact note is empty", async () => {
    const { db } = makeDb([
      { data: { pinned_md: null, customer_e164: LEAD } },
      { data: [{ context: { vars: { lead_phone: LEAD, lead_type: "seller" } } }] }
    ]);
    const out = await resolveRotationLeadTag(db, BIZ, LEAD, undefined, { vars: {} });
    expect(out).toBe("seller");
  });

  it("fail-safes to no filter when this run and stored facts disagree", async () => {
    const { db } = makeDb([
      { data: { pinned_md: "lead_type: buyer", customer_e164: LEAD } },
      { data: [] }
    ]);
    const out = await resolveRotationLeadTag(db, BIZ, LEAD, undefined, {
      vars: { lead_type: "seller" }
    });
    expect(out).toBeNull();
  });

  it("degrades to this run's type when the contact lookup errors", async () => {
    const { db, tables } = makeDb([{ error: { message: "contacts down" } }]);
    const out = await resolveRotationLeadTag(db, BIZ, LEAD, undefined, {
      vars: { lead_type: "buyer" }
    });
    expect(out).toBe("buyer");
    expect(tables).toEqual(["contacts"]);
  });

  it("degrades to this run's type when the contact lookup throws", async () => {
    const { db } = makeDb([{ throws: true }]);
    const out = await resolveRotationLeadTag(db, BIZ, LEAD, undefined, {
      vars: { lead_type: "seller" }
    });
    expect(out).toBe("seller");
  });

  it("with no contact row and no stored type, returns no filter", async () => {
    const { db } = makeDb([{ data: null }, { data: null }]);
    const out = await resolveRotationLeadTag(db, BIZ, LEAD, undefined, { vars: {} });
    expect(out).toBeNull();
  });

  it("treats a whitespace provided tag as omitted", async () => {
    const { db } = makeDb([
      { data: { pinned_md: "lead_type: buyer", customer_e164: LEAD } },
      { data: [] }
    ]);
    const out = await resolveRotationLeadTag(db, BIZ, LEAD, "   ", { vars: {} });
    expect(out).toBe("buyer");
  });
});
