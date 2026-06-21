import { describe, expect, it } from "vitest";
import { sortRows } from "@/lib/dashboard/sort";

type Row = { id: number; name?: string | null; n?: number | null; at?: string | null };

describe("sortRows", () => {
  it("sorts strings case-insensitively and numerically-aware (ascending)", () => {
    const rows: Row[] = [
      { id: 1, name: "Flow 10" },
      { id: 2, name: "flow 2" },
      { id: 3, name: "Alpha" }
    ];
    const out = sortRows(rows, (r) => r.name, "asc").map((r) => r.id);
    // "Alpha" < "flow 2" < "Flow 10" (numeric-aware: 2 before 10)
    expect(out).toEqual([3, 2, 1]);
  });

  it("reverses order for descending", () => {
    const rows: Row[] = [{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3, name: "c" }];
    expect(sortRows(rows, (r) => r.name, "desc").map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it("compares numbers numerically in both directions", () => {
    const rows: Row[] = [{ id: 1, n: 2 }, { id: 2, n: 10 }, { id: 3, n: 1 }];
    expect(sortRows(rows, (r) => r.n, "asc").map((r) => r.id)).toEqual([3, 1, 2]);
    expect(sortRows(rows, (r) => r.n, "desc").map((r) => r.id)).toEqual([2, 1, 3]);
  });

  it("sorts ISO timestamps via the string path", () => {
    const rows: Row[] = [
      { id: 1, at: "2026-06-10T00:00:00Z" },
      { id: 2, at: "2026-06-12T00:00:00Z" },
      { id: 3, at: "2026-06-11T00:00:00Z" }
    ];
    expect(sortRows(rows, (r) => r.at, "desc").map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it("always sinks empty values (null/undefined/'') to the bottom, even descending", () => {
    const rows: Row[] = [
      { id: 1, name: null },
      { id: 2, name: "b" },
      { id: 3, name: "" },
      { id: 4, name: "a" },
      { id: 5, name: undefined }
    ];
    const asc = sortRows(rows, (r) => r.name, "asc").map((r) => r.id);
    expect(asc.slice(0, 2)).toEqual([4, 2]); // a, b first
    expect(asc.slice(2).sort()).toEqual([1, 3, 5]); // the three empties trail
    const desc = sortRows(rows, (r) => r.name, "desc").map((r) => r.id);
    expect(desc.slice(0, 2)).toEqual([2, 4]); // b, a first
    expect(desc.slice(2).sort()).toEqual([1, 3, 5]); // empties still trail
  });

  it("treats two empties as equal (stable, returns 0)", () => {
    const rows: Row[] = [{ id: 1, name: null }, { id: 2, name: undefined }];
    expect(sortRows(rows, (r) => r.name, "asc").map((r) => r.id)).toEqual([1, 2]);
  });

  it("does not mutate the input array", () => {
    const rows: Row[] = [{ id: 2, n: 2 }, { id: 1, n: 1 }];
    const copy = [...rows];
    sortRows(rows, (r) => r.n, "asc");
    expect(rows).toEqual(copy);
  });
});
