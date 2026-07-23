import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Data API grants guard (README "Security standards & posture").
 *
 * Since 20260820100400_revoke_default_data_api_grants.sql the database no
 * longer auto-grants Data API access on new objects in `public` (this repo
 * opted in early to the Supabase platform default that reaches every
 * existing project on October 30, 2026). A table, view, or function created
 * by a migration is therefore INVISIBLE to supabase-js / PostgREST, even for
 * the service-role clients the entire app runs on, until the migration
 * grants access explicitly. `supabase db push` still applies such a
 * migration cleanly, so without this guard the failure class surfaces as a
 * runtime "permission denied" in production instead of a red PR.
 *
 * Every migration stamped after the convention start must carry, in the
 * same file:
 *   - tables:    grant ... on table X to service_role
 *   - views:     grant select on X to service_role
 *   - serial:    a `grant usage ... on sequence ... to service_role`
 *                (identity columns need no sequence grant; prefer identity)
 *   - functions: grant execute on function X to service_role
 *                (trigger / event-trigger functions are exempt: they run as
 *                owner and are never called through PostgREST)
 *
 * Deliberately unexposed object (e.g. a pg_cron-only helper that must never
 * be a PostgREST RPC): add a marker comment naming the object,
 *   -- grants: none (<object_name>): <reason>
 *
 * When this test fails on your PR it is telling you the migration would
 * ship an object the app cannot reach; write the grant (or the marker), do
 * not weaken the test.
 */

const ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

/** Stamp of the default-privileges revoke; later migrations are checked. */
const CONVENTION_START = "20260820100400";
const CONVENTION_FILE = `${CONVENTION_START}_revoke_default_data_api_grants.sql`;

const IDENT = String.raw`"?([a-z_][a-z0-9_]*)"?`;
const QUALIFIED = String.raw`(?:"?public"?\.)?${IDENT}`;

const CREATE_TABLE_RE = new RegExp(
  String.raw`\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?${QUALIFIED}`,
  "gi"
);
const CREATE_VIEW_RE = new RegExp(
  String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+${QUALIFIED}`,
  "gi"
);
const CREATE_FUNCTION_RE = new RegExp(
  String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+${QUALIFIED}`,
  "gi"
);

function stripLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Object names exempted via `-- grants: none (<name>): reason`. */
function optedOutNames(rawSql: string): Set<string> {
  const names = new Set<string>();
  for (const m of rawSql.matchAll(/--\s*grants:\s*none\s*\(([a-z0-9_]+)\)/gi)) {
    names.add(m[1].toLowerCase());
  }
  return names;
}

function hasTableGrant(sql: string, name: string): boolean {
  return new RegExp(
    String.raw`\bgrant\b[^;]*\bon\s+(?:table\s+)?(?:"?public"?\.)?"?${name}"?\b[^;]*\bto\b[^;]*\bservice_role\b`,
    "is"
  ).test(sql);
}

function hasFunctionGrant(sql: string, name: string): boolean {
  return new RegExp(
    String.raw`\bgrant\s+execute\s+on\s+function\s+(?:"?public"?\.)?"?${name}"?\b[^;]*\bto\b[^;]*\bservice_role\b`,
    "is"
  ).test(sql);
}

function hasSequenceGrant(sql: string): boolean {
  return /\bgrant\b[^;]*\busage\b[^;]*\bon\s+(?:all\s+sequences|sequence)\b[^;]*\bservice_role\b/is.test(
    sql
  );
}

/** Trigger and event-trigger functions run as owner; PostgREST never calls them. */
function returnsTrigger(sql: string, matchIndex: number): boolean {
  return /\breturns\s+(?:event_)?trigger\b/i.test(
    sql.slice(matchIndex, matchIndex + 2000)
  );
}

describe("migration Data API grants (post default-revoke convention)", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));

  it("the convention-start migration is still in place under its recorded name", () => {
    expect(files).toContain(CONVENTION_FILE);
  });

  it("every post-convention migration grants service_role access to what it creates", () => {
    const violations: string[] = [];
    const checked = files.filter((f) => f.slice(0, 14) > CONVENTION_START);

    for (const file of checked) {
      const raw = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const exempt = optedOutNames(raw);
      const sql = stripLineComments(raw);

      for (const m of sql.matchAll(CREATE_TABLE_RE)) {
        const name = m[1].toLowerCase();
        if (exempt.has(name)) continue;
        if (!hasTableGrant(sql, name)) {
          violations.push(
            `${file}: table "${name}" has no service_role grant (or "-- grants: none (${name}): reason" marker)`
          );
        }
        // A serial column mints a sequence that also needs a grant before
        // service_role can INSERT through PostgREST. Identity columns do not.
        const tail = sql.slice(m.index ?? 0, sql.indexOf(";", m.index ?? 0) + 1);
        if (/\b(?:big|small)?serial\b/i.test(tail) && !hasSequenceGrant(sql)) {
          violations.push(
            `${file}: table "${name}" uses a serial column but the file grants no sequence usage to service_role (grant usage, select on sequence ...; or use an identity column)`
          );
        }
      }

      for (const m of sql.matchAll(CREATE_VIEW_RE)) {
        const name = m[1].toLowerCase();
        if (exempt.has(name)) continue;
        if (!hasTableGrant(sql, name)) {
          violations.push(
            `${file}: view "${name}" has no service_role grant (or "-- grants: none (${name}): reason" marker)`
          );
        }
      }

      for (const m of sql.matchAll(CREATE_FUNCTION_RE)) {
        const name = m[1].toLowerCase();
        if (exempt.has(name)) continue;
        if (returnsTrigger(sql, m.index ?? 0)) continue;
        if (!hasFunctionGrant(sql, name)) {
          violations.push(
            `${file}: function "${name}" has no "grant execute ... to service_role" (or "-- grants: none (${name}): reason" marker)`
          );
        }
      }
    }

    expect(
      violations,
      `Migrations create Data API objects without explicit grants.\n` +
        `Since ${CONVENTION_FILE} new objects in public get NO automatic grants ` +
        `(Supabase Oct 30, 2026 default, adopted early). Add the grants in the same ` +
        `migration file:\n${violations.join("\n")}`
    ).toEqual([]);
  });
});
