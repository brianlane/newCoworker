import { describe, expect, it } from "vitest";
import { clinicSheetA1Range, parseClinicSheetRows } from "@/lib/clinic-sheets/rows";

const HEADERS = ["First Name", "Last Name", "Phone", "D", "E", "F", "Program"];

describe("parseClinicSheetRows", () => {
  it("keeps a row with a first name, a last name, and a phone", () => {
    const parsed = parseClinicSheetRows(
      [HEADERS, ["Ada", "Lovelace", "(480) 555-0100", "", "", "", ""]],
      { require10Day: false }
    );
    expect(parsed).toEqual({
      ok: true,
      patients: [
        {
          firstName: "Ada",
          lastName: "Lovelace",
          phoneE164: "+14805550100",
          fullName: "Ada Lovelace",
          email: ""
        }
      ]
    });
  });

  it("uses the Email column and ignores Emailed and a blank or invalid address", () => {
    const parsed = parseClinicSheetRows(
      [
        ["First Name", "Last Name", "Phone", "Emailed", "Email", "Send Welcome Email"],
        ["Ada", "Lovelace", "4805550100", "yes", "ada@example.com", "yes"],
        ["Grace", "Hopper", "4805550101", "yes", "", "yes"],
        ["Mary", "Jackson", "4805550102", "yes", "not-an-email", "yes"],
        ["Ida", "Wells", "4805550103"]
      ],
      { require10Day: false }
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.patients.map((patient) => patient.email)).toEqual([
      "ada@example.com",
      "",
      "",
      ""
    ]);
  });

  it("accepts First, Last, and Mobile headers", () => {
    const parsed = parseClinicSheetRows(
      [
        ["First", "Last", "Mobile"],
        ["Grace", "Hopper", "+1 480 555 0199"]
      ],
      { require10Day: false }
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.patients[0]?.phoneE164).toBe("+14805550199");
  });

  it("skips a row that is missing a name or a dialable phone", () => {
    const parsed = parseClinicSheetRows(
      [
        HEADERS,
        ["", "Lovelace", "4805550101"],
        ["Ada", "", "4805550102"],
        ["Ada", "Lovelace", ""],
        ["Ada", "Lovelace", "123"],
        ["Ada", "Lovelace", "4805550100"]
      ],
      { require10Day: false }
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.patients).toHaveLength(1);
  });

  it("sends the same phone on one sheet once inside a single read", () => {
    const parsed = parseClinicSheetRows(
      [
        HEADERS,
        ["Ada", "Lovelace", "4805550100"],
        ["Ada", "Lovelace", "(480) 555-0100"]
      ],
      { require10Day: false }
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.patients).toHaveLength(1);
  });

  it("on Dane keeps only column G exactly 10-Day", () => {
    const parsed = parseClinicSheetRows(
      [
        HEADERS,
        ["Ada", "One", "4805550101", "", "", "", "10-Day"],
        ["Grace", "Two", "4805550102", "", "", "", "10-day"],
        ["Mary", "Three", "4805550103", "", "", "", " 10-Day "],
        ["Ida", "Four", "4805550104", "", "", "", "Other"],
        ["No", "ColumnG", "4805550105"]
      ],
      { require10Day: true }
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.patients.map((patient) => patient.firstName)).toEqual(["Ada", "Mary"]);
  });

  it("fails when a name or phone header was renamed", () => {
    expect(
      parseClinicSheetRows([["Given", "Family", "Tel"], ["Ada", "Lovelace", "4805550100"]], {
        require10Day: false
      })
    ).toEqual({ ok: false, reason: "missing_name_or_phone_column" });
  });

  it("skips a short row and a short code", () => {
    const parsed = parseClinicSheetRows(
      [
        HEADERS,
        [],
        ["Ada"],
        ["Ada", "Lovelace"],
        ["Ada", "Lovelace", "12345"]
      ],
      { require10Day: false }
    );
    expect(parsed).toEqual({ ok: true, patients: [] });
  });

  it("fails on an empty grid", () => {
    expect(parseClinicSheetRows([], { require10Day: false })).toEqual({
      ok: false,
      reason: "missing_name_or_phone_column"
    });
  });
});

describe("clinicSheetA1Range", () => {
  it("quotes a tab title and doubles apostrophes", () => {
    expect(clinicSheetA1Range("O'Brien")).toBe("'O''Brien'!A:Z");
  });
});
