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
 * send must be REFUSED (never "couldn't check, send anyway") — an SMS to an
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
 * Owner-initiated proactive suppression ("never text this number"). Wraps
 * the same RPC the STOP keyword handler uses, so every enforcement site
 * (Edge and Node) picks it up identically. Returns whether the row was new.
 */
export async function setSmsOptOut(
  businessId: string,
  e164: string,
  client?: SupabaseClient
): Promise<{ isNew: boolean }> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.rpc("sms_set_opt_out", {
    p_business_id: businessId,
    p_sender_e164: e164
  });
  if (error) throw new Error(`setSmsOptOut: ${error.message}`);
  const result = data as { ok?: boolean; reason?: string; new?: boolean } | null;
  if (!result?.ok) {
    throw new Error(`setSmsOptOut: ${result?.reason ?? "rpc_failed"}`);
  }
  return { isNew: result.new === true };
}
