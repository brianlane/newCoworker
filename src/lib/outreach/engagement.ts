/**
 * Prospecting: has this prospect already answered us some other way?
 *
 * The follow-up is scheduled off SILENCE, and until now the only thing that
 * counted as noise was an inbound email on an owned thread
 * (`noteProspectReply`, the sole writer of `replied_at`). Nothing else set it:
 * not a booking, not a call, not a meeting.
 *
 * That is a real gap rather than a corner case, because the pitch itself
 * carries a booking-page link (`outreachSchedulingLink`). "Clicks the link,
 * books, never replies by email" is the path the mail is written to produce.
 * So the sequence below was live:
 *
 *   day 0  cold email goes out, with a booking link
 *   day 1  prospect books from the link and never replies
 *   day 3  the meeting happens, the minutes classifier moves them to Won
 *   day 5  "I wrote last week..." lands on somebody who already signed
 *
 * Two INDEPENDENT signals close it, and either one is enough:
 *
 *   1. A BOOKING exists for them since we mailed. Board-independent, which
 *      matters because a pipeline is optional and a tenant may run
 *      prospecting without ever creating one.
 *   2. Their contact has moved PAST the stage prospecting itself writes.
 *      That covers every other way a lead advances (a reply on any channel, a
 *      claim, a meeting classified as signed) in one condition, for tenants
 *      who do keep a board.
 *
 * Deliberately NOT keyed on `outreach_prospects.contact_id`: that column
 * exists on the row type and is patchable, but nothing in the codebase ever
 * writes it, and it is null on every sent prospect in production. The working
 * join from a prospect to a contact is the PHONE, which is what
 * `reconcileContactedForBusiness` uses to fire the Contacted stage.
 *
 * FAIL DIRECTION: an unreadable signal answers "engaged", which SUPPRESSES the
 * nudge. This module's whole job is deciding whether a marketing email is
 * appropriate, and the sweep's own doctrine already settles the direction: a
 * duplicate cold email is a spam complaint while a missed one costs nothing.
 * A suppressed batch is not lost either, because nothing is stamped: the same
 * prospects are due again on the next pass five minutes later. Only a
 * PERSISTENTLY broken read stops follow-ups, and the caller surfaces that as a
 * sweep note rather than letting it be silent.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import {
  isE164,
  normalizeNanpToE164
} from "../../../supabase/functions/_shared/ai_flows/engine";
import { contactAliasOrFilter } from "../../../supabase/functions/_shared/contact_key";
import {
  LIFECYCLE_STAGE_TAGS,
  stageForTags,
  type StageRef
} from "../../../supabase/functions/_shared/pipelines/stages";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** The prospect fields this check needs; the ledger row supplies all of them. */
export type EngagementCandidate = {
  id: string;
  phone: string | null;
  email: string | null;
  /** When the pitch went out. Only engagement AFTER this counts. */
  sent_at: string | null;
};

export type EngagementResult = {
  /** Prospect ids that must not be nudged. */
  engaged: Set<string>;
  /**
   * A signal could not be read, so `engaged` is not trustworthy. The caller
   * suppresses the whole batch and says so; see the fail direction above.
   */
  readFailed: boolean;
};

/**
 * The prospect's phone as a contact key, or null when it will not normalize.
 * Same normalization `fireLifecycleStage` applies, so this resolves the same
 * contact the Contacted stage was written to.
 */
export function prospectContactKey(phone: string | null | undefined): string | null {
  const raw = (phone ?? "").trim();
  if (!raw) return null;
  return isE164(raw) ? raw : normalizeNanpToE164(raw);
}

/**
 * Which of these prospects have engaged with us since we mailed them.
 *
 * Batched: two reads for the whole nudge batch rather than two per prospect,
 * because the sweep runs every five minutes across the fleet.
 */
