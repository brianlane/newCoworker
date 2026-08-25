import { describe, it, expect } from "vitest";
import {
  applyFieldDefinitionPatch,
  buildCustomTablesDigestMd,
  coerceFieldValue,
  describeRowErrors,
  fieldHasOptions,
  formatFieldValue,
  formatRowSummary,
  matchRowsByQuery,
  parseTableFields,
  projectRowValues,
  resolveFieldReference,
  resolveRowReference,
  resolveTableReference,
  rowCreateSchema,
  rowListFilterSchema,
  rowPatchSchema,
  slugifyFieldId,
  tableCreateSchema,
  tablePatchSchema,
  validateRowValues
} from "@/lib/custom-tables/core";
import {
  MAX_FIELD_OPTIONS,
  MAX_FIELDS_PER_TABLE,
  MAX_LONG_TEXT_VALUE_LENGTH,
  MAX_NUMBER_VALUE,
  MAX_TEXT_VALUE_LENGTH,
  normalizeTableIcon,
  type CustomTableField
} from "@/lib/custom-tables/types";

function field(over: Partial<CustomTableField> = {}): CustomTableField {
  return { id: "name", label: "Name", type: "text", required: false, enabled: true, ...over };
}

describe("normalizeTableIcon", () => {
  it("keeps a known icon and clamps anything else", () => {
    expect(normalizeTableIcon("truck")).toBe("truck");
    expect(normalizeTableIcon("rocket")).toBe("table");
    expect(normalizeTableIcon(null)).toBe("table");
    expect(normalizeTableIcon(undefined)).toBe("table");
  });
});

describe("slugifyFieldId", () => {
  it("slugifies a label", () => {
    expect(slugifyFieldId("Renewal date")).toBe("renewal_date");
    expect(slugifyFieldId("  Price ($)  ")).toBe("price");
  });

  it("falls back to a positional name when the label has nothing usable", () => {
    expect(slugifyFieldId("!!!", ["a", "b"])).toBe("field_3");
  });

  it("uniquifies against ids already taken", () => {
    expect(slugifyFieldId("Status", ["status"])).toBe("status_2");
    expect(slugifyFieldId("Status", ["status", "status_2"])).toBe("status_3");
  });

  it("truncates a very long label and still uniquifies", () => {
    const long = "a".repeat(80);
    const first = slugifyFieldId(long);
    expect(first).toHaveLength(36);
    const second = slugifyFieldId(long, [first]);
    expect(second).not.toBe(first);
    expect(second.length).toBeLessThanOrEqual(36);
  });
});

describe("fieldHasOptions", () => {
  it("is true only for the closed-vocabulary types", () => {
    expect(fieldHasOptions("select")).toBe(true);
    expect(fieldHasOptions("multi_select")).toBe(true);
    expect(fieldHasOptions("text")).toBe(false);
  });
});

