/**
 * Smart List nightly actions: the segment-action-sweep's core logic.
 *
 * A contact_segments row with action_enabled carries an action_tag. Once a
 * night, this module finds every contact currently matching the segment's
 * saved filters that does not already carry that tag, and adds it through
 * the SHARED tag-write mechanism (the same one the worker's update_contact
 * step and the lifecycle stager use): plan the add against the 25-tag row
 * cap, then applyGoalEvent per linked number, then a tag_changed contact
 * event, then persist the column, so the tenant's automations fire exactly
 * as if a person had added the tag in the dashboard. Never a raw column poke
 * that automations cannot see.
 *
 * Predicate parity: membership here must agree with what the Contacts page
 * shows for the same segment, so this is a faithful port of
 * `matchesSegment` (src/lib/segments/core.ts) over paginated server reads
 * (PostgREST silently caps un-limited selects at 1000 rows, so every listing
 * pages with explicit .range chunks). Two read-time overlays the page
 * applies are mirrored, and only loaded when a segment's filters need them:
 *  - implicit owner (PR #1500): on a one-person roster whose sole active
 *    member is provably the business owner, an unclaimed contact resolves
 *    to that member (`pickSoloOwner` + `soloOwnerNumbers`, the Deno twins).
 *  - type overlay: a contact whose PRIMARY number is an owner number reads
 *    as "owner", an active roster member's number as "employee"
 *    (src/lib/db/contact-names.ts order: owner wins over employee).
 *
 * Safety posture, in order of what it refuses to do:
 *  - Stored filters are re-validated STRICTLY here. The dashboard read path
 *    degrades an unparseable filter set to "all contacts" for DISPLAY; an
 *    ACTION that did the same would tag the entire directory off a corrupt
 *    row, so an invalid filter set skips the segment with a recorded error
 *    instead.
 *  - Tag writes are capped per business per run (MAX_TAG_WRITES_PER_RUN) to
 *    bound automation storms; a truncated business is recorded in the
 *    result AND logged, never silent. Membership is evaluated live and
 *    already-tagged contacts are skipped, so the next night converges on
 *    the remainder.
 *  - The contacts-row 25-tag cap is enforced exactly like the worker's
 *    update_contact: a full contact drops the tag explicitly (counted),
 *    never silently.
 *  - The automations are announced BEFORE the tag column is persisted. The
 *    persisted tag is the only record this sweep keeps of what it already
 *    did, so it has to be written last: a half-finished run must not be
 *    able to retire a contact whose automation never got enqueued. Full
 *    reasoning at the write site.
 *
 * Everything is dependency-injected (client + clock) and never throws, so
 * the whole surface is unit-testable under the shared 100% coverage gate.
 */
import { applyGoalEvent } from "./ai_flows/goal_events.ts";
import { enqueueContactEventRuns } from "./ai_flows/contact_events.ts";
import { pickSoloOwner, soloOwnerNumbers, type SoloRosterRow } from "./solo_owner.ts";

// Minimal structural client (the _shared convention).
// deno-lint-ignore no-explicit-any
type AnyClient = any;

/** Tag writes allowed per business per run, bounding automation fan-out. */
export const MAX_TAG_WRITES_PER_RUN = 200;
/** Contacts page size (explicit, because un-limited selects clamp at 1000). */
export const CONTACT_PAGE = 500;
/** Enabled-segment listing page size. */
export const SEGMENT_PAGE = 200;
/** The contacts.tags row cap, matching the worker's update_contact. */
const MAX_TAGS_PER_CONTACT = 25;
/** Per-tag length cap, matching the worker's `.slice(0, 40)`. */
const MAX_TAG_LENGTH = 40;

/**
 * The saved filter shape, mirroring segmentFiltersSchema field for field.
 * Kept import-free of src/lib (this file must run under Deno), which is why
 * the validation below re-states the schema instead of importing zod.
 */