export async function findEngagedProspects(
  businessId: string,
  prospects: EngagementCandidate[],
  client?: SupabaseClient
): Promise<EngagementResult> {
  const engaged = new Set<string>();
  if (prospects.length === 0) return { engaged, readFailed: false };

  let db: SupabaseClient;
  try {
    db = client ?? (await createSupabaseServiceClient());
  } catch (err) {
    logger.warn("outreach: engagement check could not reach the database", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { engaged, readFailed: true };
  }

  const earliestSent = prospects
    .map((p) => p.sent_at)
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .sort()[0];

  const [booked, advanced] = await Promise.all([
    findBookedProspects(db, businessId, prospects, earliestSent),
    findAdvancedProspects(db, businessId, prospects)
  ]);

  for (const id of booked.ids) engaged.add(id);
  for (const id of advanced.ids) engaged.add(id);
  return { engaged, readFailed: booked.readFailed || advanced.readFailed };
}

/** Signal 1: they took a slot from the link the pitch carried. */
async function findBookedProspects(
  db: SupabaseClient,
  businessId: string,
  prospects: EngagementCandidate[],
  earliestSent: string | undefined
): Promise<{ ids: string[]; readFailed: boolean }> {
  const ids: string[] = [];
  try {
    // Bounded by the oldest pitch in the batch, so this never scans a
    // tenant's whole booking history. `created_at` rather than `start_at`:
    // booking a slot for next month is engagement TODAY.
    const base = db
      .from("calendar_booking_dedupe")
      .select("attendee_key, attendee_email, created_at")
      .eq("business_id", businessId);
    const { data, error } = await (earliestSent
      ? base.gte("created_at", earliestSent)
      : base
    ).limit(500);
    if (error) {
      logger.warn("outreach: booking signal unreadable", {
        businessId,
        error: error.message
      });
      return { ids, readFailed: true };
    }
    const rows = (data ?? []) as Array<{
      attendee_key: string | null;
      attendee_email: string | null;
      created_at: string;
    }>;
    for (const prospect of prospects) {
      const email = prospect.email?.trim().toLowerCase() ?? "";
      const key = prospectContactKey(prospect.phone);
      const sentAt = prospect.sent_at ?? "";
      const hit = rows.some((row) => {
        // Engagement has to POSTDATE the pitch; an older booking is a
        // relationship that predates the outreach, not a response to it.
        if (sentAt && row.created_at < sentAt) return false;
        const rowEmail = row.attendee_email?.trim().toLowerCase() ?? "";
        if (email && rowEmail && rowEmail === email) return true;
        const rowKey = (row.attendee_key ?? "").trim();
        if (email && rowKey.toLowerCase() === `email:${email}`) return true;
        if (key && rowKey === `phone:${key}`) return true;
        return false;
      });
      if (hit) ids.push(prospect.id);
    }
    return { ids, readFailed: false };
  } catch (err) {
    logger.warn("outreach: booking signal threw", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ids, readFailed: true };
  }
}

/** Signal 2: their card has moved past the stage prospecting itself writes. */
async function findAdvancedProspects(
  db: SupabaseClient,
  businessId: string,
  prospects: EngagementCandidate[]
): Promise<{ ids: string[]; readFailed: boolean }> {
  const ids: string[] = [];
  const keyed = prospects
    .map((p) => ({ id: p.id, key: prospectContactKey(p.phone) }))
    .filter((p): p is { id: string; key: string } => p.key !== null);
  if (keyed.length === 0) return { ids, readFailed: false };

  try {
    const { data: stageRows, error: stageError } = await db
      .from("pipeline_stages")
      .select("id, pipeline_id, name, position")
      .eq("business_id", businessId)
      .order("position", { ascending: true });
    if (stageError) {
      logger.warn("outreach: stage signal unreadable", {
        businessId,
        error: stageError.message
      });
      return { ids, readFailed: true };
    }
    const byPipeline = new Map<string, StageRef[]>();
    for (const raw of (stageRows ?? []) as Array<{
      id: string;
      pipeline_id: string;
      name: string;
      position: number;
    }>) {
      const list = byPipeline.get(raw.pipeline_id) ?? [];
      list.push({ id: raw.id, name: raw.name, position: raw.position });
      byPipeline.set(raw.pipeline_id, list);
    }
    // No board, or a board with no Contacted column, means this signal has
    // nothing to anchor against. That is not a failure: the booking signal
    // stands on its own, which is exactly why there are two of them.
    if (byPipeline.size === 0) return { ids, readFailed: false };

    for (const prospect of keyed) {
      const tags = await contactTags(db, businessId, prospect.key);
      if (tags === null) return { ids, readFailed: true };
      if (tags.length === 0) continue;
      if (hasAdvancedPastContacted([...byPipeline.values()], tags)) ids.push(prospect.id);
    }
    return { ids, readFailed: false };
  } catch (err) {
    logger.warn("outreach: stage signal threw", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ids, readFailed: true };
  }
}

/**
 * Is this tag set past "Contacted" on ANY of the business's boards?
 *
 * Anchored on the stage prospecting itself writes rather than on a fixed
 * position, so a board with extra columns in front of Contacted still
 * compares the right thing. A board with no Contacted column contributes
 * nothing: the outreach reconcile writes no stage there either, so there is
 * no "past" to be past of.
 */
export function hasAdvancedPastContacted(
  pipelines: StageRef[][],
  tags: string[]
): boolean {
  const anchor = LIFECYCLE_STAGE_TAGS.contacted.toLowerCase();
  for (const stages of pipelines) {
    const contacted = stages.find((s) => s.name.trim().toLowerCase() === anchor);
    if (!contacted) continue;
    const current = stageForTags(stages, tags);
    if (current && current.position > contacted.position) return true;
  }
  return false;
}

/** A contact's tags by key, alias-aware. Null means the read failed. */
async function contactTags(
  db: SupabaseClient,
  businessId: string,
  contactKey: string
): Promise<string[] | null> {
  const filter = contactAliasOrFilter(contactKey);
  /* c8 ignore next -- unreachable: the key comes from prospectContactKey, so
     it is always E.164, and contactAliasOrFilter only returns null for the
     `email:` shape. Guarded rather than asserted so a future caller passing
     an email key degrades to "no tags" instead of throwing. */
  if (!filter) return [];
  const { data, error } = await db
    .from("contacts")
    .select("tags")
    .eq("business_id", businessId)
    // Alias-aware: a merged profile keeps the old number in alias_e164s, and
    // the prospect ledger may still hold that one.
    .or(filter)
    .maybeSingle();
  if (error) {
    logger.warn("outreach: contact tags unreadable", {
      businessId,
      error: error.message
    });
    return null;
  }
  const row = data as { tags: string[] | null } | null;
  if (!row) return [];
  return (row.tags ?? []).filter(
    (t): t is string => typeof t === "string" && t.trim().length > 0
  );
}
