import { describe, expect, it } from "vitest";
import {
  businessSelfNumbers,
  isBusinessOwnerPhone,
  loadStaffMatcher,
  ownerAlertNumbers,
  staffNumberCheck
} from "../supabase/functions/_shared/ai_flows/staff_numbers";

/**
 * One answer to "is this our own side of the business", shared by
 * update_contact's tag protection, customer filing, and the "F" follow-up
 * reply. Reimplementing it per call site is how a teammate ends up filed as a
 * lead, or dialed by a cadence meant for customers.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";

type Scripted = { data?: unknown; error?: unknown };

/** Per-table FIFO fake: pops one scripted result per terminal await. */
function makeDb(byTable: Record<string, Scripted[]>) {
  const queues: Record<string, Scripted[]> = Object.fromEntries(
    Object.entries(byTable).map(([k, v]) => [k, [...v]])
  );
  const from = (table: string) => {
    const pop = () => Promise.resolve(queues[table]?.shift() ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "in", "limit", "not"]) {
      builder[m] = () => builder;
    }
    // `eq` is terminal for the roster LOAD (no maybeSingle) and chained for
    // everything else, so it has to be both: a thenable builder.
    builder.eq = () => builder;
    builder.then = (res: (v: unknown) => unknown) => pop().then(res);
    builder.maybeSingle = pop;
    return builder;
  };
  return { from } as never;
}

describe("staffNumberCheck", () => {
  it("trusts an owner/employee stored type without any lookup", async () => {
    const db = makeDb({});
    expect(await staffNumberCheck(db, BIZ, ["+14805550000"], "owner")).toEqual({
      staff: true,
      readFailed: false
    });
    expect(await staffNumberCheck(db, BIZ, ["+14805550000"], "employee")).toEqual({
      staff: true,
      readFailed: false
    });
  });

  it("matches an email-keyed contact against the roster's EMAILS", async () => {
    // An email-keyed contact carries no number, so the phone arm always misses
    // and the whole protection would evaporate for exactly the contacts it was
    // extended to cover. A teammate's own address must never be filed or tagged
    // as a lead.
    const db = makeDb({
      ai_flow_team_members: [
        { data: null, error: null }, // phone arm: no match
        // Stored with the casing the dashboard saved, NOT lowercased: an
        // equality done in the database would miss this teammate entirely.
        { data: [{ email: "Dave@Example.com" }], error: null }
      ]
    });
    expect(
      await staffNumberCheck(db, BIZ, ["email:dave@example.com"], "customer")
    ).toEqual({ staff: true, readFailed: false });
  });

  it("clears an email-keyed contact whose address is on nobody's roster row", async () => {
    const db = makeDb({
      ai_flow_team_members: [
        { data: null, error: null }, // phone arm
        // A null page and a row with no address both degrade to "no match"
        // rather than throwing: the filter should exclude them, but the roster
        // is the wrong place to discover a broken assumption.
        { data: [{ email: null }, { email: "  " }], error: null }
      ],
      business_telnyx_settings: [{ data: null, error: null }],
      businesses: [{ data: null, error: null }],
      notification_preferences: [{ data: null, error: null }]
    });
    expect(
      await staffNumberCheck(db, BIZ, ["email:stranger@example.com"], "customer")
    ).toEqual({ staff: false, readFailed: false });
  });

  it("treats a null roster page as no match", async () => {
    const db = makeDb({
      ai_flow_team_members: [
        { data: null, error: null }, // phone arm
        { data: null, error: null } // roster emails: null page
      ],
      business_telnyx_settings: [{ data: null, error: null }],
      businesses: [{ data: null, error: null }],
      notification_preferences: [{ data: null, error: null }]
    });
    expect(
      await staffNumberCheck(db, BIZ, ["email:stranger@example.com"], "customer")
    ).toEqual({ staff: false, readFailed: false });
  });

  it("fails SAFE when the roster email lookup errors", async () => {
    const db = makeDb({
      ai_flow_team_members: [
        { data: null, error: null },
        { data: null, error: { message: "boom" } }
      ]
    });
    expect(
      await staffNumberCheck(db, BIZ, ["email:dave@example.com"], "customer")
    ).toEqual({ staff: true, readFailed: true });
  });

  it("treats a roster hit as staff, active or not", async () => {
    const db = makeDb({ ai_flow_team_members: [{ data: { id: "m1" }, error: null }] });
    expect(await staffNumberCheck(db, BIZ, ["+16025551234"], "customer")).toEqual({
      staff: true,
      readFailed: false
    });
  });

  /**
   * The case a type check alone misses, and the one Bugbot caught on #1304:
   * owner numbers are usually derived rather than stored as an owner-typed
   * contact, so Amy's own cell is typed "customer" and would otherwise be
   * eligible for her own follow-up cadence.
   */
  it("catches a derived owner number on a contact typed customer", async () => {
    const db = makeDb({
      ai_flow_team_members: [{ data: null, error: null }],
      business_telnyx_settings: [
        { data: { telnyx_sms_from_e164: "+16028053377", forward_to_e164: "+16026951142" }, error: null }
      ],
      businesses: [{ data: { phone: "+16025559999" }, error: null }]
    });
    expect(await staffNumberCheck(db, BIZ, ["+16026951142"], "customer")).toEqual({
      staff: true,
      readFailed: false
    });
  });

  it("lets a genuine lead through", async () => {
    const db = makeDb({
      ai_flow_team_members: [{ data: null, error: null }],
      business_telnyx_settings: [
        { data: { telnyx_sms_from_e164: "+16028053377", forward_to_e164: null }, error: null }
      ],
      businesses: [{ data: { phone: null }, error: null }]
    });
    expect(await staffNumberCheck(db, BIZ, ["+15053606293"], "customer")).toEqual({
      staff: false,
      readFailed: false
    });
  });

  /**
   * Fails SAFE. Better to decline than to text, tag or dial our own people on
   * an answer we could not verify, and the flag is returned separately because
   * callers differ in what they do next.
   */
  it("counts a failed roster read as staff and says the read failed", async () => {
    const db = makeDb({
      ai_flow_team_members: [{ data: null, error: { message: "boom" } }]
    });
    expect(await staffNumberCheck(db, BIZ, ["+15053606293"], "customer")).toEqual({
      staff: true,
      readFailed: true
    });
  });
});