export type SegmentActionFilters = {
  tagsAny?: string[];
  type?: "customer" | "tester" | "company" | "other" | "owner" | "employee";
  ownerEmployeeId?: string;
  lastChannel?: string;
  lastInteractionWithinDays?: number;
  lastInteractionOlderThanDays?: number;
  neverContacted?: boolean;
  createdWithinDays?: number;
};

const FILTER_KEYS = new Set([
  "tagsAny",
  "type",
  "ownerEmployeeId",
  "lastChannel",
  "lastInteractionWithinDays",
  "lastInteractionOlderThanDays",
  "neverContacted",
  "createdWithinDays"
]);

const CONTACT_TYPES = new Set([
  "customer",
  "tester",
  "company",
  "other",
  "owner",
  "employee"
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isDayCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 365;
}

/**
 * Strict parse of a stored filters jsonb. Mirrors segmentFiltersSchema
 * (including `.strict()`: an unknown key invalidates the whole set) but
 * fails CLOSED: null means "skip this segment", never "match everyone".
 */
export function parseSegmentActionFilters(raw: unknown): SegmentActionFilters | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const out: SegmentActionFilters = {};
  for (const key of Object.keys(source)) {
    if (!FILTER_KEYS.has(key)) return null;
  }
  if (source.tagsAny !== undefined) {
    if (!Array.isArray(source.tagsAny)) return null;
    const tags: string[] = [];
    for (const entry of source.tagsAny) {
      if (typeof entry !== "string") return null;
      const tag = entry.trim();
      if (tag.length < 1 || tag.length > MAX_TAG_LENGTH) return null;
      tags.push(tag);
    }
    if (tags.length < 1 || tags.length > 10) return null;
    out.tagsAny = tags;
  }
  if (source.type !== undefined) {
    if (typeof source.type !== "string" || !CONTACT_TYPES.has(source.type)) return null;
    out.type = source.type as SegmentActionFilters["type"];
  }
  if (source.ownerEmployeeId !== undefined) {
    if (
      typeof source.ownerEmployeeId !== "string" ||
      (source.ownerEmployeeId !== "none" && !UUID_RE.test(source.ownerEmployeeId))
    ) {
      return null;
    }
    out.ownerEmployeeId = source.ownerEmployeeId;
  }
  if (source.lastChannel !== undefined) {
    if (typeof source.lastChannel !== "string") return null;
    const channel = source.lastChannel.trim();
    if (channel.length < 1 || channel.length > 20) return null;
    out.lastChannel = channel;
  }
  if (source.lastInteractionWithinDays !== undefined) {
    if (!isDayCount(source.lastInteractionWithinDays)) return null;
    out.lastInteractionWithinDays = source.lastInteractionWithinDays;
  }
  if (source.lastInteractionOlderThanDays !== undefined) {
    if (!isDayCount(source.lastInteractionOlderThanDays)) return null;
    out.lastInteractionOlderThanDays = source.lastInteractionOlderThanDays;
  }
  if (source.neverContacted !== undefined) {
    if (typeof source.neverContacted !== "boolean") return null;
    out.neverContacted = source.neverContacted;
  }
  if (source.createdWithinDays !== undefined) {
    if (!isDayCount(source.createdWithinDays)) return null;
    out.createdWithinDays = source.createdWithinDays;
  }
  return out;
}

