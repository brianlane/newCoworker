/**
 * "Customer Called" pause (Lead Management PRD Ch4 / Ch9 Scenario 3).
 *
 * A lead who receives our text and PHONES the business instead must not keep
 * getting automated follow-ups mid-call. When telnyx-voice-inbound sees an
 * inbound call whose caller has ACTIVE AiFlow automation for that business,
 * this module:
 *
 *   1. resolves parked `awaiting_reply` runs with the `customer_called`
 *      sentinel in the step's saveAs var (same mechanism as the `no_reply`
 *      timeout sentinel, so flows branch on it with a when/branch condition);
 *   2. defers that lead's QUEUED runs (e.g. a follow-up sleeping between
 *      nudges) via earliest_claim_at, so nothing texts them while they talk;
 *   3. tags the contact "Customer Called" for the dashboard CRM view.
 *
 * Everything is best-effort: a failure here must NEVER delay or break call
 * routing — the phone call is the customer's chosen channel and always wins.
 */

/** Sentinel written into a wait_for_reply saveAs var when the lead phoned in. */
export const CUSTOMER_CALLED_SENTINEL = "customer_called";

/** Tag stamped on the contact so staff see the channel switch at a glance. */
export const CUSTOMER_CALLED_TAG = "Customer Called";

/** How long the lead's queued automation holds off after they call (2h). */
export const CUSTOMER_CALLED_DEFER_MINUTES = 120;

/** Max contact tags — mirrors contacts_tags_cap_chk / normalizeContactTags. */
const MAX_CONTACT_TAGS = 25;

// Minimal structural client (matches the _shared convention): only the query
// shapes this module uses, so both the edge runtime client and test fakes fit.
// deno-lint-ignore no-explicit-any
type AnyClient = any;

export type CustomerCalledResult = {
  /** Parked wait_for_reply runs resumed with the customer_called sentinel. */
  resumedWaits: number;
  /** Queued runs whose earliest_claim_at was pushed out. */
  deferredRuns: number;
  /** Whether the contact row was tagged (false when unmatched/already tagged). */
  tagged: boolean;
};

const NOOP: CustomerCalledResult = { resumedWaits: 0, deferredRuns: 0, tagged: false };

/**
 * Pause a calling lead's SMS automation. Returns what changed so the caller
 * can decide whether to notify the owner. Never throws.
 */
export async function pauseLeadAutomationOnCall(
  supabase: AnyClient,
  businessId: string,
  callerE164: string,
  nowMs: number = Date.now()
): Promise<CustomerCalledResult> {
  if (!callerE164) return NOOP;
  try {
    const resumedWaits = await resumeWaitsWithSentinel(supabase, businessId, callerE164);
    const deferredRuns = await deferQueuedRuns(supabase, businessId, callerE164, nowMs);
    // Only tag when the call actually intersected live automation — a random
    // caller with no runs is not a "Customer Called" lead-state transition.
    let tagged = false;
    if (resumedWaits > 0 || deferredRuns > 0) {
      tagged = await tagContactCustomerCalled(supabase, businessId, callerE164);
    }
    return { resumedWaits, deferredRuns, tagged };
  } catch (e) {
    console.error("pauseLeadAutomationOnCall", e);
    return NOOP;
  }
}

/**
 * Resolve every parked wait_for_reply run watching this caller with the
 * customer_called sentinel (revision-gated like the SMS-reply resume in
 * telnyx-sms-inbound; losing a race means that run already resolved).
 */
async function resumeWaitsWithSentinel(
  supabase: AnyClient,
  businessId: string,
  from: string
): Promise<number> {
  const { data, error } = await supabase
    .from("ai_flow_runs")
    .select("id, context, revision")
    .eq("business_id", businessId)
    .eq("status", "awaiting_reply")
    .eq("context->waiting_reply->>from", from)
    .limit(10);
  if (error) {
    console.error("customer_called: awaiting_reply lookup", error);
    return 0;
  }
  const rows = (data ?? []) as Array<{
    id: string;
    context: Record<string, unknown> | null;
    revision: number;
  }>;
  let resumed = 0;
  for (const run of rows) {
    const waiting =
      (run.context?.waiting_reply as { save_as?: unknown; marker?: unknown } | undefined) ?? {};
    const saveAs =
      typeof waiting.save_as === "string" && waiting.save_as.trim()
        ? waiting.save_as
        : "reply_text";
    const prevVars =
      run.context?.vars && typeof run.context.vars === "object"
        ? (run.context.vars as Record<string, unknown>)
        : {};
    const markerVars =
      typeof waiting.marker === "string" && waiting.marker.trim()
        ? { [waiting.marker]: "1" }
        : {};
    const nextContext = {
      ...(run.context ?? {}),
      vars: { ...prevVars, [saveAs]: CUSTOMER_CALLED_SENTINEL, ...markerVars },
      waiting_reply: {
        ...(run.context?.waiting_reply as Record<string, unknown>),
        result: CUSTOMER_CALLED_SENTINEL
      }
    };
    const { data: updated, error: updErr } = await supabase
      .from("ai_flow_runs")
      .update({
        status: "queued",
        respond_by_at: null,
        claimed_at: null,
        context: nextContext,
        updated_at: new Date().toISOString()
      })
      .eq("id", run.id)
      .eq("revision", run.revision)
      .eq("status", "awaiting_reply")
      .select("id");
    if (updErr) {
      console.error("customer_called: wait resume", updErr);
      continue;
    }
    if ((updated ?? []).length > 0) resumed += 1;
  }
  return resumed;
}

/**
 * Push out this lead's QUEUED runs (identified by the triggering sender or
 * the extracted lead phone) so sleeping follow-ups don't fire mid-call. Only
 * runs that would wake sooner than the defer window are touched.
 */
async function deferQueuedRuns(
  supabase: AnyClient,
  businessId: string,
  caller: string,
  nowMs: number
): Promise<number> {
  const resumeIso = new Date(nowMs + CUSTOMER_CALLED_DEFER_MINUTES * 60_000).toISOString();
  const { data, error } = await supabase
    .from("ai_flow_runs")
    .update({ earliest_claim_at: resumeIso, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("status", "queued")
    .or(`context->trigger->>from.eq.${caller},context->vars->>lead_phone.eq.${caller}`)
    .or(`earliest_claim_at.is.null,earliest_claim_at.lt.${resumeIso}`)
    .select("id");
  if (error) {
    console.error("customer_called: queued defer", error);
    return 0;
  }
  return (data ?? []).length;
}

/** Append the "Customer Called" tag to the caller's contact (alias-aware). */
async function tagContactCustomerCalled(
  supabase: AnyClient,
  businessId: string,
  caller: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("contacts")
    .select("id, tags")
    .eq("business_id", businessId)
    .or(`customer_e164.eq.${caller},alias_e164s.cs.{${caller}}`)
    .maybeSingle();
  if (error) {
    console.error("customer_called: contact lookup", error);
    return false;
  }
  const contact = data as { id: string; tags?: string[] | null } | null;
  if (!contact) return false;
  const tags = Array.isArray(contact.tags) ? contact.tags : [];
  const already = tags.some((t) => t.toLowerCase() === CUSTOMER_CALLED_TAG.toLowerCase());
  if (already || tags.length >= MAX_CONTACT_TAGS) return false;
  const { error: updErr } = await supabase
    .from("contacts")
    .update({ tags: [...tags, CUSTOMER_CALLED_TAG], updated_at: new Date().toISOString() })
    .eq("id", contact.id);
  if (updErr) {
    console.error("customer_called: contact tag", updErr);
    return false;
  }
  return true;
}