describe("businessSelfNumbers", () => {
  it("collects the SMS sender, the forward cell and the listed phone", async () => {
    const db = makeDb({
      business_telnyx_settings: [
        { data: { telnyx_sms_from_e164: "+16028053377", forward_to_e164: "+16026951142" }, error: null }
      ],
      businesses: [{ data: { phone: "+16025559999" }, error: null }]
    });
    expect(await businessSelfNumbers(db, BIZ)).toEqual([
      "+16028053377",
      "+16026951142",
      "+16025559999"
    ]);
  });

  it("skips whatever is not configured", async () => {
    const db = makeDb({
      business_telnyx_settings: [{ data: null, error: null }],
      businesses: [{ data: { phone: null }, error: null }]
    });
    expect(await businessSelfNumbers(db, BIZ)).toEqual([]);
  });
});


/**
 * The batch form. One inbound "F" sifts a page of recent contacts, and asking
 * per candidate re-read the roster and the business numbers every time: fifty
 * candidates became a hundred and fifty round trips on the SMS webhook path
 * (Bugbot, PR #1304).
 */
describe("loadStaffMatcher", () => {
  const scripted = () =>
    makeDb({
      ai_flow_team_members: [{ data: [{ phone_e164: "+16025552222" }], error: null }],
      business_telnyx_settings: [
        { data: { telnyx_sms_from_e164: "+16028053377", forward_to_e164: "+16026951142" }, error: null }
      ],
      businesses: [{ data: { phone: null }, error: null }]
    });

  it("answers many contacts from one pair of reads", async () => {
    const m = await loadStaffMatcher(scripted(), BIZ);
    expect(m.readFailed).toBe(false);
    // Roster member, derived forward cell, and the DID: all ours.
    expect(m.isStaff("+16025552222", "customer")).toBe(true);
    expect(m.isStaff("+16026951142", "customer")).toBe(true);
    expect(m.isStaff("+16028053377", "customer")).toBe(true);
    // Stored type still counts on its own.
    expect(m.isStaff("+15053606293", "owner")).toBe(true);
    // A genuine lead.
    expect(m.isStaff("+15053606293", "customer")).toBe(false);
  });

  // Fail safe, and say so: the caller must be able to tell "could not check"
  // from "nothing to tag".
  it("treats everything as staff when the roster read fails", async () => {
    const m = await loadStaffMatcher(
      makeDb({ ai_flow_team_members: [{ data: null, error: { message: "boom" } }] }),
      BIZ
    );
    expect(m.readFailed).toBe(true);
    expect(m.isStaff("+15053606293", "customer")).toBe(true);
  });

  it("treats a missing number as staff rather than a callable lead", async () => {
    const m = await loadStaffMatcher(scripted(), BIZ);
    expect(m.isStaff("", "customer")).toBe(true);
    expect(m.isStaff("   ", undefined)).toBe(true);
  });

  /**
   * An empty roster is a real state (a solo owner with no team), and must not
   * behave like a failed read: the owner's own derived numbers still have to
   * be caught, and everyone else is still a lead.
   */
  it("handles an empty roster and unusable roster rows", async () => {
    const m = await loadStaffMatcher(
      makeDb({
        ai_flow_team_members: [{ data: [{ phone_e164: null }, { phone_e164: "  " }], error: null }],
        business_telnyx_settings: [
          { data: { telnyx_sms_from_e164: null, forward_to_e164: "+16026951142" }, error: null }
        ],
        businesses: [{ data: { phone: null }, error: null }]
      }),
      BIZ
    );
    expect(m.readFailed).toBe(false);
    expect(m.isStaff("+16026951142", "customer")).toBe(true);
    expect(m.isStaff("+15053606293", "customer")).toBe(false);
  });

  it("handles a roster read that returns no rows at all", async () => {
    const m = await loadStaffMatcher(
      makeDb({
        ai_flow_team_members: [{ data: null, error: null }],
        business_telnyx_settings: [{ data: null, error: null }],
        businesses: [{ data: { phone: null }, error: null }]
      }),
      BIZ
    );
    expect(m.readFailed).toBe(false);
    expect(m.isStaff("+15053606293", "customer")).toBe(false);
  });
});

