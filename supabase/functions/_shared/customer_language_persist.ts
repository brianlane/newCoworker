/**
 * Detect-and-persist for a contact's `preferred_language`, shared by every
 * inbound SMS path.
 *
 * Why this module exists: the reply path used to own this logic inline, so it
 * only ran when the worker was actually generating an AI reply. Any turn an
 * AiFlow owned (`suppress_reply`: a parked `wait_for_reply` on a flow with
 * `options.suppressDefaultReply`, or a newly queued flow with that flag)
 * returned BEFORE it, which meant a lead who answered a flow's question in
 * Spanish was never recorded as a Spanish speaker. Every later message, flow
 * copy and AI reply alike, stayed English.
 * Lifting it here lets the suppressed branch record language too, with one
 * implementation so the two paths can never drift.
 *
 * Contract:
 *   - An owner override (`language_source = 'owner_set'`) is authoritative and
 *     is never overwritten by detection.
 *   - Only a CONFIDENT detection persists (`detected.persist`); a weak signal
 *     leaves the stored value alone.
 *   - Alias-aware: a number merged into another profile writes the surviving
 *     row's primary number, never the alias (which would match zero rows).
 *   - Update-then-insert: an SMS thread can exist before any contacts row, and
 *     a silent zero-row UPDATE would drop the detection.
 *   - Never throws. Language is an enhancement; a write hiccup must not break
 *     an inbound path.
 */

import {
  detectCustomerLanguage,
  type CustomerLanguage,
  type DetectCustomerLanguageResult
} from "./customer_language.ts";
import { contactAliasOrFilter, contactKeyEmail } from "./contact_key.ts";

// Minimal structural client (the _shared convention): only the query shapes
// this module uses, so both the edge runtime client and test fakes fit.
// deno-lint-ignore no-explicit-any
type AnyClient = any;

/** What the contacts row already says about this person's language. */
export type ContactLanguageState = {
  preferred: CustomerLanguage | null;
  source: string | null;
  /** The surviving profile's primary number (alias-aware), when a row exists. */
  primaryE164: string | null;
  exists: boolean;
};

const NO_STATE: ContactLanguageState = {
  preferred: null,
  source: null,
  primaryE164: null,
  exists: false
};

/**
 * Alias-aware contact match, mirroring every other contact lookup. Null for an
 * `email:` key, which is matched exactly instead (alias_e164s only ever holds
 * numbers). See supabase/functions/_shared/contact_key.ts.
 */
const contactMatchFilter = contactAliasOrFilter;

/** Read the stored language state. Any trouble answers "nothing stored". */
export async function readContactLanguageState(
  supabase: AnyClient,
  businessId: string,
  customerE164: string
): Promise<ContactLanguageState> {
  try {
    const base = supabase
      .from("contacts")
      .select("customer_e164, preferred_language, language_source")
      .eq("business_id", businessId);
    const filter = contactMatchFilter(customerE164);
    const { data } = await (filter
      ? base.or(filter)
      : base.eq("customer_e164", customerE164)
    ).maybeSingle();
    return contactLanguageStateFromRow(data);
  } catch (e) {
    console.error("readContactLanguageState", e);
    return NO_STATE;
  }
}

/**
 * Build the state from a contacts row a caller already fetched (the reply path
 * selects language alongside the customer-memory preamble, so it must not pay
 * for a second query). Null row means first contact.
 */
export function contactLanguageStateFromRow(row: unknown): ContactLanguageState {
  const r = row as
    | {
        customer_e164?: string | null;
        preferred_language?: CustomerLanguage | null;
        language_source?: string | null;
      }
    | null
    | undefined;
  if (!r) return NO_STATE;
  return {
    preferred: r.preferred_language ?? null,
    source: r.language_source ?? null,
    primaryE164: typeof r.customer_e164 === "string" ? r.customer_e164 : null,
    exists: true
  };
}

/**
 * Persist a detected language (never over an owner override). Best-effort:
 * logs and returns on any failure.
 */
export async function persistDetectedContactLanguage(
  supabase: AnyClient,
  businessId: string,
  customerE164: string,
  language: CustomerLanguage,
  state: ContactLanguageState
): Promise<void> {
  if (state.source === "owner_set") return;
  const patch = { preferred_language: language, language_source: "detected" };
  try {
    if (state.exists) {
      await supabase
        .from("contacts")
        .update(patch)
        .eq("business_id", businessId)
        .eq("customer_e164", state.primaryE164 ?? customerE164);
      return;
    }
    // First contact: the contacts row is created later in the job, so an
    // UPDATE would hit zero rows and the detection would be lost. Insert now;
    // on a concurrent-create race fall back to the update.
    // An email-keyed row must carry its address in `email` too, or the DB
    // constraint contacts_email_key_matches_email rejects the insert and a
    // detected language is silently lost on first contact.
    const keyEmail = contactKeyEmail(customerE164);
    const { error: insErr } = await supabase.from("contacts").insert({
      business_id: businessId,
      customer_e164: customerE164,
      ...(keyEmail ? { email: keyEmail } : {}),
      ...patch
    });
    if (insErr) {
      await supabase
        .from("contacts")
        .update(patch)
        .eq("business_id", businessId)
        .eq("customer_e164", customerE164);
    }
  } catch (e) {
    console.error("persistDetectedContactLanguage", e);
  }
}

/**
 * The thread language a prompt should follow: an owner override wins, then a
 * confident detection (mid-thread switch), then the stored value. Mirrors the
 * Messenger engine's precedence.
 */
export function resolveThreadLanguage(
  state: ContactLanguageState,
  detected: DetectCustomerLanguageResult
): CustomerLanguage | null {
  if (state.source === "owner_set") return state.preferred;
  if (detected.persist) return detected.language;
  return state.preferred ?? detected.language;
}

export type DetectAndPersistResult = {
  detected: DetectCustomerLanguageResult;
  threadLanguage: CustomerLanguage | null;
  state: ContactLanguageState;
};

/**
 * One inbound message's language decision: detect against the stored state,
 * persist when confident, and return the language a prompt should follow.
 * `state` is optional so a caller holding a contacts row skips the extra read.
 */
export async function detectAndPersistCustomerLanguage(args: {
  supabase: AnyClient;
  businessId: string;
  customerE164: string;
  text: string;
  defaultLanguage: CustomerLanguage;
  supported: CustomerLanguage[];
  state?: ContactLanguageState;
}): Promise<DetectAndPersistResult> {
  const state =
    args.state ??
    (await readContactLanguageState(args.supabase, args.businessId, args.customerE164));
  const detected = detectCustomerLanguage({
    text: args.text,
    establishedLanguage: state.preferred ?? undefined,
    defaultLanguage: args.defaultLanguage,
    supported: args.supported
  });
  if (detected.persist) {
    await persistDetectedContactLanguage(
      args.supabase,
      args.businessId,
      args.customerE164,
      detected.language,
      state
    );
  }
  return { detected, threadLanguage: resolveThreadLanguage(state, detected), state };
}
