/**
 * SMS opt-out (STOP-list) access for the Node side of the platform.
 *
 * The source of truth is the `sms_opt_outs` table + its service-role RPCs
 * (`sms_set_opt_out` / `sms_is_opted_out`), written by the Telnyx STOP/START
 * keyword handlers and already enforced on every Edge send path
 * (sms-inbound-worker, ai-flow-worker, scheduled sends, missed-call
 * autotext). This module gives the dashboard/API side the same primitives:
 *   - owner-facing visibility (list the suppressed numbers),
 *   - manual proactive suppression (owner adds a number),
 *   - enforcement on the Node send sites (dashboard manual reply, the
 *     agent's send_follow_up_sms tool, Rowboat tool-call sends).
 *
 * There is deliberately NO owner-facing opt-back-in: a customer's STOP holds
 * until THEY text START (compliance requirement), so clearing stays with the
 * keyword handler / service-role tooling only.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type SmsOptOutRow = {
  business_id: string;
  sender_e164: string;
  kind: string;
  set_at: string;
  updated_at: string;
};

export async function listSmsOptOuts(
  businessId: string,
  client?: SupabaseClient
): Promise<SmsOptOutRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("sms_opt_outs")
    .select()
    .eq("business_id", businessId)
    .order("set_at", { ascending: false });
  if (error) throw new Error(`listSmsOptOuts: ${error.message}`);
  return (data ?? []) as SmsOptOutRow[];
}

export type SmsOptOutCheck =
  | { ok: true; optedOut: boolean }
  | { ok: false; error: string };

/**
 * Consent check for a send site. Returns a typed result instead of throwing
 * so callers make the fail-closed decision explicitly: on a read error the
 * send must be REFUSED (never "couldn't check, send anyway"), an SMS to an
 * opted-out number is a compliance violation, a delayed SMS is not.
 */
export async function checkSmsOptOut(
  businessId: string,
  e164: string,
  client?: SupabaseClient
): Promise<SmsOptOutCheck> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.rpc("sms_is_opted_out", {
    p_business_id: businessId,
    p_sender_e164: e164
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, optedOut: data === true };
}

/**
 * Provenance kinds for a suppression row (migration 20260724204311):
 *  - "stop", the customer texted STOP themselves. Sacred: only the
 *                   START keyword handler may lift it.
 *  - "owner_spam", the owner flagged the contact as spam
 *                   (flag_contact_spam). Same send-blocking effect
 *                   everywhere; reversible by service-role tooling. The RPC
 *                   never downgrades an existing "stop" row to this kind.
 */
export type SmsOptOutKind = "stop" | "owner_spam";

/**
 * The suppression row's KIND for a number, or null when not suppressed.
 * For consumers where provenance changes the decision: the public booking
 * page refuses owner_spam numbers (a spam declaration must never start
 * more automation) but still books "stop" numbers, whose opt-out covers
 * TEXTS, not appointments they choose to make themselves. Returns null on
 * a read error too, with a warn: unlike SMS consent (fail-closed), a
 * missed spam gate books an appointment, not a compliance violation.
 */
export async function getSmsOptOutKind(
  businessId: string,
  e164: string,
  client?: SupabaseClient
): Promise<SmsOptOutKind | null> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { data, error } = await db
      .from("sms_opt_outs")
      .select("kind")
      .eq("business_id", businessId)
      .eq("sender_e164", e164)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const kind = (data as { kind?: string } | null)?.kind;
    return kind === "stop" || kind === "owner_spam" ? kind : null;
  } catch (err) {
    const { logger } = await import("@/lib/logger");
    logger.warn("getSmsOptOutKind failed (treated as not suppressed)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/**
 * Owner-initiated proactive suppression ("never text this number"). Wraps
 * the same RPC the STOP keyword handler uses, so every enforcement site
 * (Edge and Node) picks it up identically. Returns whether the row was new.
 */
export async function setSmsOptOut(
  businessId: string,
  e164: string,
  client?: SupabaseClient,
  kind: SmsOptOutKind = "stop"
): Promise<{ isNew: boolean }> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.rpc("sms_set_opt_out", {
    p_business_id: businessId,
    p_sender_e164: e164,
    p_kind: kind
  });
  if (error) throw new Error(`setSmsOptOut: ${error.message}`);
  const result = data as { ok?: boolean; reason?: string; new?: boolean } | null;
  if (!result?.ok) {
    throw new Error(`setSmsOptOut: ${result?.reason ?? "rpc_failed"}`);
  }
  return { isNew: result.new === true };
}