/** The per-contact facts membership is evaluated over (the page's shape). */
export type SegmentActionContactFacts = {
  tags: string[];
  type: string;
  ownerEmployeeId: string | null;
  lastChannel: string | null;
  lastInteractionAt: string | null;
  totalInteractions: number;
  createdAt: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Epoch ms, or null for missing/unparseable timestamps (fail like "never"). */
function toMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Does this contact belong to the segment right now? A line-for-line port of
 * `matchesSegment` (src/lib/segments/core.ts); all criteria AND.
 */
export function matchesSegmentFilters(
  facts: SegmentActionContactFacts,
  filters: SegmentActionFilters,
  nowMs: number
): boolean {
  if (filters.tagsAny) {
    const wanted = new Set(filters.tagsAny.map((t) => t.trim().toLowerCase()));
    if (!facts.tags.some((t) => wanted.has(t.trim().toLowerCase()))) return false;
  }
  if (filters.type && facts.type !== filters.type) return false;
  if (filters.ownerEmployeeId) {
    if (filters.ownerEmployeeId === "none") {
      if (facts.ownerEmployeeId) return false;
    } else if (facts.ownerEmployeeId !== filters.ownerEmployeeId) {
      return false;
    }
  }
  if (
    filters.lastChannel &&
    (facts.lastChannel ?? "").toLowerCase() !== filters.lastChannel.toLowerCase()
  ) {
    return false;
  }
  const lastMs = toMs(facts.lastInteractionAt);
  if (filters.lastInteractionWithinDays !== undefined) {
    if (lastMs === null || nowMs - lastMs > filters.lastInteractionWithinDays * DAY_MS) {
      return false;
    }
  }
  if (filters.lastInteractionOlderThanDays !== undefined) {
    // "Never contacted" is maximally overdue, so null passes.
    if (lastMs !== null && nowMs - lastMs < filters.lastInteractionOlderThanDays * DAY_MS) {
      return false;
    }
  }
  if (filters.neverContacted !== undefined) {
    const never = facts.totalInteractions === 0;
    if (never !== filters.neverContacted) return false;
  }
  if (filters.createdWithinDays !== undefined) {
    const createdMs = toMs(facts.createdAt);
    if (createdMs === null || nowMs - createdMs > filters.createdWithinDays * DAY_MS) {
      return false;
    }
  }
  return true;
}

/**
 * The worker's update_contact tag plan, add-only: normalize the stored list
 * (trim, 40-char slice, case-insensitive de-dup), then add each candidate
 * unless it is already carried or the 25-tag row cap is full.
 */
export function planContactTagAdds(
  storedTags: unknown,
  candidates: string[]
): { next: string[]; added: string[]; alreadyCarried: string[]; droppedAtCap: string[] } {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(storedTags) ? storedTags : []) {
    if (typeof t !== "string") continue;
    const tag = t.trim().slice(0, MAX_TAG_LENGTH);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    next.push(tag);
  }
  const added: string[] = [];
  const alreadyCarried: string[] = [];
  const droppedAtCap: string[] = [];
  for (const candidate of candidates) {
    const tag = candidate.trim().slice(0, MAX_TAG_LENGTH);
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      alreadyCarried.push(tag);
      continue;
    }
    if (next.length >= MAX_TAGS_PER_CONTACT) {
      droppedAtCap.push(tag);
      continue;
    }
    seen.add(key);
    next.push(tag);
    added.push(tag);
  }
  return { next, added, alreadyCarried, droppedAtCap };
}

type EnabledSegmentRow = {
  id: string;
  business_id: string;
  name: string;
  filters: unknown;
  action_tag: string | null;
};

type ContactRow = {
  id: string;
  customer_e164: string | null;
  alias_e164s: string[] | null;
  tags: string[] | null;
  type: string | null;
  owner_employee_id: string | null;
  last_channel: string | null;
  last_interaction_at: string | null;
  total_interaction_count: number | null;
  created_at: string | null;
};

type ValidSegment = {
  id: string;
  name: string;
  tag: string;
  filters: SegmentActionFilters;
};

export type SegmentActionSweepResult = {
  /** Businesses with at least one enabled segment action. */
  businesses: number;
  /** Enabled segment actions seen. */
  segments: number;
  /** Segments evaluated and stamped this run. */
  applied: number;
  /** Segments skipped because their stored filters failed strict validation. */
  invalidFilters: number;
  contactsScanned: number;
  tagsWritten: number;
  /** Matches that already carried the tag (nothing to do). */
  alreadyTagged: number;
  /** Adds refused by the contacts-row 25-tag cap. */
  droppedAtTagCap: number;
  /** Businesses whose run was truncated by MAX_TAG_WRITES_PER_RUN. */
  cappedBusinesses: string[];
  errors: string[];
};

