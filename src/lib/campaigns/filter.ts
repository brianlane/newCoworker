/**
 * Who a campaign reaches: the ONE implementation, shared by the composer's
 * live preview (audience.ts) and the sweep's snapshot (send.ts).
 *
 * Those two had the same filters written out twice, with a comment on each
 * asking the next person to keep them in lockstep. That held while the rule
 * was "carries this tag". It stopped being a reasonable ask once the rule
 * grew a subtraction and a stage lookup: a preview that promises 400
 * recipients and a send that mails 550 is worse than either number alone,
 * because the owner approved the first one.
 *
 * Everything here is pure. The callers do the reads (contacts, and the
 * board) and hand the rows over.
 */
import {
  LIFECYCLE_STAGE_TAGS,
  stageForTags,
  type StageRef
} from "../../../supabase/functions/_shared/pipelines/stages";

/** The contact fields the audience rules look at. */
export type AudienceContact = {
  id: string;
  email: string;
  tags: string[] | null;
};

/** One pipeline's stages, ordered by position, as the board read returns them. */
export type AudienceBoard = StageRef[];

export type AudienceRules = {
  /** Tag a contact must carry. Blank = every emailable contact. */
  audienceTag: string;
  /** Tag that takes a contact OUT, whatever else matched. Blank = subtract nothing. */
  excludeTag: string;
  /** False leaves out contacts at or past the won stage. */
  includeClosed: boolean;
  /** The business's boards; empty means no closed-customer rule can apply. */
  boards: AudienceBoard[];
};

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** `wanted` is always non-blank: both call sites gate on the tag first. */
function hasTag(contact: AudienceContact, wanted: string): boolean {
  return (contact.tags ?? []).some((t) => t.trim().toLowerCase() === wanted);
}

/**
 * Is this contact already a customer, by their position on the board?
 *
 * Resolved against the tenant's OWN stages rather than a hardcoded "Won",
 * and by POSITION rather than by name, so the two ways a board can differ
 * both work: a renamed column still anchors on whatever the platform writes
 * for a won deal, and columns AFTER it (Onboarded, Active on the New
 * Coworker board) count as closed too, which is what an owner means by "do
 * not mail my existing customers".
 *
 * A board with no won column contributes nothing rather than guessing: the
 * platform writes no won stage there either, so there is no "closed" to
 * detect. Same shape as hasAdvancedPastContacted in outreach/engagement.ts.
 */
export function isClosedCustomer(boards: AudienceBoard[], tags: string[] | null): boolean {
  const anchor = LIFECYCLE_STAGE_TAGS.won.toLowerCase();
  const owned = (tags ?? []).filter(
    (t): t is string => typeof t === "string" && t.trim().length > 0
  );
  if (owned.length === 0) return false;
  for (const stages of boards) {
    const won = stages.find((s) => s.name.trim().toLowerCase() === anchor);
    if (!won) continue;
    const current = stageForTags(stages, owned);
    if (current && current.position >= won.position) return true;
  }
  return false;
}

/**
 * Apply the audience rules, then de-dupe by address.
 *
 * De-duping LAST and by lowercased address is load-bearing in both callers:
 * two contact rows sharing an email must produce ONE mail, so the preview
 * counts mails rather than rows and the snapshot inserts one recipient.
 */
export function selectCampaignAudience(
  contacts: AudienceContact[],
  rules: AudienceRules
): AudienceContact[] {
  const wanted = normalizeTag(rules.audienceTag);
  const excluded = normalizeTag(rules.excludeTag);

  const matched = contacts.filter((c) => {
    // Addition first: the tag the owner asked for, or everyone.
    if (wanted && !hasTag(c, wanted)) return false;
    // Then the subtractions, in the order the composer presents them.
    if (excluded && hasTag(c, excluded)) return false;
    if (!rules.includeClosed && isClosedCustomer(rules.boards, c.tags)) return false;
    return true;
  });

  const seen = new Set<string>();
  return matched.filter((c) => {
    const key = c.email.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Group the flat `pipeline_stages` read into one entry per board. */
export function boardsFromStageRows(
  rows: Array<{ id: string; pipeline_id: string; name: string; position: number }>
): AudienceBoard[] {
  const byPipeline = new Map<string, StageRef[]>();
  for (const row of rows) {
    const list = byPipeline.get(row.pipeline_id) ?? [];
    list.push({ id: row.id, name: row.name, position: row.position });
    byPipeline.set(row.pipeline_id, list);
  }
  return [...byPipeline.values()];
}

