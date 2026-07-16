/**
 * Smart Lists (FUB-style saved dynamic segments) — pure domain rules.
 *
 * A segment is a NAMED, SAVED set of contact filters ("New leads this
 * week", "No contact in 5 days") the team works as a one-click list on the
 * Contacts page. Like the pipeline board, a segment is a pure VIEW over the
 * contacts table — membership is evaluated live against each contact's
 * current facts, never stored — so lists can't go stale and there is no new
 * automation surface.
 *
 * Types-only + pure functions (no Supabase import) so client components can
 * evaluate membership over already-loaded rows without server code.
 */
import { z } from "zod";

/** Caps enforced by the API (segments are cheap; the cap guards the UI). */
export const MAX_SEGMENTS_PER_BUSINESS = 20;
export const MAX_SEGMENT_NAME_LENGTH = 60;
/** Tag entries share the contacts.tags 40-char cap. */
export const MAX_SEGMENT_TAG_LENGTH = 40;

/**
 * The saved filter set. Criteria are AND-ed; every field optional, an empty
 * object matches every contact. `strict()` so a typo'd key is a validation
 * error instead of a silently-ignored filter.
 */
export const segmentFiltersSchema = z
  .object({
    /** Contact carries ANY of these tags (case-insensitive). */
    tagsAny: z
      .array(z.string().trim().min(1).max(MAX_SEGMENT_TAG_LENGTH))
      .min(1)
      .max(10)
      .optional(),
    /** Unified contact classification (the type badge on the list). */
    type: z.enum(["customer", "tester", "company", "other", "owner", "employee"]).optional(),
    /** Owned by this roster member; "none" = unowned contacts. */
    ownerEmployeeId: z.union([z.string().uuid(), z.literal("none")]).optional(),
    /** Last interaction happened on this channel (sms/voice/…). */
    lastChannel: z.string().trim().min(1).max(20).optional(),
    /** Interacted within the last N days ("active this week"). */
    lastInteractionWithinDays: z.number().int().min(1).max(365).optional(),
    /**
     * NO interaction in the last N days ("needs follow-up"). A contact with
     * no interactions at all counts as overdue — that's exactly who a
     * follow-up list must not hide.
     */
    lastInteractionOlderThanDays: z.number().int().min(1).max(365).optional(),
    /** true = never interacted at all; false = has at least one interaction. */
    neverContacted: z.boolean().optional(),
    /** Contact row created within the last N days ("new leads"). */
    createdWithinDays: z.number().int().min(1).max(365).optional()
  })
  .strict();

export type SegmentFilters = z.infer<typeof segmentFiltersSchema>;

/** A saved segment as the API serves it. */
export type ContactSegment = {
  id: string;
  businessId: string;
  name: string;
  filters: SegmentFilters;
  position: number;
};

/** The per-contact facts membership is evaluated over. */
export type SegmentContactFacts = {
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
 * Does this contact belong to the segment right now? Pure and side-effect
 * free; `nowMs` is injectable for tests. All criteria AND.
 */
export function matchesSegment(
  facts: SegmentContactFacts,
  filters: SegmentFilters,
  nowMs: number = Date.now()
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

/** Short human caption for a segment chip's tooltip ("tags: VIP · no contact 5d"). */
export function describeSegmentFilters(filters: SegmentFilters): string {
  const parts: string[] = [];
  if (filters.tagsAny) parts.push(`tags: ${filters.tagsAny.join(", ")}`);
  if (filters.type) parts.push(`type: ${filters.type}`);
  if (filters.ownerEmployeeId === "none") parts.push("unowned");
  else if (filters.ownerEmployeeId) parts.push("owned");
  if (filters.lastChannel) parts.push(`via ${filters.lastChannel}`);
  if (filters.lastInteractionWithinDays !== undefined) {
    parts.push(`active ≤${filters.lastInteractionWithinDays}d`);
  }
  if (filters.lastInteractionOlderThanDays !== undefined) {
    parts.push(`no contact ≥${filters.lastInteractionOlderThanDays}d`);
  }
  if (filters.neverContacted !== undefined) {
    parts.push(filters.neverContacted ? "never contacted" : "has history");
  }
  if (filters.createdWithinDays !== undefined) {
    parts.push(`created ≤${filters.createdWithinDays}d`);
  }
  return parts.length > 0 ? parts.join(" · ") : "all contacts";
}
