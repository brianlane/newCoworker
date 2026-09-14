/**
 * Skip a second AiFlow enqueue when an ACTIVE run of the same flow already
 * carries this trigger URL.
 *
 * HomeLight (and other "text then link" vendors) send the alert and the URL as
 * two SMS, then often a third "too late" text that still matches has_url plus
 * the earlier alert in the correlation window. Persisting each inbound job
 * before evaluation lets the URL SMS start the run. Without this guard the
 * withdrawal SMS would start a SECOND run of the same referral.
 *
 * Fail OPEN on a lookup error: a duplicate follow-up is recoverable, a
 * silently dropped lead is not. Empty or missing URLs never dedupe: those
 * flows have nothing unique to key on.
 */
// deno-lint-ignore no-explicit-any
type AnyClient = any;

/** Run statuses that still own the lead. Finished rows do not block a new one. */
export const ACTIVE_TRIGGER_URL_RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_agent",
  "awaiting_reply",
  "awaiting_call"
] as const;

export function triggerUrlDedupeKey(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Returns the id of an active run of `flowId` whose trigger.url equals `url`,
 * or null when none exists / the lookup failed / the url is empty.
 */
export async function findActiveRunWithTriggerUrl(
  supabase: AnyClient,
  args: { businessId: string; flowId: string; url: string | null | undefined }
): Promise<{ id: string } | null> {
  const url = triggerUrlDedupeKey(args.url);
  if (!url) return null;
  try {
    const { data, error } = await supabase
      .from("ai_flow_runs")
      .select("id")
      .eq("business_id", args.businessId)
      .eq("flow_id", args.flowId)
      .in("status", [...ACTIVE_TRIGGER_URL_RUN_STATUSES])
      .eq("context->trigger->>url", url)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("findActiveRunWithTriggerUrl", error);
      return null;
    }
    const id = (data as { id?: unknown } | null)?.id;
    return typeof id === "string" && id.length > 0 ? { id } : null;
  } catch (e) {
    console.error("findActiveRunWithTriggerUrl", e);
    return null;
  }
}