/** Every enabled segment action, paged, grouped by business. Never throws. */
async function listEnabledSegments(
  supabase: AnyClient,
  errors: string[]
): Promise<Map<string, EnabledSegmentRow[]>> {
  const byBusiness = new Map<string, EnabledSegmentRow[]>();
  for (let offset = 0; ; offset += SEGMENT_PAGE) {
    const { data, error } = await supabase
      .from("contact_segments")
      .select("id, business_id, name, filters, action_tag")
      .eq("action_enabled", true)
      .order("business_id", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + SEGMENT_PAGE - 1);
    if (error) {
      errors.push(`segment listing: ${error.message}`);
      break;
    }
    const rows = (data ?? []) as EnabledSegmentRow[];
    for (const row of rows) {
      const list = byBusiness.get(row.business_id) ?? [];
      list.push(row);
      byBusiness.set(row.business_id, list);
    }
    if (rows.length < SEGMENT_PAGE) break;
  }
  return byBusiness;
}

/**
 * The read-time overlays a business's segments may need: the active roster
 * (type overlay) and the owner numbers + implicit owner (owner matching).
 * Returns null when the roster cannot be read, because evaluating a type or
 * owner filter without it would tag the wrong people.
 */
async function loadOwnerOverlay(
  supabase: AnyClient,
  businessId: string
): Promise<{
  ownerNumbers: Set<string>;
  rosterPhones: Set<string>;
  implicitOwnerId: string | null;
} | null> {
  const { data, error } = await supabase
    .from("ai_flow_team_members")
    .select("id, name, phone_e164, email, active")
    .eq("business_id", businessId);
  if (error) {
    console.error("segment_actions: roster read", error);
    return null;
  }
  const roster = (data ?? []) as SoloRosterRow[];
  const ownerNumbers = new Set(await soloOwnerNumbers(supabase, businessId));
  const rosterPhones = new Set(
    roster
      .filter((m) => m.active === true)
      .map((m) => m.phone_e164 ?? "")
      .filter((p) => p.length > 0)
  );
  const implicitOwnerId = pickSoloOwner(roster, [...ownerNumbers])?.memberId ?? null;
  return { ownerNumbers, rosterPhones, implicitOwnerId };
}

