import { describe, expect, it } from "vitest";
import {
  CONTACT_SCOPED_TASK_TYPES,
  decideOwnerRedirect,
  resolveContactOwnerTarget,
  type OwnerContactRow,
  type OwnerMemberRow
} from "../supabase/functions/_shared/contact_owner_target";

/**
 * Who receives an urgent alert about one contact. The bug this fixes: a lead
 * Dave Lane had claimed texted asking for a callback, and all four
 * notification rows went to the business owner instead.
 *
 * Every negative path must fall DOWN to the business owner, never out — an
 * alert that reaches nobody is strictly worse than one that reaches the
 * wrong-but-responsible person.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const LEAD = "+16026160662";
const DAVE = "+16025245719";

const owned: OwnerContactRow = { id: "c1", owner_employee_id: "m1" };
const dave = (over: Partial<OwnerMemberRow> = {}): OwnerMemberRow => ({
  id: "m1",
  name: "Dave Lane",
  phone_e164: DAVE,
  email: null,
  active: true,
  ...over
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
function makeDb(results: Scripted[]) {
  const tables: string[] = [];
  let idx = 0;
  const from = (table: string) => {
    tables.push(table);
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "or", "limit", "maybeSingle"]) {
      builder[m] = () => builder;
    }
    builder["then"] = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const r = results[idx++] ?? { data: null, error: null };
      if (r.throws) return Promise.reject(new Error("boom")).catch(reject ?? (() => {}));
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null }).then(resolve);
    };
    return builder;
  };
  return { db: { from }, tables };
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

  it("skips the roster query for an unowned contact", async () => {
    const { db, tables } = makeDb([{ data: { id: "c1", owner_employee_id: null } }]);
    const out = await resolveContactOwnerTarget(db, BIZ, LEAD);
    expect(out.reason).toBe("contact_unowned");
    expect(tables).toEqual(["contacts"]);
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
