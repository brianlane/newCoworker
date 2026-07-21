/**
 * Meta Conversion Leads outbox enqueue (`meta_capi_events`).
 *
 * Called from the tag_changed contact-event chokepoint
 * (contact_events.ts), which EVERY stage-tag writer already funnels
 * through — the board's drag/dropdown move, the dashboard tag editor, MCP
 * contact updates, and the worker's update_contact step. When an ADDED tag
 * is a pipeline stage and the business has a CAPI-ready Meta connection,
 * one outbox row is recorded; the per-minute drain resolves the lead's
 * Meta identifiers (lead_submissions) and uploads the stage event to the
 * Conversions API.
 *
 * Shared (Deno + Node) and DB-only, so both runtimes get the hook without
 * duplicating logic. Never throws — feedback must never break the tag
 * write that observed the change.
 */

// Minimal structural client (matches the _shared convention).
// deno-lint-ignore no-explicit-any
type AnyClient = any;

export type StageChangeInput = {
  /** The lead whose tag changed (contact primary E.164). */
  contactE164: string;
  /** The ADDED tag (candidate stage name). */
  tag: string;
  /** Exactly-once key for this event instance (reused from the trigger). */
  dedupeKey: string;
};

/** Caps are 10 pipelines x 15 stages; one page always covers a business. */
const STAGE_PAGE = 200;

/**
 * Record one stage change for the CAPI drain when it qualifies. Returns
 * true when an outbox row was inserted (false: not a stage tag, no
 * CAPI-ready connection, duplicate, or error — all non-events).
 */
export async function recordStageChangeForMeta(
  supabase: AnyClient,
  businessId: string,
  input: StageChangeInput
): Promise<boolean> {
  try {
    const tag = input.tag.trim();
    if (!tag || !input.contactE164) return false;

    // Only businesses with a CAPI-ready connection accumulate outbox rows.
    const { data: connection, error: connErr } = await supabase
      .from("meta_connections")
      .select("id")
      .eq("business_id", businessId)
      .eq("status", "active")
      .eq("is_active", true)
      .eq("capi_enabled", true)
      .not("dataset_id", "is", null)
      .maybeSingle();
    if (connErr) {
      console.error("meta_capi: connection lookup", connErr);
      return false;
    }
    if (!connection) return false;

    // Stage tags only: a "VIP" tag is not a funnel transition. Stage names
    // match tags case-insensitively everywhere; compare in JS rather than
    // ILIKE, whose %/_ wildcards would misread stage names containing them.
    const { data: stageRows, error: stageErr } = await supabase
      .from("pipeline_stages")
      .select("name")
      .eq("business_id", businessId)
      .limit(STAGE_PAGE);
    if (stageErr) {
      console.error("meta_capi: stage lookup", stageErr);
      return false;
    }
    const tagKey = tag.toLowerCase();
    const isStage = ((stageRows ?? []) as Array<{ name?: unknown }>).some(
      (row) => typeof row.name === "string" && row.name.trim().toLowerCase() === tagKey
    );
    if (!isStage) return false;

    const { error: insertErr } = await supabase.from("meta_capi_events").insert({
      business_id: businessId,
      contact_e164: input.contactE164,
      event_name: tag,
      dedupe_key: input.dedupeKey.slice(0, 200)
    });
    if (insertErr) {
      // 23505 = the same event instance was already recorded.
      if ((insertErr as { code?: string }).code !== "23505") {
        console.error("meta_capi: outbox insert", insertErr);
      }
      return false;
    }
    return true;
  } catch (e) {
    console.error("recordStageChangeForMeta", e);
    return false;
  }
}