describe("parseTableFields", () => {
  it("returns nothing for a non-array", () => {
    expect(parseTableFields(null)).toEqual([]);
    expect(parseTableFields("nope")).toEqual([]);
    expect(parseTableFields({})).toEqual([]);
  });

  it("drops junk entries rather than throwing", () => {
    const parsed = parseTableFields([
      null,
      "string",
      { id: "BAD ID", label: "x", type: "text" },
      { id: "dupe", label: "One", type: "text" },
      { id: "dupe", label: "Two", type: "text" },
      { id: "blank", label: "   ", type: "text" },
      { id: "long", label: "x".repeat(200), type: "text" },
      { id: "weird", label: "Weird", type: "rainbow" },
      { id: "thin", label: "Thin", type: "select", options: ["only"] },
      { id: "ok", label: "Fine", type: "text" }
    ]);
    expect(parsed.map((f) => f.id)).toEqual(["dupe", "ok"]);
  });

  it("cleans options: trims, drops blanks and oversize, dedupes, caps", () => {
    const many = Array.from({ length: MAX_FIELD_OPTIONS + 5 }, (_, i) => `opt${i}`);
    const [parsed] = parseTableFields([
      { id: "s", label: "S", type: "select", options: ["  A  ", "", "A", "x".repeat(200), 7, "B", ...many] }
    ]);
    expect(parsed.options).toHaveLength(MAX_FIELD_OPTIONS);
    expect(parsed.options?.slice(0, 3)).toEqual(["A", "B", "opt0"]);
  });

  it("survives non-string ids, non-string labels, and non-array options", () => {
    expect(
      parseTableFields([
        { id: 7, label: "Numeric id", type: "text" },
        { id: "nolabel", label: 7, type: "text" },
        { id: "opts", label: "Opts", type: "select", options: "New,Won" }
      ])
    ).toEqual([]);
  });

  it("keeps help only when present, and defaults required and enabled", () => {
    const [withHelp, bare] = parseTableFields([
      { id: "a", label: "A", type: "text", help: "  how to fill it  ", required: true, enabled: false },
      { id: "b", label: "B", type: "text", help: "   " }
    ]);
    expect(withHelp).toMatchObject({ help: "how to fill it", required: true, enabled: false });
    expect(bare.help).toBeUndefined();
    expect(bare.required).toBe(false);
    expect(bare.enabled).toBe(true);
  });

  it("stops at the column cap", () => {
    const raw = Array.from({ length: MAX_FIELDS_PER_TABLE + 5 }, (_, i) => ({
      id: `f${i}`,
      label: `F${i}`,
      type: "text"
    }));
    expect(parseTableFields(raw)).toHaveLength(MAX_FIELDS_PER_TABLE);
  });
});

