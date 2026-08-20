/**
 * Residency-aware `contacts` reads for the dashboard surfaces that fold
 * leads onto contact rows (the Tasks board, the leads Data grid) and for the
 * document routes' cross-tenant contact guard.
 *
 * `contacts` is a RESIDENCY_MOVED_TABLE, so for a tenant in
 * `data_residency_mode = 'vps'` the authoritative rows live on that tenant's
 * own box and a central `db.from("contacts")` read comes back empty. Empty is
 * indistinguishable from "this business has no leads", so those surfaces
 * would render a blank board with no error at all. Every lookup here picks
 * the box or central once, from a `vpsReadMode` flag the CALLER resolves once
 * per request (see `isVpsReadMode`), so one dashboard render never pays for
 * several mode lookups.
 *
 * Both paths of every lookup share one caller-supplied column list, the same
 * discipline `src/lib/analytics/lead-sources.ts` uses: a column added to one
 * path and not the other would blank that field for residency tenants only,
 * which is exactly the class of bug this module exists to end.
 *
 * There is deliberately no fallback to central when the box is unreachable:
 * `readMovedRows` raises a typed ResidencyReadError, the routes let it out of
 * their try block, and `handleRouteError` turns it into a 500. A visibly
 * broken page beats a silently empty one.
 */

