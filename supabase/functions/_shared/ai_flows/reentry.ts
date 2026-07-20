/**
 * Re-entry gate (GHL "allow re-entry").
 *
 * When a flow's `options.allowReentry` is EXPLICITLY false, a contact who
 * already has a run of that flow — any status, including finished ones — is
 * not enrolled again. Enforced best-effort at the lead-keyed enqueue sites
 * (inbound-SMS trigger eval, contact events, the Node enqueueAiFlowRun);
 * enqueues that carry no lead identity (webhook payloads before extraction,
 * schedule/manual starts) are governed by their own dedupe keys instead.
 *
 * Identity is CROSS-CHANNEL: the caller's key(s) — a phone, an email, or
 * both — are first expanded through the business's contact records (a phone
 * key pulls that contact's email and phone aliases, and vice versa), then a
 * prior run matches on ANY expanded key across the stored identity paths
 * (trigger sender, extracted lead phone/email, contact-event email, parked
 * wait/call numbers). So a lead who enrolled via tenant_email and later
 * texts in is still recognized as the same person, provided the contact
 * record links the two identities.
 *
 * Deliberate semantics:
 *   - test runs never count as an enrollment (excluded in the QUERY so they
 *     can never crowd real enrollments out of the scan slice; the test-run
 *     route also never calls this gate — testing must always work);
 *   - a lookup FAILURE fails OPEN (the run enqueues): a duplicate follow-up
 *     is recoverable, a silently dropped lead is not;
 *   - two perfectly concurrent enqueues may both pass (best-effort, same as
 *     drip pacing) — the flow's dedupe key still collapses true duplicates.
 */
import { isTestModeTrigger } from "./test_mode.ts";
import { isE164, normalizeNanpToE164 } from "./engine.ts";

// Minimal structural client (matches the _shared convention).
// deno-lint-ignore no-explicit-any
type AnyClient = any;

/** True when this definition opts out of re-entry (explicit false only). */
export function flowBlocksReentry(def: unknown): boolean {
  const options = (def as { options?: { allowReentry?: unknown } } | null | undefined)?.options;
  return options?.allowReentry === false;
}

/** Cap on the prior-run scan (test runs are excluded server-side). */
const PRIOR_RUN_SCAN = 10;
/** Cap on contact rows an identity expansion may pull keys from. */
const CONTACT_EXPANSION_ROWS = 3;
/** Cap on total identity keys after expansion (bounds the or-filter size). */
const MAX_IDENTITY_KEYS = 12;

/**
 * The run-context JSON paths one identity key is matched against. Phone keys
 * live in the phone paths and email keys in the email paths, but matching
 * every key against every path is harmless (a phone never equals an email)
 * and keeps this free of shape-guessing.
 */
const IDENTITY_PATHS = [
  "context->trigger->>from",
  "context->vars->>lead_phone",
  "context->vars->>lead_email",
  "context->trigger->>contact_email",
  "context->waiting_reply->>from",
  "context->waiting_call->>to"
] as const;

/** Trim, lowercase-dedupe-safe key list; drops empties and any value the
 * PostgREST or-filter grammar can't carry literally. */
