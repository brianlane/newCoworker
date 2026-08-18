/**
 * HIPAA audit controls, 45 CFR 164.312(b).
 *
 * The Security Rule wants a record of activity in systems that hold ePHI, and
 * the question an auditor (or a patient exercising their accounting-of-
 * disclosures right) actually asks is "who looked at this record". We already
 * log admin ACTIONS via src/lib/admin/audit.ts; nothing logged READS.
 *
 * SCOPE: human dashboard reads, deliberately not every read in the system.
 * The AI reads contact context on essentially every inbound message, and
 * logging that would bury the signal an auditor needs under machine traffic
 * that is already evidenced by the message it produced. The trail exists to
 * answer "which member of the workforce opened this patient's chart", so it
 * records reads that happen in the context of an authenticated dashboard
 * session. If the scope ever widens, widen it deliberately rather than by
 * instrumenting a shared db helper.
 *
 * Recording is BEST EFFORT and must never break a page render: an audit-log
 * write that throws would take down the very screen it is documenting. It
 * fails loudly into the application log instead.
 *
 * Gated on the tenant, not on the reader: a non-HIPAA tenant records nothing,
 * so this costs the other 9 tenants exactly one boolean check.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { headers } from "next/headers";

/**
 * Logical surfaces, not table names, so the trail stays readable across
 * schema churn.
 */
export const PHI_RESOURCES = [
  "contact",
  "sms_thread",
  "voice_transcript",
  "email_thread"
] as const;
export type PhiResource = (typeof PHI_RESOURCES)[number];

export type PhiAccessAction = "view" | "list" | "export";

export type PhiAccessEntry = {
  businessId: string;
  /** The acting workforce member, from getAuthUser(). */
  userId?: string | null;
  userEmail?: string | null;
  resource: PhiResource;
  /** The record viewed (E.164, call id, address). Null for a list view. */
  resourceId?: string | null;
  action?: PhiAccessAction;
  ip?: string | null;
  userAgent?: string | null;
};

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * Record one access. No-op unless `hipaaMode` is true.
 *
 * Note the fail direction is the OPPOSITE of the notification redaction's:
 * there, an unknown tenant redacts, because sending PHI is irreversible.
 * Here, an unknown tenant records nothing, because writing an audit row for a
 * non-HIPAA tenant is not a safety property, and the caller already has the
 * business row in hand on every real call site. Over-logging would put the
 * other tenants' customer identifiers into a table built for a legal duty
 * they are not under.
 */
export async function recordPhiAccess(
  hipaaMode: boolean | null | undefined,
  entry: PhiAccessEntry,
  client?: SupabaseClient
): Promise<void> {
  if (hipaaMode !== true) return;
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { error } = await db.from("phi_access_log").insert({
      business_id: entry.businessId,
      user_id: entry.userId ?? null,
      user_email: entry.userEmail ?? null,
      action: entry.action ?? "view",
      resource: entry.resource,
      resource_id: entry.resourceId ?? null,
      ip: entry.ip ?? null,
      user_agent: entry.userAgent ?? null
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    // Loud, because a HIPAA tenant with a silently broken audit trail is a
    // compliance failure that looks like nothing at all.
    logger.error("phi-access-log: FAILED to record an access", {
      businessId: entry.businessId,
      resource: entry.resource,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Caller IP and user agent for a server component, mirroring the header
 * precedence in rateLimitIdentifierFromRequest (which needs a Request object
 * this context does not have).
 *
 * `headers()` throws outside a request scope, so this degrades to nulls
 * rather than taking down the page: an audit row missing its IP is far better
 * than no page and no row.
 */
export async function phiAccessRequestContext(): Promise<{
  ip: string | null;
  userAgent: string | null;
}> {
  try {
    const h = await headers();
    const forwardedFor = h.get("x-forwarded-for");
    const ip =
      forwardedFor?.split(",")[0]?.trim() ||
      h.get("x-real-ip")?.trim() ||
      h.get("cf-connecting-ip")?.trim() ||
      null;
    return { ip: ip || null, userAgent: h.get("user-agent")?.trim() || null };
  } catch {
    return { ip: null, userAgent: null };
  }
}