/** One business's pass; failures land in `result.errors`. */
async function sweepBusiness(
  supabase: AnyClient,
  businessId: string,
  segments: ValidSegment[],
  nowMs: number,
  maxWrites: number,
  result: SegmentActionSweepResult
): Promise<void> {
  // The overlays cost reads, so they are loaded only when a filter needs
  // them. An unreadable roster skips the business rather than guessing.
  const needsOverlay = segments.some(
    (s) => s.filters.type !== undefined || s.filters.ownerEmployeeId !== undefined
  );
  let overlay: Awaited<ReturnType<typeof loadOwnerOverlay>> = null;
  if (needsOverlay) {
    overlay = await loadOwnerOverlay(supabase, businessId);
    if (overlay === null) {
      result.errors.push(`business ${businessId}: roster unreadable, skipped`);
      return;
    }
  }

  let budget = maxWrites;
  let capped = false;

  for (let offset = 0; !capped; offset += CONTACT_PAGE) {
    const { data, error } = await supabase
      .from("contacts")
      .select(
        "id, customer_e164, alias_e164s, tags, type, owner_employee_id, last_channel, " +
          "last_interaction_at, total_interaction_count, created_at"
      )
      .eq("business_id", businessId)
      .order("id", { ascending: true })
      .range(offset, offset + CONTACT_PAGE - 1);
    if (error) {
      // A partial pass must not stamp last_applied_at, so surface and stop.
      result.errors.push(`business ${businessId}: contact page read: ${error.message}`);
      return;
    }
    const rows = (data ?? []) as ContactRow[];

    for (const contact of rows) {
      const primary = (contact.customer_e164 ?? "").trim();
      if (!primary) continue;
      result.contactsScanned += 1;

      const storedType = contact.type ?? "other";
      // The page's overlay order: owner numbers win over the roster, both
      // matched on the PRIMARY number only (src/lib/db/contact-names.ts).
      const effectiveType = overlay
        ? overlay.ownerNumbers.has(primary)
          ? "owner"
          : overlay.rosterPhones.has(primary)
            ? "employee"
            : storedType
        : storedType;
      const facts: SegmentActionContactFacts = {
        tags: (contact.tags ?? []).filter((t): t is string => typeof t === "string"),
        type: effectiveType,
        ownerEmployeeId: contact.owner_employee_id ?? overlay?.implicitOwnerId ?? null,
        lastChannel: contact.last_channel,
        lastInteractionAt: contact.last_interaction_at,
        totalInteractions: contact.total_interaction_count ?? 0,
        createdAt: contact.created_at ?? ""
      };

      // Candidate tags for this contact, first segment wins per tag identity.
      const candidates: Array<{ tag: string; segment: ValidSegment }> = [];
      for (const segment of segments) {
        if (!matchesSegmentFilters(facts, segment.filters, nowMs)) continue;
        const key = segment.tag.trim().toLowerCase();
        if (candidates.some((c) => c.tag.trim().toLowerCase() === key)) continue;
        candidates.push({ tag: segment.tag, segment });
      }
      if (candidates.length === 0) continue;

      const plan = planContactTagAdds(
        contact.tags ?? [],
        candidates.map((c) => c.tag)
      );
      result.alreadyTagged += plan.alreadyCarried.length;
      result.droppedAtTagCap += plan.droppedAtCap.length;
      let writes = plan.added;
      if (writes.length > budget) {
        writes = writes.slice(0, budget);
        capped = true;
      }
      if (writes.length === 0) {
        if (capped) break;
        continue;
      }
      // Re-plan with only the budgeted adds so the row that gets persisted
      // carries exactly what the hooks announce.
      const finalPlan = planContactTagAdds(contact.tags ?? [], writes);

      // ANNOUNCE FIRST, PERSIST SECOND, deliberately.
      //
      // The tag on the contacts row is the only record this sweep keeps of
      // what it already did: a contact carrying the tag is skipped on every
      // later night. Writing the column first therefore makes it a point of
      // no return. This run can die at any moment (the route is capped at
      // 150s, and it may spend that on up to 200 writes, each costing a
      // goal-event pass plus a full flow listing), and a death between the
      // column write and the hooks would leave the tag sitting there with
      // tag_changed never enqueued, on that night and on every night after,
      // for exactly the contacts this feature exists to act on.
      //
      // With the order flipped, a death anywhere above the write leaves the
      // tag absent, so the next night re-evaluates the contact and finishes
      // the job. The repair cannot fire an automation twice: the dedupe key
      // below identifies the tag APPLICATION, not the night it was tried,
      // so the second delivery is a benign 23505 against the ai_flow_runs
      // (flow_id, dedupe_key) index and the matching meta_capi_events one.
      // A normal repeat night never even reaches here, because the tag is
      // already carried and the contact is skipped above.
      //
      // The exposure this leaves is the inverse one, and it self-heals: if
      // the column write below errors after the hooks fired, the tag lands
      // on the next night's pass instead, one night late rather than never.
      const numbers = [
        ...new Set(
          [primary, ...(contact.alias_e164s ?? [])].filter(
            (n) => typeof n === "string" && n.length > 0
          )
        )
      ];
      // The same hooks, in the same order, as update_contact's tag write.
      for (const tag of finalPlan.added) {
        for (const number of numbers) {
          await applyGoalEvent(supabase, businessId, number, { kind: "tag_added", tag });
        }
      }
      for (const tag of finalPlan.added) {
        const source = candidates.find(
          (c) => c.tag.trim().slice(0, MAX_TAG_LENGTH).toLowerCase() === tag.toLowerCase()
        )!.segment;
        await enqueueContactEventRuns(supabase, businessId, {
          kind: "tag_changed",
          // The post-write list, which is what the contact is about to
          // carry; hydrateContactEventContact leaves caller tags alone.
          contact: { e164: primary, tags: finalPlan.next },
          tag,
          change: "added",
          note: `Smart List "${source.name}" nightly action`,
          dedupeKey: `ce:segact:${source.id}:${contact.id}:${tag.toLowerCase()}`
        });
      }

      const { error: writeErr } = await supabase
        .from("contacts")
        .update({ tags: finalPlan.next, updated_at: new Date(nowMs).toISOString() })
        .eq("id", contact.id);
      if (writeErr) {
        result.errors.push(
          `business ${businessId}: tag write for contact ${contact.id}: ${writeErr.message}`
        );
        if (capped) break;
        continue;
      }
      budget -= finalPlan.added.length;
      result.tagsWritten += finalPlan.added.length;
      if (capped) break;
    }

    if (rows.length < CONTACT_PAGE) break;
  }

  if (capped) {
    result.cappedBusinesses.push(businessId);
    console.warn(
      `segment_actions: business ${businessId} hit the ${maxWrites}-write cap; ` +
        "remaining matches wait for the next nightly run"
    );
  }

  // Stamp the segments this pass evaluated. A capped pass still counts: the
  // stamp records the sweep's last visit, and the skipped remainder is
  // picked up tomorrow because already-tagged contacts are skipped.
  const { error: stampErr } = await supabase
    .from("contact_segments")
    .update({ last_applied_at: new Date(nowMs).toISOString() })
    .in(
      "id",
      segments.map((s) => s.id)
    );
  if (stampErr) {
    result.errors.push(`business ${businessId}: last_applied_at stamp: ${stampErr.message}`);
    return;
  }
  result.applied += segments.length;
}

