/**
 * Client-side free-text filtering for the dashboard list views (calls, texts,
 * emails, contacts). Companion to `sort.ts`: each list loads a bounded page of
 * rows and filters the already-loaded set in the browser, so no API/query-param
 * plumbing is needed.
 *
 * Matching is case-insensitive and AND-across-terms: the query is split on
 * whitespace and EVERY term must appear somewhere in the row's haystack. That
 * makes multi-word queries narrow the results (e.g. "jane voicemail") rather
 * than widening them, which matches how people expect a search box to behave.
 */

/** Join a row's searchable fields into one lowercase haystack. */
function haystackOf(fields: ReadonlyArray<string | null | undefined>): string {
  return fields
    .filter((f): f is string => typeof f === "string" && f.length > 0)
    // NUL separator so a term can't match across a field boundary.
    .join("\u0000")
    .toLowerCase();
}

/**
 * True when every whitespace-separated term in `query` appears in one of
 * `fields`. An empty/whitespace-only query matches everything.
 */
export function matchesQuery(
  query: string,
  fields: ReadonlyArray<string | null | undefined>
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = haystackOf(fields);
  return q.split(/\s+/).every((term) => haystack.includes(term));
}