/**
 * ---------------------------------------------------------------------------
 * Who is the OWNER
 * ---------------------------------------------------------------------------
 *
 * An owner is not a row anywhere: they are recognized by number, and the
 * numbers live in three different tables. The "F" follow-up reply invented its
 * own version of this rule instead, filtering `businesses` on an
 * `owner_alert_e164` column that has never existed on that table. PostgREST
 * answered 400, only `data` was destructured, and the owner arm of the gate
 * was dead from the day it shipped (found Aug 28 2026). These pin the shared
 * rule so there is no fourth hand-rolled copy to go wrong.
 */
describe("ownerAlertNumbers", () => {
  it("collects the forward cell, the alert phone and the business phone", async () => {
    const db = makeDb({
      business_telnyx_settings: [{ data: { forward_to_e164: "+16026951142" }, error: null }],
      notification_preferences: [{ data: { phone_number: "+14805550001" }, error: null }],
      businesses: [{ data: { phone: "+16025559999" }, error: null }]
    });
    expect(await ownerAlertNumbers(db, BIZ)).toEqual({
      numbers: ["+16026951142", "+14805550001", "+16025559999"],
      readFailed: false
    });
  });

  /**
   * Two of the three are free-form owner-typed fields. "(602) 695-1142" and
   * "+16026951142" are one person, and a raw string compare would say
   * otherwise, which is how an owner gets locked out of their own gate.
   */
  it("normalizes free-form numbers and de-duplicates the result", async () => {
    const db = makeDb({
      business_telnyx_settings: [{ data: { forward_to_e164: "(602) 695-1142" }, error: null }],
      notification_preferences: [{ data: { phone_number: "6026951142" }, error: null }],
      businesses: [{ data: { phone: "+1 602-695-1142" }, error: null }]
    });
    expect(await ownerAlertNumbers(db, BIZ)).toEqual({
      numbers: ["+16026951142"],
      readFailed: false
    });
  });

  it("skips whatever is not configured, and unparseable junk", async () => {
    const db = makeDb({
      business_telnyx_settings: [{ data: null, error: null }],
      notification_preferences: [{ data: { phone_number: null }, error: null }],
      businesses: [{ data: { phone: "ask reception" }, error: null }]
    });
    expect(await ownerAlertNumbers(db, BIZ)).toEqual({ numbers: [], readFailed: false });
  });

  /**
   * "This person is not the owner" and "we could not find out" are different
   * answers. Collapsing them is precisely what hid the original bug for weeks,
   * so a read failure is reported and every caller stops rather than guessing.
   */
  it.each([
    ["business_telnyx_settings"],
    ["notification_preferences"],
    ["businesses"]
  ])("reports a failed read of %s rather than answering no", async (table) => {
    const scripted: Record<string, Array<{ data?: unknown; error?: unknown }>> = {
      business_telnyx_settings: [{ data: { forward_to_e164: "+16026951142" }, error: null }],
      notification_preferences: [{ data: { phone_number: null }, error: null }],
      businesses: [{ data: { phone: null }, error: null }]
    };
    scripted[table] = [{ data: null, error: { message: "boom" } }];
    expect(await ownerAlertNumbers(makeDb(scripted), BIZ)).toEqual({
      numbers: [],
      readFailed: true
    });
  });
});

describe("isBusinessOwnerPhone", () => {
  const ownerDb = () =>
    makeDb({
      business_telnyx_settings: [{ data: { forward_to_e164: "+16026951142" }, error: null }],
      notification_preferences: [{ data: { phone_number: null }, error: null }],
      businesses: [{ data: { phone: "+16026951142" }, error: null }]
    });

  it("recognizes the owner however their number was typed", async () => {
    expect(await isBusinessOwnerPhone(ownerDb(), BIZ, "+16026951142")).toEqual({
      owner: true,
      readFailed: false
    });
    expect(await isBusinessOwnerPhone(ownerDb(), BIZ, "(602) 695-1142")).toEqual({
      owner: true,
      readFailed: false
    });
  });

  it("says no for a teammate or a stranger", async () => {
    expect(await isBusinessOwnerPhone(ownerDb(), BIZ, "+14807202013")).toEqual({
      owner: false,
      readFailed: false
    });
  });

  it("says no for a number that is not a number", async () => {
    expect(await isBusinessOwnerPhone(ownerDb(), BIZ, "")).toEqual({
      owner: false,
      readFailed: false
    });
  });

  it("passes the read failure up rather than answering no", async () => {
    const db = makeDb({
      business_telnyx_settings: [{ data: null, error: { message: "boom" } }],
      notification_preferences: [{ data: null, error: null }],
      businesses: [{ data: null, error: null }]
    });
    expect(await isBusinessOwnerPhone(db, BIZ, "+16026951142")).toEqual({
      owner: false,
      readFailed: true
    });
  });
});
