import { describe, expect, it } from "vitest";

import {
  MAX_DYNAMIC_COLUMNS,
  MAX_LEAD_DATA_ROWS,
  buildLeadDataRows,
  dynamicFieldColumns,
  isFixedColumnField,
  type LeadContactRow,
  type LeadDataRow,
  type LeadSubmissionRow
} from "@/lib/leads/data-view";

function sub(over: Partial<LeadSubmissionRow> = {}): LeadSubmissionRow {
  return {
    source: "facebook_lead_ads",
    leadgen_id: "1993202861289031",
    fields: { skin_concern: "Melasma", readiness: "Ready to book" },
    phone_e164: "+16025551234",
    email: "jane@example.com",
    created_at: "2026-07-20T10:00:00.000Z",
    ...over
  };
}

function contact(over: Partial<LeadContactRow> = {}): LeadContactRow {
  return {
    customer_e164: "+16025551234",
    alias_e164s: null,
    display_name: "Jane Lead",
    email: "jane@example.com",
    summary_md: null,
    tags: ["New Lead"],
    owner_employee_id: null,
    created_at: "2026-07-19T09:00:00.000Z",
    updated_at: "2026-07-20T11:00:00.000Z",
    ...over
  };
}

const EMPTY_MAPS = {
  contactNames: new Map<string, { name: string }>(),
  employeeNameById: new Map<string, string>()
};

describe("isFixedColumnField", () => {
  it("filters plumbing keys, phone keys, email keys, and name keys", () => {
    for (const key of [
      "leadgen_id",
      "form_id",
      "ad_id",
      "page_id",
      "created_time",
      "phone_number",
      "Mobile",
      "email",
      "lead_email",
      "full_name",
      "name"
    ]) {
      expect(isFixedColumnField(key), key).toBe(true);
    }
    for (const key of ["skin_concern", "readiness", "lead_score", "budget"]) {
      expect(isFixedColumnField(key), key).toBe(false);
    }
  });
});

describe("dynamicFieldColumns", () => {
  const row = (fields: Record<string, string>): LeadDataRow => ({
    e164: null,
    name: "Lead",
    email: null,
    tags: [],
    ownerEmployeeId: null,
    ownerName: null,
    source: null,
    fields,
    createdAt: "2026-07-20T10:00:00.000Z",
    hasContact: false
  });

  it("unions keys in first-seen order, skipping fixed-column keys", () => {
    expect(
      dynamicFieldColumns([
        row({ skin_concern: "x", phone_number: "+16025551234" }),
        row({ readiness: "y", skin_concern: "z" })
      ])
    ).toEqual(["skin_concern", "readiness"]);
  });

  it("caps the column count", () => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < MAX_DYNAMIC_COLUMNS + 5; i++) fields[`q${i}`] = "a";
    expect(dynamicFieldColumns([row(fields)]).length).toBe(MAX_DYNAMIC_COLUMNS);
  });
});