describe("validateRowValues", () => {
  const fields = [
    field({ id: "name", label: "Name", type: "text", required: true }),
    field({ id: "notes", label: "Notes", type: "long_text" }),
    field({ id: "price", label: "Price", type: "number" }),
    field({ id: "renews", label: "Renews", type: "date" }),
    field({ id: "signed", label: "Signed", type: "checkbox" }),
    field({ id: "status", label: "Status", type: "select", options: ["New", "Won"] }),
    field({ id: "tags", label: "Tags", type: "multi_select", options: ["A", "B"] })
  ];

  it("accepts a full, well-typed bag and trims strings", () => {
    const out = validateRowValues(fields, {
      name: "  Maple St  ",
      notes: "long",
      price: 42.5,
      renews: "2026-09-01",
      signed: true,
      status: "won",
      tags: ["b", "a", "A"]
    });
    expect(out).toEqual({
      ok: true,
      cleared: [],
      values: {
        name: "Maple St",
        notes: "long",
        price: 42.5,
        renews: "2026-09-01",
        signed: true,
        // The OWNER's casing wins, so "won" files under "Won".
        status: "Won",
        tags: ["B", "A"]
      }
    });
  });

  it("treats a non-object input as empty", () => {
    const out = validateRowValues([field({ required: false })], "nope");
    expect(out).toEqual({ ok: true, values: {}, cleared: [] });
  });

  it("skips disabled columns entirely, even required ones", () => {
    const out = validateRowValues([field({ required: true, enabled: false })], {});
    expect(out).toEqual({ ok: true, values: {}, cleared: [] });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["blank string", "   "],
    ["empty array", []]
  ])("counts %s as not filled in", (_label, value) => {
    expect(validateRowValues([field({ required: true })], { name: value })).toEqual({
      ok: false,
      errors: [{ fieldId: "name", code: "required" }]
    });
    expect(validateRowValues([field({ required: false })], { name: value })).toEqual({
      ok: true,
      values: {},
      // Sent, but blank: the writer is asking to clear it.
      cleared: ["name"]
    });
  });

  it.each([
    ["text given a number", field({ id: "f", type: "text" }), 7, "wrong_type"],
    ["text over the cap", field({ id: "f", type: "text" }), "x".repeat(MAX_TEXT_VALUE_LENGTH + 1), "too_long"],
    [
      "long_text over the cap",
      field({ id: "f", type: "long_text" }),
      "x".repeat(MAX_LONG_TEXT_VALUE_LENGTH + 1),
      "too_long"
    ],
    ["number given a string", field({ id: "f", type: "number" }), "7", "wrong_type"],
    ["number that is NaN", field({ id: "f", type: "number" }), Number.NaN, "wrong_type"],
    ["number that is Infinity", field({ id: "f", type: "number" }), Number.POSITIVE_INFINITY, "wrong_type"],
    ["number out of range", field({ id: "f", type: "number" }), MAX_NUMBER_VALUE * 10, "out_of_range"],
    ["date given a number", field({ id: "f", type: "date" }), 20260901, "wrong_type"],
    ["date in the wrong shape", field({ id: "f", type: "date" }), "01/09/2026", "bad_date"],
    ["date that does not exist", field({ id: "f", type: "date" }), "2026-02-31", "bad_date"],
    ["date with a bad month", field({ id: "f", type: "date" }), "2026-13-01", "bad_date"],
    ["checkbox given a string", field({ id: "f", type: "checkbox" }), "yes", "wrong_type"],
    [
      "select given a number",
      field({ id: "f", type: "select", options: ["New", "Won"] }),
      7,
      "wrong_type"
    ],
    [
      "select value not offered",
      field({ id: "f", type: "select", options: ["New", "Won"] }),
      "Maybe",
      "not_an_option"
    ],
    [
      "multi_select given a string",
      field({ id: "f", type: "multi_select", options: ["A"] }),
      "A",
      "wrong_type"
    ],
    [
      "multi_select holding a non-string",
      field({ id: "f", type: "multi_select", options: ["A"] }),
      [7],
      "wrong_type"
    ],
    [
      "multi_select value not offered",
      field({ id: "f", type: "multi_select", options: ["A"] }),
      ["Z"],
      "not_an_option"
    ]
  ])("refuses %s", (_label, def, value, code) => {
    expect(validateRowValues([def], { f: value })).toEqual({
      ok: false,
      errors: [{ fieldId: "f", code }]
    });
  });

  it("tells a cell that was never mentioned apart from one sent blank", () => {
    // Both store nothing. Only the second is a request to CLEAR, and a
    // merge that could not tell them apart would make emptying a cell
    // impossible: you could correct a typo but never simply remove it.
    const two = [field({ id: "a" }), field({ id: "b" })];
    expect(validateRowValues(two, { a: "kept" })).toEqual({
      ok: true,
      values: { a: "kept" },
      cleared: []
    });
    expect(validateRowValues(two, { a: "kept", b: "" })).toEqual({
      ok: true,
      values: { a: "kept" },
      cleared: ["b"]
    });
  });

  it("does not report a required cell as cleared, it reports it as missing", () => {
    expect(validateRowValues([field({ id: "a", required: true })], { a: "" })).toEqual({
      ok: false,
      errors: [{ fieldId: "a", code: "required" }]
    });
  });

  it("refuses every value when a choice column somehow lost its options", () => {
    // parseTableFields drops a select with under two options, so this shape
    // only reaches the validator from a hand-built definition. It must still
    // refuse rather than treating "no options" as "anything goes".
    const naked = [
      field({ id: "s", type: "select" }),
      field({ id: "m", type: "multi_select" })
    ];
    expect(validateRowValues(naked, { s: "New" })).toEqual({
      ok: false,
      errors: [{ fieldId: "s", code: "not_an_option" }]
    });
    expect(validateRowValues(naked, { m: ["A"] })).toEqual({
      ok: false,
      errors: [{ fieldId: "m", code: "not_an_option" }]
    });
  });

  it("discards unknown field ids instead of refusing the write", () => {
    const out = validateRowValues([field({ id: "known", required: false })], {
      known: "yes",
      vanished: "old column"
    });
    expect(out).toEqual({ ok: true, values: { known: "yes" }, cleared: [] });
  });

  it("collects every failing cell, not just the first", () => {
    const out = validateRowValues(
      [field({ id: "a", required: true }), field({ id: "b", type: "number" })],
      { b: "not a number" }
    );
    expect(out).toEqual({
      ok: false,
      errors: [
        { fieldId: "a", code: "required" },
        { fieldId: "b", code: "wrong_type" }
      ]
    });
  });

  it("refuses a row that serializes too large", () => {
    const wide = Array.from({ length: MAX_FIELDS_PER_TABLE }, (_, i) =>
      field({ id: `f${i}`, type: "long_text" })
    );
    const bag: Record<string, string> = {};
    for (const f of wide) bag[f.id] = "x".repeat(MAX_LONG_TEXT_VALUE_LENGTH);
    expect(validateRowValues(wide, bag)).toEqual({
      ok: false,
      errors: [{ fieldId: "", code: "row_too_large" }]
    });
  });
});

