/**
 * Claimable unowned-lead alerts.
 *
 * The claim machinery understands exactly one thing: a parked `route_to_team`
 * run. A teammate who replied "1" to an unowned-lead ALERT had it resolve
 * against an unrelated older offer instead (Amy Laidlaw, 2026-08-15), because
 * the alert she was answering had no run for the digit to attach to. She was
 * not confused: every other team text on that account ends in "Reply 1 to
 * claim", so "1" is muscle memory.
 *
 * The AiFlow no-phone guards became real offers (PR #1399). The urgent-alert
 * dispatcher's `notify_team` alerts cannot: they are sent from the SMS worker,
 * outside any flow run, so there is nothing to park. This is the record those
 * alerts attach to instead.
 *
 * Shared by the Node dispatcher (writer) and the Deno SMS-inbound function
 * (reader and claimer), so the two cannot disagree about what "live" means.
 */

import { e164CollapseKey, e164LookupValues } from "./normalize_e164.ts";

// Minimal structural client (the _shared convention).
// deno-lint-ignore no-explicit-any
type AnyClient = any;

/** How long a bare "1" can still claim an alert. */
export const ALERT_CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;

export type UnownedLeadAlertRow = {
  id: string;
  lead_e164: string;
  lead_label: string | null;
  recipients: string[] | null;
  claimed_at: string | null;
  expires_at: string;
};

/** A live alert this sender could have meant. */
export type UnownedAlertCandidate = {
  alertId: string;
  leadE164: string;
  leadLabel: string | null;
};

/**
 * Record that a team was alerted about an unowned lead, so a reply can claim
 * it. Never throws: the alert itself already went out, and losing the ability
 * to claim by text is strictly better than failing the send.
 *
 * Returns the row id, or null when nothing was written.
 */
export async function recordUnownedLeadAlert(
  supabase: AnyClient,
  args: {
    businessId: string;
    leadE164: string | null | undefined;
    leadLabel?: string | null;
    recipients: readonly string[];
    nowMs: number;
    windowMs?: number;
  }
): Promise<string | null> {
  const lead = (args.leadE164 ?? "").trim();
  const recipients = args.recipients.map((r) => r.trim()).filter((r) => r.length > 0);
  // No lead to claim, or nobody who could claim it: nothing to record. Both
  // are normal (a business-level alert names no contact).
  if (!lead || recipients.length === 0) return null;
  try {
    const expiresAt = new Date(args.nowMs + (args.windowMs ?? ALERT_CLAIM_WINDOW_MS));
    const { data, error } = await supabase
      .from("unowned_lead_alerts")
      .insert({
        business_id: args.businessId,
        lead_e164: lead,
        lead_label: (args.leadLabel ?? "").trim() || null,
        recipients,
        expires_at: expiresAt.toISOString()
      })
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("recordUnownedLeadAlert", error);
      return null;
    }
    return (data as { id?: string } | null)?.id ?? null;
  } catch (e) {
    console.error("recordUnownedLeadAlert threw", e);
    return null;
  }
}

/**
 * Every live alert this sender could be answering, newest first.
 *
 * "Live" is unclaimed AND unexpired AND addressed to them. Bounded for the
 * same reason the offer candidates are: the ask-back text has to stay inside
 * a readable SMS.
 */
export const MAX_ALERT_CANDIDATES = 10;

export async function findLiveUnownedAlertsFor(
  supabase: AnyClient,
  businessId: string,
  from: string,
  nowIso: string
): Promise<UnownedAlertCandidate[]> {
  try {
    const { data, error } = await supabase
      .from("unowned_lead_alerts")
      .select("id, lead_e164, lead_label, recipients, claimed_at, expires_at")
      .eq("business_id", businessId)
      .is("claimed_at", null)
      .gt("expires_at", nowIso)
      .contains("recipients", [from])
      .order("created_at", { ascending: false })
      .limit(MAX_ALERT_CANDIDATES);
    if (error) {
      console.error("findLiveUnownedAlertsFor", error);
      return [];
    }
    const mapped = ((data ?? []) as UnownedLeadAlertRow[]).map((r) => ({
      alertId: r.id,
      leadE164: r.lead_e164,
      leadLabel: (r.lead_label ?? "").trim() || null
    }));
    // Newest-first already. Two live rows for one phone are one lead: each
    // follow-up ping inserts another 24h alert, and listing both makes a
    // bare "1" ask "Christopher or Christopher" (Amy Laidlaw, 2026-09-02).
    const seen = new Set<string>();
    const unique: UnownedAlertCandidate[] = [];
    for (const c of mapped) {
      const key = e164CollapseKey(c.leadE164) || c.leadE164;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(c);
    }
    return unique;
  } catch (e) {
    console.error("findLiveUnownedAlertsFor threw", e);
    return [];
  }
}