describe("buildLeadDataRows", () => {
  it("folds a submission onto its contact by phone (newest submission wins)", () => {
    const rows = buildLeadDataRows({
      submissions: [
        sub({ created_at: "2026-07-18T10:00:00.000Z", fields: { old: "1" } }),
        sub({ created_at: "2026-07-20T10:00:00.000Z", fields: { fresh: "2" } })
      ],
      contacts: [contact()],
      ...EMPTY_MAPS
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      e164: "+16025551234",
      name: "Jane Lead",
      tags: ["New Lead"],
      source: "facebook_lead_ads",
      fields: { fresh: "2" },
      createdAt: "2026-07-20T10:00:00.000Z",
      hasContact: true
    });
  });

  it("matches through aliases and by email, prefers resolved contact names", () => {
    const rows = buildLeadDataRows({
      submissions: [
        sub({ phone_e164: "+16025550000" }), // an alias of the contact
        sub({
          phone_e164: null,
          email: "Bob@Example.com",
          created_at: "2026-07-21T10:00:00.000Z",
          fields: { q: "1" }
        })
      ],
      contacts: [
        contact({ alias_e164s: ["+16025550000"] }),
        contact({
          customer_e164: "+14805551111",
          display_name: null,
          email: "bob@example.com",
          tags: []
        })
      ],
      contactNames: new Map([["+16025551234", { name: "Jane Overlay" }]]),
      employeeNameById: new Map()
    });
    const jane = rows.find((r) => r.e164 === "+16025551234");
    const bob = rows.find((r) => r.e164 === "+14805551111");
    expect(jane?.name).toBe("Jane Overlay");
    expect(bob?.hasContact).toBe(true);
    expect(bob?.name).toBe("+14805551111");
  });

  it("renders submission-only leads (no contact yet) with a name from the fields", () => {
    const rows = buildLeadDataRows({
      submissions: [
        sub({
          phone_e164: "+17025559999",
          fields: { full_name: "Sam New", budget: "5k" }
        })
      ],
      contacts: [],
      ...EMPTY_MAPS
    });
    expect(rows).toEqual([
      expect.objectContaining({
        e164: "+17025559999",
        name: "Sam New",
        email: "jane@example.com",
        source: "facebook_lead_ads",
        hasContact: false
      })
    ]);
  });

  it("falls back to phone, then email, then 'Lead' for a nameless submission", () => {
    const noName = { fields: { budget: "5k" } };
    const byPhone = buildLeadDataRows({
      submissions: [sub({ ...noName, phone_e164: "+17025559999" })],
      contacts: [],
      ...EMPTY_MAPS
    });
    expect(byPhone[0].name).toBe("+17025559999");

    const byEmail = buildLeadDataRows({
      submissions: [sub({ ...noName, phone_e164: null, email: "x@y.co" })],
      contacts: [],
      ...EMPTY_MAPS
    });
    expect(byEmail[0].name).toBe("x@y.co");
    expect(byEmail[0].e164).toBeNull();

    // A blank name field must not win over the fallback.
    const blankName = buildLeadDataRows({
      submissions: [
        sub({ phone_e164: "+17025559999", fields: { name: "  ", budget: "5k" } })
      ],
      contacts: [],
      ...EMPTY_MAPS
    });
    expect(blankName[0].name).toBe("+17025559999");
  });

  it("gives identifier-less submissions their own visible rows", () => {
    const rows = buildLeadDataRows({
      submissions: [
        sub({ phone_e164: null, email: null, fields: { note: "walk-in" } }),
        sub({ phone_e164: null, email: null, fields: { note: "other walk-in" } })
      ],
      contacts: [],
      ...EMPTY_MAPS
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.name === "Lead" && !r.hasContact)).toBe(true);
  });

  it("includes tagged contacts with no submission, skips untagged ones", () => {
    const rows = buildLeadDataRows({
      submissions: [],
      contacts: [
        contact({ customer_e164: "+16025551234", tags: ["Booked"] }),
        contact({ customer_e164: "+14805551111", tags: [], display_name: "No Tags" }),
        contact({ customer_e164: "+15055552222", tags: null, display_name: "Null Tags" })
      ],
      ...EMPTY_MAPS
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      e164: "+16025551234",
      tags: ["Booked"],
      source: null,
      fields: {},
      createdAt: "2026-07-19T09:00:00.000Z"
    });
  });

  it("shows the owner badge from the roster map (null when the roster lacks the id)", () => {
    const rows = buildLeadDataRows({
      submissions: [],
      contacts: [
        contact({ owner_employee_id: "emp-1" }),
        contact({ customer_e164: "+14805551111", owner_employee_id: "emp-gone" })
      ],
      contactNames: new Map(),
      employeeNameById: new Map([["emp-1", "Alex"]])
    });
    const known = rows.find((r) => r.e164 === "+16025551234");
    const unknown = rows.find((r) => r.e164 === "+14805551111");
    expect(known).toMatchObject({ ownerEmployeeId: "emp-1", ownerName: "Alex" });
    expect(unknown).toMatchObject({ ownerEmployeeId: "emp-gone", ownerName: null });
  });

  it("keeps the FIRST claim when two contacts share an alias", () => {
    const rows = buildLeadDataRows({
      submissions: [sub({ phone_e164: "+16025550000" })],
      contacts: [
        contact({ alias_e164s: ["+16025550000"] }),
        contact({
          customer_e164: "+14805551111",
          alias_e164s: ["+16025550000"],
          tags: ["Booked"]
        })
      ],
      ...EMPTY_MAPS
    });
    // The submission lands on the first claimant; the second contact still
    // renders as a tag-only row.
    expect(rows.find((r) => r.e164 === "+16025551234")?.source).toBe(
      "facebook_lead_ads"
    );
    expect(rows.find((r) => r.e164 === "+14805551111")?.source).toBeNull();
  });

  it("falls back to the submission's email when the contact has none", () => {
    const withSub = buildLeadDataRows({
      submissions: [sub()],
      contacts: [contact({ email: null })],
      ...EMPTY_MAPS
    });
    expect(withSub[0].email).toBe("jane@example.com");

    const without = buildLeadDataRows({
      submissions: [],
      contacts: [contact({ email: null })],
      ...EMPTY_MAPS
    });
    expect(without[0].email).toBeNull();
  });

  it("keeps a stable order for rows with identical timestamps", () => {
    const at = "2026-07-20T10:00:00.000Z";
    const rows = buildLeadDataRows({
      submissions: [
        sub({ phone_e164: "+17025550001", email: null, created_at: at }),
        sub({ phone_e164: "+17025550002", email: null, created_at: at })
      ],
      contacts: [],
      ...EMPTY_MAPS
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.createdAt)).toEqual([at, at]);
  });

  it("reorders tag-only contacts that arrive oldest-first", () => {
    // Contacts are appended in listing order; the final sort must still put
    // the newer lead first.
    const rows = buildLeadDataRows({
      submissions: [],
      contacts: [
        contact({
          customer_e164: "+17025550001",
          created_at: "2026-07-01T00:00:00.000Z",
          tags: ["Booked"]
        }),
        contact({
          customer_e164: "+17025550002",
          created_at: "2026-07-19T00:00:00.000Z",
          tags: ["Booked"]
        })
      ],
      ...EMPTY_MAPS
    });
    expect(rows.map((r) => r.e164)).toEqual(["+17025550002", "+17025550001"]);
  });

  it("renders a null-tag contact reached through its submission with empty tags", () => {
    const rows = buildLeadDataRows({
      submissions: [sub()],
      contacts: [contact({ tags: null })],
      ...EMPTY_MAPS
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].tags).toEqual([]);
  });

  it("applies the mine scope BEFORE the cap so owned leads can't be crowded out", () => {
    // 1 old owned lead + MAX newer unowned leads: scoping after the cap
    // would drop the owned one entirely.
    const contacts = [
      contact({
        customer_e164: "+15055550001",
        owner_employee_id: "emp-1",
        tags: ["Booked"],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z"
      }),
      ...Array.from({ length: MAX_LEAD_DATA_ROWS + 5 }, (_, i) =>
        contact({
          customer_e164: `+1602555${String(i).padStart(4, "0")}`,
          owner_employee_id: null,
          tags: ["New Lead"],
          created_at: `2026-06-0${(i % 9) + 1}T00:00:00.000Z`
        })
      )
    ];
    const mine = buildLeadDataRows({
      submissions: [],
      contacts,
      ...EMPTY_MAPS,
      scopeOwnerEmployeeId: "emp-1"
    });
    expect(mine).toHaveLength(1);
    expect(mine[0].e164).toBe("+15055550001");

    // Unscoped (null) still returns the capped full set.
    const all = buildLeadDataRows({
      submissions: [],
      contacts,
      ...EMPTY_MAPS,
      scopeOwnerEmployeeId: null
    });
    expect(all).toHaveLength(MAX_LEAD_DATA_ROWS);
  });

  it("sorts newest first and caps the row count", () => {
    const submissions = Array.from({ length: MAX_LEAD_DATA_ROWS + 10 }, (_, i) =>
      sub({
        phone_e164: null,
        email: `lead${i}@example.com`,
        created_at: `2026-07-01T${String(i % 24).padStart(2, "0")}:${String(
          i % 60
        ).padStart(2, "0")}:00.000Z`
      })
    );
    const rows = buildLeadDataRows({ submissions, contacts: [], ...EMPTY_MAPS });
    expect(rows.length).toBe(MAX_LEAD_DATA_ROWS);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].createdAt >= rows[i].createdAt).toBe(true);
    }
  });
});
