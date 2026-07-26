/**
 * Read every row a PostgREST query matches, instead of the first page of it.
 *
 * PostgREST caps a response at 1000 rows and says nothing about it. A caller
 * that selects and then counts what came back therefore reports a floor while
 * looking like a total, and it does so precisely on the busy tenants worth
 * looking at. For a diagnostic that is worse than returning nothing: the
 * operator has no way to tell a complete answer from a truncated one.
 *
 * Two rules follow, and both are the point of this helper:
 *   1. page until the source is exhausted, and
 *   2. when a ceiling IS hit, say so, so the caller can label the result
 *      partial rather than imply it is whole.
 *
 * Prefer an exact `{ count: "exact", head: true }` query when all you need is
 * a volume. Use this when the rows themselves have to be grouped or scanned.
 */

export const SUPABASE_PAGE_SIZE = 1000;

/** The shape supabase-js resolves to, narrowed to what paging needs. */
export type PagedResponse<T> = { data: T[] | null; error: { message: string } | null };

/**
 * `fetchPage` receives an inclusive `[from, to]` row range to hand to
 * supabase-js `.range()`, and must apply a stable `.order()` so pages do not
 * overlap or skip.
 */
export type FetchPage<T> = (from: number, to: number) => PromiseLike<PagedResponse<T>>;

export type PagedResult<T> = {
  rows: T[];
  /** True only when rows beyond `maxRows` actually exist. */
  truncated: boolean;
};

export async function fetchAllPaged<T>(
  fetchPage: FetchPage<T>,
  opts: { label: string; maxRows?: number }
): Promise<PagedResult<T>> {
  const maxRows = opts.maxRows ?? 20_000;
  const rows: T[] = [];

  while (rows.length < maxRows) {
    const from = rows.length;
    const to = Math.min(from + SUPABASE_PAGE_SIZE, maxRows) - 1;
    const { data, error } = await fetchPage(from, to);
    if (error) throw new Error(`${opts.label}: ${error.message}`);
    const page = data ?? [];
    rows.push(...page);
    // A short page means the source is exhausted, whatever the ceiling says.
    if (page.length < to - from + 1) return { rows, truncated: false };
  }

  // The ceiling was reached, which is not the same as more rows existing: a
  // source holding exactly `maxRows` rows is complete. Probe one row past the
  // end rather than warning the caller their complete result is a floor.
  const { data, error } = await fetchPage(maxRows, maxRows);
  if (error) throw new Error(`${opts.label}: ${error.message}`);
  return { rows, truncated: (data ?? []).length > 0 };
}