/** What a claim attempt produced. */
export type AlertClaimOutcome =
  | { ok: true; leadE164: string; leadLabel: string | null }
  /** Somebody else got there first; `by` is their number when known. */
  | { ok: false; reason: "already_claimed"; by: string | null }
  | { ok: false; reason: "gone" };

/**
 * Claim an alert for this teammate.
 *
 * A compare-and-swap on `claimed_at is null`, so two teammates racing cannot
 * both win: PostgREST reports the update as matching zero rows for the loser,
 * which is why the result is read back with `.select()` rather than trusting
 * the absence of an error.
 */
export async function claimUnownedLeadAlert(
  supabase: AnyClient,
  args: {
    businessId: string;
    alertId: string;
    memberId: string | null;
    claimedByE164: string;
    nowIso: string;
  }
): Promise<AlertClaimOutcome> {
  const { data, error } = await supabase
    .from("unowned_lead_alerts")
    .update({
      claimed_at: args.nowIso,
      claimed_by_e164: args.claimedByE164,
      claimed_by_member_id: args.memberId
    })
    .eq("id", args.alertId)
    .eq("business_id", args.businessId)
    .is("claimed_at", null)
    .select("lead_e164, lead_label");
  if (error) {
    console.error("claimUnownedLeadAlert", error);
    return { ok: false, reason: "gone" };
  }
  const rows = (data ?? []) as Array<{ lead_e164: string; lead_label: string | null }>;
  if (rows.length === 1) {
    return {
      ok: true,
      leadE164: rows[0].lead_e164,
      leadLabel: (rows[0].lead_label ?? "").trim() || null
    };
  }
  // Zero rows: either somebody claimed it in between, or it expired/vanished.
  // Re-read to tell the teammate which, because "Dave already took it" and
  // "that one is too old to claim" call for different next steps.
  const { data: after } = await supabase
    .from("unowned_lead_alerts")
    .select("claimed_by_e164, claimed_at")
    .eq("id", args.alertId)
    .eq("business_id", args.businessId)
    .maybeSingle();
  const row = (after as { claimed_by_e164?: string | null; claimed_at?: string | null } | null) ?? null;
  if (row?.claimed_at) {
    return { ok: false, reason: "already_claimed", by: row.claimed_by_e164 ?? null };
  }
  return { ok: false, reason: "gone" };
}

/**
 * Retire every live unclaimed alert about this lead. Alert claims already
 * did this for sibling rows. Offer claims that won a collapsed same-phone
 * race must too, or a leftover alert stays claimable and a second teammate
 * is told the lead is theirs.
 *
 * Never throws: the claim already landed, and a leftover alert is worse
 * than failing this cleanup.
 */
export async function retireLiveUnownedAlertsForLead(
  supabase: AnyClient,
  args: {
    businessId: string;
    leadE164: string;
    claimedByE164: string;
    memberId: string | null;
    nowIso: string;
  }
): Promise<void> {
  const phones = e164LookupValues(args.leadE164);
  if (phones.length === 0) return;
  try {
    const { error } = await supabase
      .from("unowned_lead_alerts")
      .update({
        claimed_at: args.nowIso,
        claimed_by_e164: args.claimedByE164,
        claimed_by_member_id: args.memberId
      })
      .eq("business_id", args.businessId)
      .in("lead_e164", phones)
      .is("claimed_at", null);
    if (error) console.error("retireLiveUnownedAlertsForLead", error);
  } catch (e) {
    console.error("retireLiveUnownedAlertsForLead threw", e);
  }
}