function normalizeKeys(keys: string | Array<string | null | undefined>): string[] {
  const list = Array.isArray(keys) ? keys : [keys];
  const out: string[] = [];
  for (const raw of list) {
    const key = (raw ?? "").trim();
    if (!key || /[,()"\\]/.test(key) || out.includes(key)) continue;
    out.push(key);
  }
  return out;
}

/**
 * Expand the caller's key(s) through the business's contact records: any
 * contact whose primary phone, email, or phone alias matches a key donates
 * ALL its identities to the set. Best-effort — an expansion failure just
 * matches on the original keys.
 */
async function expandIdentityKeys(
  supabase: AnyClient,
  businessId: string,
  keys: string[]
): Promise<string[]> {
  try {
    const matchFilter = keys
      .flatMap((key) => [
        `customer_e164.eq.${key}`,
        `email.eq.${key}`,
        `alias_e164s.cs.{${key}}`
      ])
      .join(",");
    const { data, error } = await supabase
      .from("contacts")
      .select("customer_e164, email, alias_e164s")
      .eq("business_id", businessId)
      .or(matchFilter)
      .limit(CONTACT_EXPANSION_ROWS);
    if (error) {
      console.error("reentry: contact expansion", error);
      return keys;
    }
    const expanded = [...keys];
    for (const row of (data ?? []) as Array<{
      customer_e164?: string | null;
      email?: string | null;
      alias_e164s?: string[] | null;
    }>) {
      for (const extra of normalizeKeys([
        row.customer_e164,
        row.email,
        ...(Array.isArray(row.alias_e164s) ? row.alias_e164s : [])
      ])) {
        if (!expanded.includes(extra) && expanded.length < MAX_IDENTITY_KEYS) {
          expanded.push(extra);
        }
      }
    }
    return expanded;
  } catch (e) {
    console.error("expandIdentityKeys", e);
    return keys;
  }
}

/**
 * Does this person already have a (non-test) run of this flow, under ANY of
 * the given identity keys (contact-expanded)? Fails OPEN (false) on a
 * lookup error.
 */
export async function hasPriorRunForLead(
  supabase: AnyClient,
  businessId: string,
  flowId: string,
  leadKeys: string | Array<string | null | undefined>
): Promise<boolean> {
  const keys = normalizeKeys(leadKeys);
  if (keys.length === 0) return false;
  try {
    const allKeys = await expandIdentityKeys(supabase, businessId, keys);
    const identityFilter = allKeys
      .flatMap((key) => IDENTITY_PATHS.map((path) => `${path}.eq.${key}`))
      .join(",");
    const { data, error } = await supabase
      .from("ai_flow_runs")
      .select("id, context")
      .eq("flow_id", flowId)
      .or(identityFilter)
      // Chained .or groups AND together: (identity match) AND (not a test
      // run). Excluding tests server-side means a pile of test runs can
      // never push a real enrollment past the scan cap.
      .or("context->trigger->>test_mode.is.null,context->trigger->>test_mode.neq.true")
      .limit(PRIOR_RUN_SCAN);
    if (error) {
      console.error("reentry: prior-run lookup", error);
      return false;
    }
    const rows = (data ?? []) as Array<{ context?: Record<string, unknown> | null }>;
    // Defense in depth: the query already excluded test runs.
    return rows.some(
      (r) => !isTestModeTrigger(r.context?.trigger as Record<string, unknown> | undefined)
    );
  } catch (e) {
    console.error("hasPriorRunForLead", e);
    return false;
  }
}

/** True when this definition opts in to post-extraction lead dedupe. */
export function flowDedupesLeadRuns(def: unknown): boolean {
  const options = (def as { options?: { dedupeLeadRuns?: unknown } } | null | undefined)?.options;
  return options?.dedupeLeadRuns === true;
}

/** Case-insensitive, whitespace-collapsed form for address equality. */
function normalizeAddress(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().replace(/\s+/g, " ").toLowerCase() : "";
}

/**
 * Post-extraction lead dedupe (options.dedupeLeadRuns): does an EARLIER
 * non-failed, non-test run of this flow exist for the same person — and,
 * when both runs carry a property address, the same property?
 *
 * This is the gate the sender-keyed re-entry check cannot provide for
 * lead-source relay texts (realtor.com's "New inquiry"/"Repeat inquiry"
 * notifications arrive with an empty or shared sender): identity comes from
 * the run's OWN extracted vars instead. Person keys are the extracted
 * phone (raw + E.164-normalized) and email, contact-expanded like
 * hasPriorRunForLead. Failed/canceled prior runs never block (a repeat
 * inquiry is how a failed first run recovers), and a lookup failure fails
 * OPEN — a duplicate follow-up is recoverable, a dropped lead is not.
 */
export async function duplicateLeadRunExists(
  supabase: AnyClient,
  businessId: string,
  flowId: string,
  currentRunId: string,
  lead: { phone?: unknown; email?: unknown; address?: unknown }
): Promise<boolean> {
  const phoneRaw = typeof lead.phone === "string" ? lead.phone.trim() : "";
  const phoneE164 = phoneRaw
    ? isE164(phoneRaw)
      ? phoneRaw
      : normalizeNanpToE164(phoneRaw)
    : null;
  const email = typeof lead.email === "string" ? lead.email.trim() : "";
  const keys = normalizeKeys([phoneRaw, phoneE164, email]);
  if (keys.length === 0) return false;
  try {
    // Only runs created strictly BEFORE this one count — otherwise two
    // near-simultaneous runs for the same lead could each see the other and
    // BOTH cancel, dropping the lead. An exact created_at tie means neither
    // blocks (fail open, both proceed — the recoverable direction).
    const { data: selfRow, error: selfErr } = await supabase
      .from("ai_flow_runs")
      .select("created_at")
      .eq("id", currentRunId)
      .maybeSingle();
    const createdAt = (selfRow as { created_at?: string | null } | null)?.created_at;
    if (selfErr || !createdAt) {
      if (selfErr) console.error("reentry: duplicate-lead self lookup", selfErr);
      return false;
    }
    const allKeys = await expandIdentityKeys(supabase, businessId, keys);
    const identityFilter = allKeys
      .flatMap((key) => IDENTITY_PATHS.map((path) => `${path}.eq.${key}`))
      .join(",");
    const { data, error } = await supabase
      .from("ai_flow_runs")
      .select("id, status, context")
      .eq("flow_id", flowId)
      .neq("id", currentRunId)
      .lt("created_at", createdAt)
      .not("status", "in", "(failed,canceled)")
      .or(identityFilter)
      // Chained .or groups AND together (same trick as hasPriorRunForLead):
      // (identity match) AND (not a test run).
      .or("context->trigger->>test_mode.is.null,context->trigger->>test_mode.neq.true")
      .limit(PRIOR_RUN_SCAN);
    if (error) {
      console.error("reentry: duplicate-lead lookup", error);
      return false;
    }
    const currentAddress = normalizeAddress(lead.address);
    const rows = (data ?? []) as Array<{ context?: Record<string, unknown> | null }>;
    return rows.some((row) => {
      // Defense in depth: the query already excluded test runs.
      if (isTestModeTrigger(row.context?.trigger as Record<string, unknown> | undefined)) {
        return false;
      }
      if (!currentAddress) return true;
      const priorAddress = normalizeAddress(
        (row.context?.vars as Record<string, unknown> | undefined)?.lead_address
      );
      // A prior run with no address can't prove a different property —
      // the person match stands. Differing addresses = a NEW lead.
      return !priorAddress || priorAddress === currentAddress;
    });
  } catch (e) {
    console.error("duplicateLeadRunExists", e);
    return false;
  }
}

/**
 * The one call enqueue sites make: should this enqueue be SKIPPED because
 * the flow blocks re-entry and the person was already enrolled? Reads the
 * definition first so flows with re-entry allowed (the default) pay nothing
 * beyond the property check.
 */
export async function reentryBlocked(
  supabase: AnyClient,
  businessId: string,
  flowId: string,
  def: unknown,
  leadKeys: string | Array<string | null | undefined>
): Promise<boolean> {
  if (!flowBlocksReentry(def)) return false;
  return hasPriorRunForLead(supabase, businessId, flowId, leadKeys);
}