describe("describeRowErrors", () => {
  const fields = [
    field({ id: "name", label: "Name" }),
    field({ id: "status", label: "Status", type: "select", options: ["New", "Won", "Lost"] })
  ];

  it.each([
    ["required", "Name is required."],
    ["too_long", "Name is too long."],
    ["out_of_range", "Name is too big a number."],
    ["bad_date", "Name needs a date like 2026-09-01."],
    ["wrong_type", "Name is the wrong kind of value."]
  ])("renders %s", (code, expected) => {
    expect(describeRowErrors(fields, [{ fieldId: "name", code: code as never }])).toBe(expected);
  });

  it("lists the real options, which is what makes the message actionable", () => {
    expect(describeRowErrors(fields, [{ fieldId: "status", code: "not_an_option" }])).toBe(
      "Status must be one of: New, Won, Lost."
    );
  });

  it("names the row, not a column, when the whole row is too big", () => {
    expect(describeRowErrors(fields, [{ fieldId: "", code: "row_too_large" }])).toBe(
      "That row holds too much text."
    );
  });

  it("falls back gracefully for a column that no longer exists", () => {
    expect(describeRowErrors(fields, [{ fieldId: "ghost", code: "required" }])).toBe(
      "That row is required."
    );
    // And without a dangling "one of: ." when there are no options to name.
    expect(describeRowErrors(fields, [{ fieldId: "ghost", code: "not_an_option" }])).toBe(
      "That row is not one of the choices."
    );
  });

  it("joins several failures into one sentence", () => {
    expect(
      describeRowErrors(fields, [
        { fieldId: "name", code: "required" },
        { fieldId: "status", code: "not_an_option" }
      ])
    ).toBe("Name is required. Status must be one of: New, Won, Lost.");
  });
});