import type { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { DataApiFilter } from "@/lib/residency/contract";
import { readMovedRows } from "@/lib/residency/read";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ContactLookupContext = {
  businessId: string;
  db: SupabaseClient;
  /**
   * Whether this tenant's contacts come from their box. Resolved ONCE per
   * request by the caller (`isVpsReadMode`) and passed down, so a route
   * running three lookups still makes one routing decision.
   */
  vpsReadMode: boolean;
  /** Route name, prefixed onto central-path errors ("tasks", "leads-data"). */
  label: string;
};

/**
 * Contacts whose PRIMARY number, or (central only) one of whose merge
 * aliases, is in `phones`.
 *
 * BOX PATH TRADE: the box filter grammar is AND-only, with no OR and no
 * array-overlap operator (`src/lib/residency/contract.ts`), so the central
 * `alias_e164s.ov.{...}` leg cannot be expressed and the box matches primary
 * numbers only. A lead keyed on a merged-away alias therefore resolves to NO
 * contact row on a vps tenant: it renders unresolved (no display name, and
 * its runs are not re-keyed onto the surviving primary) rather than being
 * attributed to whoever the widened scan happened to return. PR #1547 made
 * the same trade for the same filter in the team-performance card. Less
 * complete, never wrong, and never mis-attributed to another person.
 */
export async function listContactsByLeadPhone<Row>(
  ctx: ContactLookupContext,
  args: { columns: readonly string[]; phones: readonly string[] }
): Promise<Row[]> {
  // Nothing to match. This also keeps an empty `in` list away from the box,
  // which rejects one outright ("filter op 'in' needs a non-empty array"),
  // and mirrors central, where the callers skipped the query entirely.
  if (args.phones.length === 0) return [];
  const { businessId, db, vpsReadMode, label } = ctx;
  if (vpsReadMode) {
    // No limit, matching central: the IN list is the bound, and it is itself
    // capped by the caller's submission / run scan.
    return await readMovedRows<Row>(businessId, {
      table: "contacts",
      columns: [...args.columns],
      filters: [
        { column: "business_id", op: "eq", value: businessId },
        { column: "customer_e164", op: "in", value: [...args.phones] }
      ]
    });
  }
  // E.164 values are strictly `+digits`, so they are safe inside the
  // PostgREST filter string. `ov` = array overlap on alias_e164s: a lead can
  // be keyed on a merged-away number whose surviving contact row carries a
  // different primary.
  const list = args.phones.join(",");
  const { data, error } = await db
    .from("contacts")
    .select(args.columns.join(", "))
    .eq("business_id", businessId)
    .or(`customer_e164.in.(${list}),alias_e164s.ov.{${list}}`);
  if (error) throw new Error(`${label}: contacts by phone: ${error.message}`);
  return (data as unknown as Row[] | null) ?? [];
}

/** Contacts whose stored email is in `emails` (already lowercased by callers). */
export async function listContactsByEmail<Row>(
  ctx: ContactLookupContext,
  args: { columns: readonly string[]; emails: readonly string[] }
): Promise<Row[]> {
  if (args.emails.length === 0) return [];
  const { businessId, db, vpsReadMode, label } = ctx;
  if (vpsReadMode) {
    return await readMovedRows<Row>(businessId, {
      table: "contacts",
      columns: [...args.columns],
      filters: [
        { column: "business_id", op: "eq", value: businessId },
        { column: "email", op: "in", value: [...args.emails] }
      ]
    });
  }
  // Emails can contain PostgREST-reserved chars; `.in()` escapes values.
  const { data, error } = await db
    .from("contacts")
    .select(args.columns.join(", "))
    .eq("business_id", businessId)
    .in("email", [...args.emails]);
  if (error) throw new Error(`${label}: contacts by email: ${error.message}`);
  return (data as unknown as Row[] | null) ?? [];
}

/**
 * Every contact carrying at least one tag, newest-touched first, capped.
 *
 * `owner` narrows the DB window itself for a scope=mine view: without it an
 * owned lead older than the newest-N business-wide tagged contacts could
 * never reach the caller at all.
 */
export async function listTaggedContacts<Row extends { updated_at: string }>(
  ctx: ContactLookupContext,
  args: {
    columns: readonly string[];
    limit: number;
    /**
     * scope=mine narrowing; omitted or null = every tagged contact.
     * `includeUnowned` is the one-person-roster case, where the implicit
     * owner rule makes unclaimed leads theirs too.
     */
    owner?: { employeeId: string; includeUnowned: boolean } | null;
  }
): Promise<Row[]> {
  const { businessId, db, vpsReadMode, label } = ctx;
  const owner = args.owner ?? null;
  if (vpsReadMode) {
    // `neq("tags", "{}")` crosses unchanged: the box compiles `neq` to `<>`
    // with a bound parameter, so Postgres reads the "{}" bind as the empty
    // text[] against the array column, the same comparison PostgREST makes
    // centrally.
    const boxRead = (extra: DataApiFilter[]) =>
      readMovedRows<Row>(businessId, {
        table: "contacts",
        columns: [...args.columns],
        filters: [
          { column: "business_id", op: "eq", value: businessId },
          { column: "tags", op: "neq", value: "{}" },
          ...extra
        ],
        order: [{ column: "updated_at", ascending: false }],
        limit: args.limit
      });
    if (!owner) return await boxRead([]);
    const mineFilter: DataApiFilter = {
      column: "owner_employee_id",
      op: "eq",
      value: owner.employeeId
    };
    if (!owner.includeUnowned) return await boxRead([mineFilter]);
    // The box grammar has no OR, so central's "mine OR unclaimed" leg
    // becomes two reads merged here. This one IS exact, unlike the alias
    // lookup above: the two legs are disjoint (a row is either stamped with
    // this owner or carries no owner at all), and the top `limit` of their
    // union is always contained in the union of each leg's own top `limit`,
    // so the merge returns precisely the rows the single central query
    // would have.
    const [mine, unowned] = await Promise.all([
      boxRead([mineFilter]),
      boxRead([{ column: "owner_employee_id", op: "is", value: null }])
    ]);
    return [...mine, ...unowned]
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
      .slice(0, args.limit);
  }
  let query = db
    .from("contacts")
    .select(args.columns.join(", "))
    .eq("business_id", businessId)
    .neq("tags", "{}");
  if (owner) {
    query = owner.includeUnowned
      ? query.or(`owner_employee_id.eq.${owner.employeeId},owner_employee_id.is.null`)
      : query.eq("owner_employee_id", owner.employeeId);
  }
  const { data, error } = await query
    .order("updated_at", { ascending: false })
    .limit(args.limit);
  if (error) throw new Error(`${label}: tagged contacts: ${error.message}`);
  return (data as unknown as Row[] | null) ?? [];
}

/**
 * Result of the cross-tenant contact guard. "Lookup broke" stays distinct
 * from "no such contact": a down box must never be reported to an owner as
 * "Contact not found", which would read as a data problem on their side.
 */
export type ContactExistsResult =
  | { ok: true; exists: boolean }
  | { ok: false; error: string };

/** Whether `contactId` names a contact belonging to this business. */
export async function contactExistsForBusiness(
  ctx: Omit<ContactLookupContext, "label">,
  contactId: string
): Promise<ContactExistsResult> {
  const { businessId, db, vpsReadMode } = ctx;
  if (vpsReadMode) {
    try {
      const rows = await readMovedRows<{ id: string }>(businessId, {
        table: "contacts",
        columns: ["id"],
        filters: [
          { column: "business_id", op: "eq", value: businessId },
          { column: "id", op: "eq", value: contactId }
        ],
        limit: 1
      });
      return { ok: true, exists: rows.length > 0 };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const { data, error } = await db
    .from("contacts")
    .select("id")
    .eq("business_id", businessId)
    .eq("id", contactId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, exists: data !== null };
}
