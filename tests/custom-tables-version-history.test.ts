import { describe, it, expect } from "vitest";
import {
  buildCustomTableHistory,
  describeTableEditSource
} from "@/lib/custom-tables/version-history";
import type { CustomTableVersionRow } from "@/lib/custom-tables/versions";
import type { CustomTableField } from "@/lib/custom-tables/types";

function field(over: Partial<CustomTableField> = {}): CustomTableField {
  return { id: "name", label: "Name", type: "text", required: false, enabled: true, ...over };
}

function version(over: Partial<CustomTableVersionRow> = {}): CustomTableVersionRow {
  return {
    id: 1,
    tableId: "tbl-1",
    rowId: null,
    kind: "schema",
    name: "Properties",
    description: null,
    rowLink: "standalone",
    fields: [field()],
    values: null,
    contactId: null,
    source: "dashboard",
    actor: null,
    replacedAt: "2026-08-20T10:00:00.000Z",
    ...over
  };
}

const CURRENT = { name: "Properties", description: null, fields: [field()] };

describe("describeTableEditSource", () => {
  it.each([
    ["dashboard", "Changed in the dashboard"],
    ["dashboard_restore", "Restored from history"],
    ["ai_dashboard", "Changed by your coworker, in dashboard chat"],
    ["ai_sms", "Changed by your coworker, by text"],
    ["ai_slack", "Changed by your coworker, in Slack"],
    ["ai_email", "Changed by your coworker, by email"],
    ["mcp", "Changed through a connected app"],
    ["mcp_restore", "Restored through a connected app"],
    ["sweep", "Cleaned up automatically"]
  ])("names the %s surface", (source, expected) => {
    expect(describeTableEditSource(source)).toBe(expected);
  });

  it("stays vague for an unstamped or unknown source, rather than guessing", () => {
    expect(describeTableEditSource(null)).toBe("An earlier change");
    expect(describeTableEditSource("some_new_script")).toBe("An earlier change");
  });
});