describe("coerceFieldValue", () => {
  it.each([
    ["text", field({ type: "text" }), "  hi  ", "hi"],
    ["number", field({ type: "number" }), " $1,240 ", 1240],
    ["date", field({ type: "date" }), "2026-09-01", "2026-09-01"],
    ["select", field({ type: "select", options: ["New", "Won"] }), "won", "Won"]
  ])("coerces %s", (_label, def, raw, expected) => {
    expect(coerceFieldValue(def, raw as string)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["true", true],
    ["Yes", true],
    ["y", true],
    ["1", true],
    ["on", true],
    ["checked", true],
    ["false", false],
    ["no", false],
    ["N", false],
    ["0", false],
    ["off", false],
    ["unchecked", false]
  ])("reads %s as a checkbox value", (raw, expected) => {
    expect(coerceFieldValue(field({ type: "checkbox" }), raw)).toEqual({
      ok: true,
      value: expected
    });
  });

  it("splits a comma list into multi_select choices", () => {
    expect(
      coerceFieldValue(field({ type: "multi_select", options: ["A", "B"] }), " a , b , ")
    ).toEqual({ ok: true, value: ["A", "B"] });
  });

  it.each([
    ["a blank number", field({ type: "number" }), "  ", "wrong_type"],
    ["an unparseable number", field({ type: "number" }), "many", "wrong_type"],
    ["an ambiguous checkbox", field({ type: "checkbox" }), "maybe", "wrong_type"],
    ["a bad date", field({ type: "date" }), "soon", "bad_date"],
    ["an option not offered", field({ type: "select", options: ["New"] }), "Old", "not_an_option"],
    [
      "a multi_select choice not offered",
      field({ type: "multi_select", options: ["A"] }),
      "A, Z",
      "not_an_option"
    ]
  ])("refuses %s", (_label, def, raw, code) => {
    expect(coerceFieldValue(def, raw as string)).toEqual({ ok: false, code });
  });
});

describe("applyFieldDefinitionPatch", () => {
  const base = [
    field({ id: "name", label: "Name" }),
    field({ id: "status", label: "Status", type: "select", options: ["New", "Won"] })
  ];

  it("adds a column and generates its id", () => {
    const out = applyFieldDefinitionPatch(base, {
      action: "add",
      label: "  Renewal date  ",
      type: "date",
      help: "  when it renews  ",
      required: true
    });
    expect(out).toMatchObject({ ok: true, removedFieldIds: [] });
    if (!out.ok) throw new Error("unreachable");
    expect(out.fields[2]).toEqual({
      id: "renewal_date",
      label: "Renewal date",
      help: "when it renews",
      type: "date",
      required: true,
      enabled: true
    });
  });

  it("adds a choice column with its options", () => {
    const out = applyFieldDefinitionPatch(base, {
      action: "add",
      label: "Tier",
      type: "select",
      options: ["Gold", "Silver"]
    });
    if (!out.ok) throw new Error("unreachable");
    expect(out.fields[2].options).toEqual(["Gold", "Silver"]);
  });

  it.each([
    [
      "at the column cap",
      Array.from({ length: MAX_FIELDS_PER_TABLE }, (_, i) => field({ id: `f${i}`, label: `F${i}` })),
      { action: "add" as const, label: "One more", type: "text" as const },
      "limit"
    ],
    ["a blank label", base, { action: "add" as const, label: "   ", type: "text" as const }, "invalid"],
    [
      "an oversize label",
      base,
      { action: "add" as const, label: "x".repeat(200), type: "text" as const },
      "invalid"
    ],
    [
      "a duplicate label",
      base,
      { action: "add" as const, label: "name", type: "text" as const },
      "duplicate"
    ],
    [
      "a choice column with one option",
      base,
      { action: "add" as const, label: "Tier", type: "select" as const, options: ["Only"] },
      "invalid"
    ]
  ])("refuses adding with %s", (_label, fields, patch, code) => {
    expect(applyFieldDefinitionPatch(fields, patch)).toMatchObject({ ok: false, code });
  });

  it("updates a label, help, required, and enabled", () => {
    const out = applyFieldDefinitionPatch(base, {
      action: "update",
      fieldId: "name",
      label: "  Address  ",
      help: " street ",
      required: true,
      enabled: false
    });
    if (!out.ok) throw new Error("unreachable");
    expect(out.fields[0]).toMatchObject({
      label: "Address",
      help: "street",
      required: true,
      enabled: false
    });
  });

  it("clears help when the new help is blank", () => {
    const withHelp = [field({ id: "name", label: "Name", help: "old" })];
    const out = applyFieldDefinitionPatch(withHelp, { action: "update", fieldId: "name", help: "  " });
    if (!out.ok) throw new Error("unreachable");
    expect(out.fields[0].help).toBeUndefined();
  });

  it("replaces the options of a choice column", () => {
    const out = applyFieldDefinitionPatch(base, {
      action: "update",
      fieldId: "status",
      options: ["New", "Won", "Lost"]
    });
    if (!out.ok) throw new Error("unreachable");
    expect(out.fields[1].options).toEqual(["New", "Won", "Lost"]);
  });

  it.each([
    ["a column that is gone", { action: "update" as const, fieldId: "ghost", label: "X" }, "not_found"],
    ["a blank label", { action: "update" as const, fieldId: "name", label: "  " }, "invalid"],
    [
      "an oversize label",
      { action: "update" as const, fieldId: "name", label: "x".repeat(200) },
      "invalid"
    ],
    [
      "a label another column already uses",
      { action: "update" as const, fieldId: "name", label: "Status" },
      "duplicate"
    ],
    [
      "options on a column that has none",
      { action: "update" as const, fieldId: "name", options: ["A", "B"] },
      "invalid"
    ],
    [
      "options that collapse below two",
      { action: "update" as const, fieldId: "status", options: ["Only", "  "] },
      "invalid"
    ]
  ])("refuses updating %s", (_label, patch, code) => {
    expect(applyFieldDefinitionPatch(base, patch)).toMatchObject({ ok: false, code });
  });

  it("removes a column and reports the id to sweep", () => {
    const out = applyFieldDefinitionPatch(base, { action: "remove", fieldId: "status" });
    expect(out).toMatchObject({ ok: true, removedFieldIds: ["status"] });
    if (!out.ok) throw new Error("unreachable");
    expect(out.fields.map((f) => f.id)).toEqual(["name"]);
  });

  it("refuses removing a column that is gone", () => {
    expect(applyFieldDefinitionPatch(base, { action: "remove", fieldId: "ghost" })).toMatchObject({
      ok: false,
      code: "not_found"
    });
  });

  it("reorders on an exact permutation", () => {
    const out = applyFieldDefinitionPatch(base, {
      action: "reorder",
      fieldIds: ["status", "name"]
    });
    if (!out.ok) throw new Error("unreachable");
    expect(out.fields.map((f) => f.id)).toEqual(["status", "name"]);
  });

  it.each([
    ["a short list", ["name"]],
    ["a duplicated id", ["name", "name"]],
    ["an unknown id", ["name", "ghost"]]
  ])("refuses a reorder with %s", (_label, fieldIds) => {
    expect(applyFieldDefinitionPatch(base, { action: "reorder", fieldIds })).toMatchObject({
      ok: false,
      code: "invalid"
    });
  });

  it("does not mutate the input list", () => {
    const original = [field({ id: "name", label: "Name" })];
    applyFieldDefinitionPatch(original, { action: "update", fieldId: "name", label: "Changed" });
    expect(original[0].label).toBe("Name");
  });
});

describe("projectRowValues", () => {
  const fields = [field({ id: "a" }), field({ id: "b" })];

  it("returns nothing for missing storage", () => {
    expect(projectRowValues(fields, null)).toEqual({});
    expect(projectRowValues(fields, undefined)).toEqual({});
  });

  it("drops orphan keys and nulls", () => {
    expect(projectRowValues(fields, { a: "keep", b: null, gone: "orphan" })).toEqual({
      a: "keep"
    });
  });
});

describe("formatFieldValue and formatRowSummary", () => {
  it.each([
    [undefined, ""],
    ["text", "text"],
    [42, "42"],
    [true, "Yes"],
    [false, "No"],
    [["A", "B"], "A, B"]
  ])("renders %s", (value, expected) => {
    expect(formatFieldValue(value as never)).toBe(expected);
  });

  it("joins the filled cells, skipping disabled columns and empties", () => {
    const fields = [
      field({ id: "a", label: "A" }),
      field({ id: "b", label: "B" }),
      field({ id: "c", label: "C", enabled: false })
    ];
    expect(formatRowSummary(fields, { values: { a: "one", c: "hidden" } })).toBe("A: one");
  });

  it("is empty for an empty row", () => {
    expect(formatRowSummary([field()], { values: {} })).toBe("");
  });
});

describe("matchRowsByQuery", () => {
  const fields = [field({ id: "a", label: "A" }), field({ id: "n", label: "N", type: "number" })];
  const rows: { values: Record<string, string | number> }[] = [
    { values: { a: "Maple Street" } },
    { values: { n: 4200 } }
  ];

  it("returns everything for a blank query", () => {
    expect(matchRowsByQuery(fields, rows, "   ")).toHaveLength(2);
  });

  it("matches case-insensitively across rendered cells", () => {
    expect(matchRowsByQuery(fields, rows, "maple")).toEqual([rows[0]]);
    expect(matchRowsByQuery(fields, rows, "4200")).toEqual([rows[1]]);
  });

  it("returns nothing when nothing matches", () => {
    expect(matchRowsByQuery(fields, rows, "oak")).toEqual([]);
  });
});

describe("buildCustomTablesDigestMd", () => {
  it("is empty when there are no tables", () => {
    expect(buildCustomTablesDigestMd([])).toBe("");
  });

  it("names each table, its link mode, row count, and columns", () => {
    const md = buildCustomTablesDigestMd([
      {
        name: "Properties",
        rowLink: "standalone",
        fields: [field({ id: "addr", label: "Address" }), field({ id: "off", label: "Off", enabled: false })],
        rowCount: 42
      },
      { name: "Policies", rowLink: "contact", fields: [], rowCount: 0 }
    ]);
    expect(md).toContain("# tables.md");
    expect(md).toContain("- **Properties** (standalone, 42 rows): Address");
    expect(md).not.toContain("Off");
    // No columns means no trailing colon.
    expect(md).toContain("- **Policies** (one row per contact, 0 rows)");
  });

  it("respects the char cap", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      name: `Table ${i}`,
      rowLink: "standalone" as const,
      fields: [field({ label: "A very long column label here" })],
      rowCount: i
    }));
    expect(buildCustomTablesDigestMd(many).length).toBeLessThanOrEqual(2000);
  });
});

