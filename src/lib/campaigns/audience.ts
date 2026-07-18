/**
 * Campaign audience preview — "who would this campaign reach, right now?"
 *
 * Mirrors the sweep's snapshot filters (src/lib/campaigns/send.ts
 * `snapshotRecipients` — keep in lockstep): customer contacts with an
 * email, not marketing-unsubscribed, tag-matched case-insensitively,
 * de-duped by address, capped at CAMPAIGN_MAX_RECIPIENTS. The composer
 * calls this before scheduling so "Schedule campaign" is never a blind
 * send, and flags how many recipients are Instagram prospects still
 * pending owner review (scraped, never opted in).
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { INSTAGRAM_PROSPECT_TAG } from "@/lib/ai-flows/templates";
import { CAMPAIGN_MAX_RECIPIENTS } from "./db";
import { CAMPAIGN_AUDIENCE_SCAN_LIMIT } from "./send";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type CampaignAudiencePreview = {
  /** Contacts the campaign would snapshot for this tag ('' = everyone). */
  recipients: number;
  /** Of those, how many still carry the instagram-prospect review tag. */
  needsReview: number;
  /** True when the directory scan hit its bound — counts are floors. */
  clipped: boolean;
  /**
   * Distinct tags across the scanned emailable directory (composer
   * datalist), first-seen casing preserved, sorted case-insensitively.
   */
  tags: string[];
};

/**
 * Preview the audience a campaign with this tag would snapshot. One scan
 * serves the count, the review flag, and the tag picker.
 */
export async function previewCampaignAudience(
  businessId: string,
  audienceTag: string,
  client?: SupabaseClient
): Promise<CampaignAudiencePreview> {
  /* c8 ignore start -- production default; tests inject */
  const db = client ?? (await createSupabaseServiceClient());
  return scanAudience(db, businessId, audienceTag);
  /* c8 ignore stop */
}

/**
 * The scan itself, `db` pre-resolved: a conditional `client ?? (await …)`
 * first await in the same body makes v8 mis-attribute the query await's
 * continuation, reporting live lines as uncovered (send.ts splits its
 * snapshot helper the same way).
 */
async function scanAudience(
  db: SupabaseClient,
  businessId: string,
  audienceTag: string
): Promise<CampaignAudiencePreview> {
  const { data, error } = await db
    .from("contacts")
    .select("id, email, tags")
    .eq("business_id", businessId)
    .eq("type", "customer")
    .not("email", "is", null)
    .is("marketing_unsubscribed_at", null)
    .order("created_at", { ascending: true })
    .limit(CAMPAIGN_AUDIENCE_SCAN_LIMIT);
  if (error) throw new Error(`previewCampaignAudience: ${error.message}`);

  const returned =
    (data as Array<{ id: string; email: string | null; tags: string[] | null }> | null) ?? [];
  const scanned = returned.filter(
    (c): c is { id: string; email: string; tags: string[] | null } =>
      Boolean(c.email && c.email.includes("@"))
  );

  // Tag picker: every distinct tag in the emailable directory, before the
  // audience filter — the composer offers what an owner could target.
  const tagByLower = new Map<string, string>();
  for (const c of scanned) {
    for (const raw of c.tags ?? []) {
      const t = raw.trim();
      if (t && !tagByLower.has(t.toLowerCase())) tagByLower.set(t.toLowerCase(), t);
    }
  }
  const tags = [...tagByLower.values()].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );

  const wantedTag = audienceTag.trim().toLowerCase();
  const matched = scanned.filter(
    (c) => !wantedTag || (c.tags ?? []).some((t) => t.trim().toLowerCase() === wantedTag)
  );

  // De-dupe by address exactly like the snapshot: two rows sharing an email
  // get ONE mail, so the preview counts mails, not rows.
  const seen = new Set<string>();
  const audience = matched.filter((c) => {
    const key = c.email.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const capped = audience.slice(0, CAMPAIGN_MAX_RECIPIENTS);

  const reviewTag = INSTAGRAM_PROSPECT_TAG.toLowerCase();
  const needsReview = capped.filter((c) =>
    (c.tags ?? []).some((t) => t.trim().toLowerCase() === reviewTag)
  ).length;

  return {
    recipients: capped.length,
    needsReview,
    // Measured on the RAW query result: a scan that filled its bound may
    // hide more eligible rows even when some returned rows lacked a valid
    // email (post-filter length would under-report the clip).
    clipped: returned.length >= CAMPAIGN_AUDIENCE_SCAN_LIMIT,
    tags
  };
}

/**
 * How many contacts carry a tag, emailable or not — the Marketing page's
 * "prospects pending review" counter. Exact-match `contains` because the
 * starter template stamps the tag constant verbatim (owner-typed variants
 * with different casing are a directory-page concern, not a counter one).
 */
export async function countContactsTagged(
  businessId: string,
  tag: string,
  client?: SupabaseClient
): Promise<number> {
  /* c8 ignore start -- production default; tests inject */
  const db = client ?? (await createSupabaseServiceClient());
  return countTagged(db, businessId, tag);
  /* c8 ignore stop */
}

/** Split for the same v8 await-attribution reason as scanAudience. */
async function countTagged(
  db: SupabaseClient,
  businessId: string,
  tag: string
): Promise<number> {
  const { count, error } = await db
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .contains("tags", [tag]);
  if (error) throw new Error(`countContactsTagged: ${error.message}`);
  return count ?? 0;
}
