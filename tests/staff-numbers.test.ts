import { describe, expect, it } from "vitest";
import {
  businessSelfNumbers,
  loadStaffMatcher,
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
    for (const m of ["select", "in", "limit"]) {
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
        { data: { id: "m2" }, error: null } // email arm: teammate
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
        { data: null, error: null } // email arm
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
