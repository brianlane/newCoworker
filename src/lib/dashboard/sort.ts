/**
 * Client-side list sorting for the dashboard list views (AiFlows, employees,
 * customers, contacts). These lists load a bounded page of rows and sort the
 * already-loaded set in the browser, so the same helper drives every view and
 * no API/query-param plumbing is needed.
 */

export type SortDir = "asc" | "desc";

/** Values that carry no data and must always sink to the bottom of the list. */
function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

/**
 * Return a new array sorted by `accessor`. Strings compare case-insensitively
 * and numerically-aware (so "Flow 2" sorts before "Flow 10"); numbers compare
 * numerically; ISO timestamp strings sort correctly via the string path. Empty
 * values (null/undefined/"") always sort LAST regardless of direction, so rows
 * with no value (e.g. a flow that has never run) never jump to the top. The
 * input array is not mutated.
 */
export function sortRows<T>(
  rows: readonly T[],
  accessor: (row: T) => string | number | null | undefined,
  dir: SortDir
): T[] {
  const factor = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    const ae = isEmpty(av);
    const be = isEmpty(bv);
    if (ae && be) return 0;
    if (ae) return 1;
    if (be) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return (av - bv) * factor;
    }
    return (
      String(av).localeCompare(String(bv), undefined, {
        numeric: true,
        sensitivity: "base"
      }) * factor
    );
  });
}