describe("resolveTableReference", () => {
  const tables = [
    { id: "11111111-1111-1111-1111-111111111111", name: "Properties" },
    { id: "22222222-2222-2222-2222-222222222222", name: "Property notes" },
    { id: "33333333-3333-3333-3333-333333333333", name: "Vehicles" }
  ];

  it("resolves by id", () => {
    expect(resolveTableReference(tables, tables[0].id)).toEqual({ ok: true, table: tables[0] });
  });

  it("resolves by exact name, case-insensitively", () => {
    expect(resolveTableReference(tables, "  vehicles ")).toEqual({ ok: true, table: tables[2] });
  });

  it("resolves by a unique substring", () => {
    expect(resolveTableReference(tables, "vehic")).toEqual({ ok: true, table: tables[2] });
  });

  it("refuses an ambiguous substring", () => {
    expect(resolveTableReference(tables, "propert")).toEqual({
      ok: false,
      detail: "table_ambiguous"
    });
  });

  it("refuses an ambiguous exact name", () => {
    const dupes = [
      { id: "a", name: "Same" },
      { id: "b", name: "same" }
    ];
    expect(resolveTableReference(dupes, "Same")).toEqual({ ok: false, detail: "table_ambiguous" });
  });

  it.each([
    ["a blank ref", "   "],
    ["no match at all", "nothing like this"]
  ])("refuses %s", (_label, ref) => {
    expect(resolveTableReference(tables, ref)).toEqual({ ok: false, detail: "table_not_found" });
  });

  it("refuses a substring when exactOnly is set, which is what write tools pass", () => {
    expect(resolveTableReference(tables, "vehic", true)).toEqual({
      ok: false,
      detail: "table_not_found"
    });
    expect(resolveTableReference(tables, "Vehicles", true)).toEqual({ ok: true, table: tables[2] });
    expect(resolveTableReference(tables, tables[2].id, true)).toEqual({ ok: true, table: tables[2] });
  });
});

