/**
 * Email-replay backfill runs (dashboard Emails page "Replay through flow").
 *
 * A backfill run replays an inbound tenant-mailbox email that arrived while
 * the flow was disabled, so the lead still gets filed and contacted. The one
 * hard rule: a replay must NEVER re-text a lead who already exists as a
 * contact — the original run (or the owner) already reached out, and a
 * duplicate intro hours later reads as spam.
 *
 * Like test mode, the flag rides on the run's persisted trigger scope so it
 * survives every park/resume. The worker's `upsert_customer` step checks it:
 * when the extracted lead already has a contacts row (alias-aware), the run
 * finalizes as done at that step — no enrichment, no send_sms, no
 * wait_for_reply. A pre-check read failure counts as "exists" for backfill
 * runs (fail SAFE: skipping one lead beats double-texting one).
 */

/** Key on the run's trigger scope marking an email-replay backfill run. */
export const BACKFILL_SKIP_EXISTING_TRIGGER_KEY = "backfill_skip_existing";

/**
 * True when a run's persisted trigger scope marks it as a backfill run that
 * must skip already-existing contacts. Stored as the string "1" (trigger
 * scope values are templated as strings), but `true` is accepted defensively.
 */
export function isBackfillSkipExistingTrigger(
  trigger: Record<string, unknown> | undefined
): boolean {
  const v = trigger?.[BACKFILL_SKIP_EXISTING_TRIGGER_KEY];
  return v === "1" || v === true;
}