describe("buildCustomTableHistory", () => {
  it("pairs the newest schema snapshot against the LIVE table", () => {
    const entries = buildCustomTableHistory(
      [version({ id: 9, name: "Listings", fields: [field()] })],
      CURRENT
    );
    expect(entries[0]).toMatchObject({
      versionId: 9,
      isMostRecent: true,
      restorable: true,
      by: "Changed in the dashboard"
    });
    expect(entries[0].changeSummary).toEqual(['Renamed the table to "Properties"']);
  });

  it("pairs an older snapshot against the next-newer one, not against live", () => {
    const [newer, older] = buildCustomTableHistory(
      [
        version({ id: 2, name: "Middle", replacedAt: "2026-08-21T00:00:00.000Z" }),
        version({ id: 1, name: "Oldest", replacedAt: "2026-08-20T00:00:00.000Z" })
      ],
      CURRENT
    );
    // Newest compares with live ("Properties"), older compares with "Middle".
    expect(newer.changeSummary).toEqual(['Renamed the table to "Properties"']);
    expect(older.changeSummary).toEqual(['Renamed the table to "Middle"']);
    expect(newer.isMostRecent).toBe(true);
    expect(older.isMostRecent).toBe(false);
  });

  it("falls back to the live name when the newer snapshot has none", () => {
    const [, older] = buildCustomTableHistory(
      [version({ id: 2, name: null }), version({ id: 1, name: "Oldest" })],
      CURRENT
    );
    expect(older.changeSummary).toEqual(['Renamed the table to "Properties"']);
  });

  it("falls back to the live fields when the newer snapshot has none", () => {
    const [, older] = buildCustomTableHistory(
      [
        version({ id: 2, fields: null }),
        version({ id: 1, fields: [field(), field({ id: "extra", label: "Extra" })] })
      ],
      CURRENT
    );
    expect(older.changeSummary).toEqual(["Deleted the Extra column"]);
  });

  it("describes a description that was set and one that was cleared", () => {
    const set = buildCustomTableHistory([version({ description: null })], {
      ...CURRENT,
      description: "Now described"
    });
    expect(set[0].changeSummary).toEqual(["Changed the description"]);
    const cleared = buildCustomTableHistory([version({ description: "Was described" })], CURRENT);
    expect(cleared[0].changeSummary).toEqual(["Cleared the description"]);
  });

  it("describes added and removed columns, singular and plural", () => {
    const added = buildCustomTableHistory([version({ fields: [] })], {
      ...CURRENT,
      fields: [field(), field({ id: "price", label: "Price" })]
    });
    expect(added[0].changeSummary).toEqual(["Added the Name, Price columns"]);

    const removed = buildCustomTableHistory(
      [version({ fields: [field(), field({ id: "price", label: "Price" })] })],
      CURRENT
    );
    expect(removed[0].changeSummary).toEqual(["Deleted the Price column"]);

    const removedTwo = buildCustomTableHistory(
      [
        version({
          fields: [field(), field({ id: "price", label: "Price" }), field({ id: "tier", label: "Tier" })]
        })
      ],
      CURRENT
    );
    expect(removedTwo[0].changeSummary).toEqual(["Deleted the Price, Tier columns"]);
  });

  it("uses the singular for one added column", () => {
    const [entry] = buildCustomTableHistory([version({ fields: [] })], CURRENT);
    expect(entry.changeSummary).toEqual(["Added the Name column"]);
  });

  it("describes a rename, a required flip, a pause, and an options change", () => {
    const before = [
      field({ id: "a", label: "Old name" }),
      field({ id: "b", label: "B", required: false }),
      field({ id: "c", label: "C", enabled: true }),
      field({ id: "d", label: "D", type: "select", options: ["New"] })
    ];
    const after = [
      field({ id: "a", label: "New name" }),
      field({ id: "b", label: "B", required: true }),
      field({ id: "c", label: "C", enabled: false }),
      field({ id: "d", label: "D", type: "select", options: ["New", "Won"] })
    ];
    const [entry] = buildCustomTableHistory([version({ fields: before })], {
      ...CURRENT,
      fields: after
    });
    expect(entry.changeSummary).toEqual([
      'Renamed "Old name" to "New name"',
      "B is now required",
      "C was paused",
      "D options are now: New, Won"
    ]);
  });

  it("says a column is no longer required, and was switched back on", () => {
    const [entry] = buildCustomTableHistory(
      [
        version({
          fields: [field({ id: "b", label: "B", required: true, enabled: false })]
        })
      ],
      { ...CURRENT, fields: [field({ id: "b", label: "B", required: false, enabled: true })] }
    );
    expect(entry.changeSummary).toEqual(["B is no longer required", "B was switched back on"]);
  });

  it("reports a pure reorder, and only when nothing else changed", () => {
    const before = [field({ id: "a", label: "A" }), field({ id: "b", label: "B" })];
    const after = [field({ id: "b", label: "B" }), field({ id: "a", label: "A" })];
    const [entry] = buildCustomTableHistory([version({ fields: before })], {
      ...CURRENT,
      fields: after
    });
    expect(entry.changeSummary).toEqual(["Reordered the columns"]);
  });

  it("reports nothing for an equivalent pair", () => {
    const [entry] = buildCustomTableHistory([version()], CURRENT);
    expect(entry.changeSummary).toEqual([]);
  });

  it("describes a table delete and a table restore", () => {
    const [deleted] = buildCustomTableHistory([version({ kind: "table_deleted" })], CURRENT);
    expect(deleted).toMatchObject({
      changeSummary: ["Deleted the whole table"],
      restorable: true
    });
    const [restored] = buildCustomTableHistory([version({ kind: "table_restored" })], CURRENT);
    expect(restored).toMatchObject({
      changeSummary: ["Brought the table back"],
      // Restoring a restore would put the table back where it already is.
      restorable: false
    });
  });

  it("describes a row delete", () => {
    const [entry] = buildCustomTableHistory(
      [version({ kind: "row_deleted", rowId: "row-1", values: { name: "Maple" } })],
      CURRENT
    );
    expect(entry).toMatchObject({ changeSummary: ["Deleted a row"], restorable: true });
  });

  it("diffs a row edit against that row as it stands now", () => {
    const fields = [
      field({ id: "a", label: "A" }),
      field({ id: "b", label: "B" }),
      field({ id: "c", label: "C" })
    ];
    const [entry] = buildCustomTableHistory(
      [
        version({
          kind: "row_updated",
          rowId: "row-1",
          values: { a: "was", b: "gone soon", c: "same" }
        })
      ],
      { ...CURRENT, fields },
      new Map([["row-1", { a: "now", c: "same" }]])
    );
    expect(entry.changeSummary).toEqual(['A: "was" to "now"', 'B cleared (was "gone soon")']);
  });

  it("reports a newly set cell", () => {
    const [entry] = buildCustomTableHistory(
      [version({ kind: "row_updated", rowId: "row-1", values: {} })],
      CURRENT,
      new Map([["row-1", { name: "Maple" }]])
    );
    expect(entry.changeSummary).toEqual(['Name set to "Maple"']);
  });

  it("pairs a row snapshot with the next-newer snapshot OF THAT ROW", () => {
    // Row 2's snapshot sits between row 1's two snapshots. Pairing by
    // position rather than by subject would diff row 1 against row 2.
    const entries = buildCustomTableHistory(
      [
        version({ id: 3, kind: "row_updated", rowId: "row-1", values: { name: "middle" } }),
        version({ id: 2, kind: "row_updated", rowId: "row-2", values: { name: "other" } }),
        version({ id: 1, kind: "row_updated", rowId: "row-1", values: { name: "oldest" } })
      ],
      CURRENT,
      new Map([
        ["row-1", { name: "newest" }],
        ["row-2", { name: "other now" }]
      ])
    );
    expect(entries[0].changeSummary).toEqual(['Name: "middle" to "newest"']);
    expect(entries[1].changeSummary).toEqual(['Name: "other" to "other now"']);
    expect(entries[2].changeSummary).toEqual(['Name: "oldest" to "middle"']);
    expect(entries.map((e) => e.isMostRecent)).toEqual([true, true, false]);
  });

  it("marks a row edit unrestorable when the row was deleted afterwards", () => {
    const [entry] = buildCustomTableHistory(
      [version({ kind: "row_updated", rowId: "row-1", values: { name: "was" } })],
      CURRENT,
      new Map()
    );
    expect(entry).toMatchObject({
      changeSummary: ["Changed a row that was deleted later"],
      restorable: false
    });
  });

  it("handles a row_updated snapshot with no row id at all", () => {
    const [entry] = buildCustomTableHistory(
      [version({ kind: "row_updated", rowId: null, values: { name: "orphan" } })],
      CURRENT
    );
    expect(entry.restorable).toBe(false);
  });

  it("treats a null values bag as empty", () => {
    const [entry] = buildCustomTableHistory(
      [version({ kind: "row_updated", rowId: "row-1", values: null })],
      CURRENT,
      new Map([["row-1", { name: "set" }]])
    );
    expect(entry.changeSummary).toEqual(['Name set to "set"']);
  });

  it("carries the stamped actor through", () => {
    const [entry] = buildCustomTableHistory(
      [version({ actor: "owner@example.com" })],
      CURRENT
    );
    expect(entry.actor).toBe("owner@example.com");
  });

  it("returns nothing for an empty history", () => {
    expect(buildCustomTableHistory([], CURRENT)).toEqual([]);
  });
});