describe("resolveFieldReference", () => {
  const fields = [
    field({ id: "status", label: "Status" }),
    // Label and id deliberately differ, so the label tier is the only way in.
    field({ id: "renews_on", label: "Renewal date" }),
    field({ id: "dupe_a", label: "Same" }),
    field({ id: "dupe_b", label: "same" })
  ];

  it("resolves by id", () => {
    expect(resolveFieldReference(fields, "status")).toMatchObject({
      ok: true,
      field: { id: "status" }
    });
  });

  it("resolves by the label the model was shown, not just the id", () => {
    expect(resolveFieldReference(fields, "  RENEWAL Date ")).toMatchObject({
      ok: true,
      field: { id: "renews_on" }
    });
  });

  it("refuses a duplicate label as ambiguous", () => {
    expect(resolveFieldReference(fields, "Same")).toEqual({ ok: false, detail: "field_ambiguous" });
  });

  it.each([
    ["a blank ref", "  "],
    ["an unknown label", "Colour"],
    // Deliberately NO substring tier: "stat" must not silently become Status.
    ["a substring", "stat"]
  ])("refuses %s", (_label, ref) => {
    expect(resolveFieldReference(fields, ref)).toEqual({ ok: false, detail: "field_not_found" });
  });
});

describe("resolveRowReference", () => {
  const fields = [field({ id: "a", label: "A" })];
  const rows = [
    { id: "aaaaaaaa-0000-0000-0000-000000000001", tableId: "t", contactId: null, values: { a: "Maple" }, createdAt: "", updatedAt: "" },
    { id: "aaaaaaaa-0000-0000-0000-000000000002", tableId: "t", contactId: null, values: { a: "Maple Grove" }, createdAt: "", updatedAt: "" },
    { id: "aaaaaaaa-0000-0000-0000-000000000003", tableId: "t", contactId: null, values: { a: "Oak" }, createdAt: "", updatedAt: "" }
  ];

  it("resolves by id", () => {
    expect(resolveRowReference(fields, rows, rows[0].id)).toEqual({ ok: true, row: rows[0] });
  });

  it("resolves by a unique summary match", () => {
    expect(resolveRowReference(fields, rows, "oak")).toEqual({ ok: true, row: rows[2] });
  });

  it("refuses an ambiguous match", () => {
    expect(resolveRowReference(fields, rows, "maple")).toEqual({
      ok: false,
      detail: "row_ambiguous"
    });
  });

  it.each([
    ["a blank ref", "  "],
    ["no match", "birch"]
  ])("refuses %s", (_label, ref) => {
    expect(resolveRowReference(fields, rows, ref)).toEqual({ ok: false, detail: "row_not_found" });
  });
});

