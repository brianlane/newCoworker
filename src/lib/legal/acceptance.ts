/**
 * Clickwrap acceptance ledger (terms_acceptances): recording and reading
 * the explicit "I agree" clicks for the public legal documents.
 *
 * Two writers:
 *   * source 'signup': the account-creation forms (set-password route with
 *     the user id; the standalone /signup form pre-session, email-keyed).
 *   * source 'gate': the dashboard re-acceptance gate.
 *
 * There is deliberately no operator/admin writer. Admin view-as can perform
 * every other tenant action, but a row here evidences that a SPECIFIC PERSON
 * agreed, and nobody can agree on someone else's behalf. `/api/legal/accept`
 * refuses an impersonating admin, and the dashboard layout does not raise the
 * gate under view-as, so the refusal never strands anyone. A short-lived
 * `admin_view_as` source existed on 2026-08-17 (PR #1420) and was removed the
 * same day with zero rows written; do not reintroduce it.
 *
 * One reader: the dashboard layout asks for the user's newest row and
 * compares its pinned versions against src/lib/legal/versions.ts. No row,
 * or an older version, raises the gate.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { PRIVACY_EFFECTIVE_DATE, TERMS_EFFECTIVE_DATE } from "@/lib/legal/versions";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type AcceptanceSource = "signup" | "gate";

export type AcceptanceInput = {
  userId?: string | null;
  email?: string | null;
  businessId?: string | null;
  source: AcceptanceSource;
  ip?: string | null;
  userAgent?: string | null;
};

export type LatestAcceptance = {
  terms_version: string;
  privacy_version: string;
  accepted_at: string;
} | null;

/** Same evidence-field caps as document_signature_requests. */
const IP_MAX = 64;
const UA_MAX = 400;

/** Insert one acceptance row pinned to the CURRENT legal versions. */
export async function recordAcceptance(
  input: AcceptanceInput,
  client?: SupabaseClient
): Promise<void> {
  if (!input.userId && !input.email) {
    throw new Error("recordAcceptance: a userId or email is required");
  }
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("terms_acceptances").insert({
    user_id: input.userId ?? null,
    email: input.email ? input.email.trim().toLowerCase() : null,
    business_id: input.businessId ?? null,
    terms_version: TERMS_EFFECTIVE_DATE,
    privacy_version: PRIVACY_EFFECTIVE_DATE,
    source: input.source,
    ip: input.ip ? input.ip.slice(0, IP_MAX) : null,
    user_agent: input.userAgent ? input.userAgent.slice(0, UA_MAX) : null
  });
  if (error) throw new Error(`recordAcceptance: ${error.message}`);
}

/**
 * The user's newest acceptance row, or null when none exists. Fails OPEN
 * on a read error (returns a row pinning the current versions): blocking
 * every dashboard render behind a transient DB hiccup would hurt more than
 * one gate-less render, and the next navigation retries. The error is
 * logged loudly so a persistent failure is visible.
 */
export async function latestAcceptanceFor(
  userId: string,
  client?: SupabaseClient
): Promise<LatestAcceptance> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("terms_acceptances")
    .select("terms_version, privacy_version, accepted_at")
    .eq("user_id", userId)
    .order("accepted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.error("latestAcceptanceFor: read failed (gate fails open this render)", {
      userId,
      error: error.message
    });
    return {
      terms_version: TERMS_EFFECTIVE_DATE,
      privacy_version: PRIVACY_EFFECTIVE_DATE,
      accepted_at: ""
    };
  }
  return (data as LatestAcceptance) ?? null;
}

/** True when the gate must render: no row, or a version has moved on. */
export function needsAcceptance(latest: LatestAcceptance): boolean {
  if (!latest) return true;
  return (
    latest.terms_version !== TERMS_EFFECTIVE_DATE ||
    latest.privacy_version !== PRIVACY_EFFECTIVE_DATE
  );
}
