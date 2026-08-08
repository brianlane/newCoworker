/**
 * Round-robin ordering for the reach_teammate ladder's first rung.
 *
 * `reachTeammate.rotateFirst: N` means the first N authored refs take turns
 * ringing first, while every ref past N keeps its authored position: Amy's
 * ladder is [Dave, Gabby, Amy] with rotateFirst 2, so Dave and Gabby
 * alternate and Amy is always the last resort.
 *
 * The cursor is `ai_flow_team_members.last_reach_first_at`, stamped by the
 * worker on whichever member actually rings first. This module is the pure
 * ordering rule only (no I/O, no clock), so it unit-tests at 100% like the
 * rest of `_shared`: the worker reads the cursors, calls this, and stamps.
 */

export type ReachRotationCursor = {
  /** ai_flow_team_members.id of a ref inside the rotated window. */
  memberId: string;
  /** last_reach_first_at, ISO string; null = never rang first yet. */
  lastReachFirstAt: string | null;
  /** created_at, the stable tiebreak so equal cursors stay deterministic. */
  createdAt: string;
};

/**
 * Reorder `items` (the resolved ladder, authored order) so the first
 * `rotateFirst` entries are sorted least-recently-first-rung first. Entries
 * past the window are untouched. Pure and total:
 *
 * - a member with NO cursor row (or a null stamp) sorts to the front, so a
 *   freshly added teammate immediately gets a turn rather than waiting for
 *   everyone else's stamps to age past them;
 * - ties break by roster created_at, then by authored position, so the
 *   result is deterministic under equal inputs;
 * - a window larger than the list, or smaller than 2, returns the authored
 *   order unchanged (nothing to rotate).
 *
 * `memberIdOf` maps a ladder item to its roster id; items whose id has no
 * cursor entry are treated as null-stamped.
 */
export function rotateReachOrder<T>(
  items: readonly T[],
  rotateFirst: number | undefined,
  cursors: readonly ReachRotationCursor[],
  memberIdOf: (item: T) => string
): T[] {
  const n = typeof rotateFirst === "number" ? Math.floor(rotateFirst) : 0;
  if (n < 2 || n > items.length) return [...items];
  const byId = new Map(cursors.map((c) => [c.memberId, c]));
  const window = items.slice(0, n).map((item, authoredIndex) => {
    const cursor = byId.get(memberIdOf(item));
    return {
      item,
      authoredIndex,
      last: cursor?.lastReachFirstAt ?? null,
      created: cursor?.createdAt ?? ""
    };
  });
  window.sort((a, b) => {
    // Null stamps first: a teammate who never rang first is owed a turn.
    if (a.last === null && b.last !== null) return -1;
    if (a.last !== null && b.last === null) return 1;
    if (a.last !== null && b.last !== null && a.last !== b.last) {
      return a.last < b.last ? -1 : 1;
    }
    if (a.created !== b.created) return a.created < b.created ? -1 : 1;
    return a.authoredIndex - b.authoredIndex;
  });
  return [...window.map((w) => w.item), ...items.slice(n)];
}
