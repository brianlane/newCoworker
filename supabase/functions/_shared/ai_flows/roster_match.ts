/**
 * Pure roster-name matching for the dynamic route_to_team pin
 * (`agentNameVar`): the owner named a teammate in plain words ("I want
 * Gabby to have this") and the worker must resolve that to exactly one
 * ACTIVE roster member, or refuse.
 *
 * Tiers, all trimmed/case-insensitive:
 *   1. exact full name          ("Gabrielle Mota")
 *   2. exact first name         ("Gabrielle")
 *   3. UNIQUE prefix, 3+ chars, both directions: the ask prefixes the full
 *      or first name ("Gab" finds "Gabrielle"), or the first name prefixes
 *      the ask ("Gabrielle M" finds "Gabrielle Mota"). Nicknames that share
 *      the first three letters resolve too ("Gabby" vs "Gabrielle": "gab").
 *
 * Ambiguity at any tier resolves NOTHING (two Gabrielas): misrouting a
 * lead is worse than handing it back to the owner.
 *
 * Pure and IO-free so the worker helper stays a thin wrapper and this logic
 * is unit-testable outside the worker.
 */

export type RosterMatch =
  | { kind: "unpinned" }
  | { kind: "pinned"; name: string }
  | { kind: "unresolved" };

/** Longest shared prefix length of two lowercase strings. */
function sharedPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

export function matchRosterName(wantedRaw: string, rosterNames: readonly string[]): RosterMatch {
  const wanted = wantedRaw.trim();
  if (!wanted || wanted.toLowerCase() === "none") return { kind: "unpinned" };
  const want = wanted.toLowerCase();

  const roster = rosterNames.map((n) => n.trim()).filter((n) => n.length > 0);

  const exact = roster.filter((n) => n.toLowerCase() === want);
  if (exact.length === 1) return { kind: "pinned", name: exact[0] };
  if (exact.length > 1) return { kind: "unresolved" };

  const firstName = roster.filter((n) => n.split(/\s+/)[0].toLowerCase() === want);
  if (firstName.length === 1) return { kind: "pinned", name: firstName[0] };
  if (firstName.length > 1) return { kind: "unresolved" };

  if (want.length >= 3) {
    const prefix = roster.filter((n) => {
      const lower = n.toLowerCase();
      const first = n.split(/\s+/)[0].toLowerCase();
      return (
        lower.startsWith(want) ||
        first.startsWith(want) ||
        // Nickname tolerance: "gabby" and "gabrielle" share "gab" (3+).
        sharedPrefixLen(first, want) >= 3
      );
    });
    if (prefix.length === 1) return { kind: "pinned", name: prefix[0] };
  }
  return { kind: "unresolved" };
}