/**
 * Run the nightly sweep across every business with an enabled segment
 * action. Never throws; failures land in `result.errors` (one business's
 * failure never blocks another's pass). `nowMs` and `maxWritesPerBusiness`
 * are injectable for tests; production callers pass neither.
 */
export async function runSegmentActionSweep(
  supabase: AnyClient,
  nowMs: number = Date.now(),
  maxWritesPerBusiness: number = MAX_TAG_WRITES_PER_RUN
): Promise<SegmentActionSweepResult> {
  const result: SegmentActionSweepResult = {
    businesses: 0,
    segments: 0,
    applied: 0,
    invalidFilters: 0,
    contactsScanned: 0,
    tagsWritten: 0,
    alreadyTagged: 0,
    droppedAtTagCap: 0,
    cappedBusinesses: [],
    errors: []
  };

  const byBusiness = await listEnabledSegments(supabase, result.errors);
  result.businesses = byBusiness.size;

  for (const businessId of [...byBusiness.keys()].sort()) {
    const rows = byBusiness.get(businessId)!;
    result.segments += rows.length;

    const valid: ValidSegment[] = [];
    for (const row of rows) {
      // The DB check constraint guarantees an enabled action has a tag; a
      // blank one would mean drift, and gets the same fail-closed skip as
      // invalid filters.
      const tag = (row.action_tag ?? "").trim();
      const filters = parseSegmentActionFilters(row.filters);
      if (!tag || filters === null) {
        result.invalidFilters += 1;
        result.errors.push(
          `segment ${row.id} ("${row.name}"): ${tag ? "invalid stored filters" : "missing action tag"}, skipped`
        );
        continue;
      }
      valid.push({ id: row.id, name: row.name, tag, filters });
    }
    if (valid.length === 0) continue;

    try {
      await sweepBusiness(supabase, businessId, valid, nowMs, maxWritesPerBusiness, result);
    } catch (e) {
      // sweepBusiness handles its own expected failures; this guards a
      // throwing client so one business cannot take down the fleet's night.
      console.error("segment_actions: business sweep threw", e);
      result.errors.push(
        `business ${businessId}: sweep threw: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  return result;
}
