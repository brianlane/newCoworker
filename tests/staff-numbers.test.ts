import { describe, expect, it } from "vitest";
import {
  businessSelfNumbers,
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
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "limit"]) {
      builder[m] = () => builder;
    }
    builder.maybeSingle = () => Promise.resolve(queues[table]?.shift() ?? { data: null, error: null });
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