describe("request schemas", () => {
  const goodField = { label: "Address", type: "text" };

  it("accepts a well-formed create body", () => {
    const parsed = tableCreateSchema.safeParse({
      name: "Properties",
      description: "Listings",
      icon: "home",
      rowLink: "standalone",
      fields: [goodField]
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ["a blank name", { name: "  ", fields: [goodField] }],
    ["a reserved name", { name: "new", fields: [goodField] }],
    ["no columns", { name: "Properties", fields: [] }],
    ["an unknown icon", { name: "Properties", icon: "rocket", fields: [goodField] }],
    ["an unknown column type", { name: "Properties", fields: [{ label: "A", type: "rainbow" }] }],
    ["a stray key", { name: "Properties", fields: [goodField], colour: "red" }]
  ])("refuses a create body with %s", (_label, body) => {
    expect(tableCreateSchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ["rename", { action: "rename", name: "Listings" }],
    ["update_details", { action: "update_details", description: null, icon: "home" }],
    ["add_field", { action: "add_field", field: { label: "Price", type: "number" } }],
    ["update_field", { action: "update_field", fieldId: "price", required: true }],
    ["reorder_fields", { action: "reorder_fields", fieldIds: ["a", "b"] }],
    ["delete_field", { action: "delete_field", fieldId: "price" }]
  ])("accepts the %s action", (_label, body) => {
    expect(tablePatchSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ["an unknown action", { action: "explode" }],
    ["a rename with no name", { action: "rename" }],
    ["a reorder with no ids", { action: "reorder_fields", fieldIds: [] }],
    ["a delete_field with a blank id", { action: "delete_field", fieldId: "  " }],
    ["a stray key", { action: "rename", name: "Listings", extra: 1 }]
  ])("refuses %s", (_label, body) => {
    expect(tablePatchSchema.safeParse(body).success).toBe(false);
  });

  it("accepts and refuses row bodies", () => {
    expect(rowCreateSchema.safeParse({ values: { a: 1 } }).success).toBe(true);
    expect(rowCreateSchema.safeParse({ values: {}, contactId: null }).success).toBe(true);
    expect(rowCreateSchema.safeParse({ values: {}, contactId: "not-a-uuid" }).success).toBe(false);
    expect(rowCreateSchema.safeParse({}).success).toBe(false);
    expect(rowPatchSchema.safeParse({}).success).toBe(true);
    expect(rowPatchSchema.safeParse({ values: { a: 1 }, stray: 2 }).success).toBe(false);
  });

  it("coerces and bounds the row list filter", () => {
    const parsed = rowListFilterSchema.safeParse({ limit: "50", q: "maple" });
    expect(parsed.success && parsed.data.limit).toBe(50);
    expect(rowListFilterSchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(rowListFilterSchema.safeParse({ limit: "500" }).success).toBe(false);
    expect(rowListFilterSchema.safeParse({ contactId: "nope" }).success).toBe(false);
  });
});
