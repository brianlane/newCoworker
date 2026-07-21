/**
 * "Needs human intervention" escalation — the promised behavior when the
 * AI runs into something it can't handle:
 *
 *   the conversation flips into a needs-human state, the owner is notified,
 *   the owner steps in (dashboard Messages reply, or per-contact
 *   forward_owner relay), and the resolution feeds the contact's rolling
 *   memory so the next conversation starts smarter.
 *
 * The trigger is the reply-reasoning trailer's `handoff` flag: the model
 * marks the turns where a human must take over (asked for a person,
 * question outside its knowledge, something it couldn't do). The
 * sms-inbound-worker calls `escalateToHuman` on those turns, which:
 *
 *   1. tags the contact "Needs Human" (visible on the contact page and the
 *      Task Center; owners clear it when the thread is handled). The tag
 *      doubles as the open/closed state: an already-tagged contact is an
 *      OPEN escalation, so repeat turns don't re-notify;
 *   2. fires the same tag_changed contact-event + tag_added goal-event
 *      hooks as every other tag write path, so flows can react ("when the
 *      assistant escalates, route the lead to the team");
 *   3. notifies the owner through the notifications Edge function (SMS /
 *      email / dashboard per their preferences) using the same direct-POST
 *      contract as _shared/cap_alerts.ts.
 *
 * Best-effort throughout: an escalation failure must never break the reply
 * turn that discovered it. Dependency-injected (client + fetch) so this is
 * unit-tested under the shared 100% coverage gate.
 */
import { applyGoalEvent } from "./ai_flows/goal_events.ts";
import { enqueueContactEventRuns } from "./ai_flows/contact_events.ts";

/** The lead-state tag that marks an OPEN "needs a human" conversation. */
export const NEEDS_HUMAN_TAG = "Needs Human";

/** coworker_logs-shaped task_type routed through the notifications function. */
export const NEEDS_HUMAN_TASK_TYPE = "sms_needs_human";

/** Same cap as every other tag write path (DB check constraint). */
const MAX_TAGS = 25;

/** Bounded transient retry for the notify POST (429/5xx/thrown fetch). */
const NOTIFY_MAX_ATTEMPTS = 3;

export function hasNeedsHumanTag(tags: unknown): boolean {
  if (!Array.isArray(tags)) return false;
  return tags.some(
    (t) => typeof t === "string" && t.trim().toLowerCase() === NEEDS_HUMAN_TAG.toLowerCase()
  );
}

// Minimal structural client (the _shared convention).
// deno-lint-ignore no-explicit-any
type AnyClient = any;

export type EscalationInput = {
  businessId: string;
  /** The texter's number (the inbound `from`). */
  contactE164: string;
  /** Why the model handed off — the reasoning trailer's rationale. */
  reason: string;
  /** The texter's goal (reasoning trailer intent, snake_case). */
  intent: string;
  /** The inbound message that triggered the turn (clipped by the caller). */
  inboundPreview: string;
  /** `${SUPABASE_URL}/functions/v1/notifications` */
  notifyUrl: string;
  /** Service-role key or NOTIFICATIONS_WEBHOOK_TOKEN. */
  bearer: string;
  fetchFn?: typeof fetch;
};

export type EscalationResult =
  | "escalated"
  | "already_open"
  | "notify_failed"
  /**
   * Team-first handoff (businesses.needs_human_team_first): the tag + hooks
   * enqueued a team-offer flow run, which now OWNS notification — the
   * broadcast offer goes to the roster and the owner is paged only by the
   * flow's timeout fallback. No direct page was sent.
   */
  | "team_offered";

/**
 * businesses.needs_human_team_first, read fail-safe: any error (or a missing
 * row) counts as OFF so the escalation degrades to the page-the-owner path —
 * a toggle-read hiccup must never silence an alert.
 */
async function teamFirstEnabled(supabase: AnyClient, businessId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("businesses")
      .select("needs_human_team_first")
      .eq("id", businessId)
      .maybeSingle();
    if (error) {
      console.error("needs_human: team-first toggle read", error);
      return false;
    }
    return (data as { needs_human_team_first?: boolean } | null)?.needs_human_team_first === true;
  } catch (e) {
    console.error("needs_human: team-first toggle read", e);
    return false;
  }
}

/**
 * Fallback re-page window for escalations that cannot carry the tag (no
 * contact row, or a row already at the 25-tag cap): a notifications-history
 * row for this contact younger than this counts as "the owner was already
 * paged", so repeat turns don't page again every message.
 */
export const NEEDS_HUMAN_REPAGE_HOURS = 24;

type EscalationContactRow = {
  id?: string;
  customer_e164?: string | null;
  alias_e164s?: string[] | null;
  display_name?: string | null;
  tags?: string[] | null;
};

/**
 * Open the needs-human state: write the tag, then fire the SAME hooks as
 * every other tag write path — goal events on every linked number, and the
 * tag_changed contact-event trigger (which is what starts a team-offer
 * flow). Returns whether the tag landed and how many flow runs the event
 * enqueued, so the caller can decide whether a direct owner page is still
 * needed. The event carries the customer's message as the trigger note.
 */
async function openNeedsHumanState(
  supabase: AnyClient,
  input: EscalationInput,
  contact: EscalationContactRow & { id: string },
  existingTags: string[]
): Promise<{ tagOk: boolean; enqueued: number }> {
  const nextTags = [...existingTags, NEEDS_HUMAN_TAG];
  const { error: tagErr } = await supabase
    .from("contacts")
    .update({ tags: nextTags, updated_at: new Date().toISOString() })
    .eq("id", contact.id);
  if (tagErr) {
    // Safe direction: the caller pages (or already paged) the owner; a
    // failed tag write means the NEXT escalated turn may page again
    // (duplicate), never silence.
    console.error("needs_human: tag write", tagErr);
    return { tagOk: false, enqueued: 0 };
  }
  const numbers = [
    ...new Set(
      [contact.customer_e164 ?? "", ...(contact.alias_e164s ?? []), input.contactE164].filter(
        Boolean
      )
    )
  ];
  for (const number of numbers) {
    await applyGoalEvent(supabase, input.businessId, number, {
      kind: "tag_added",
      tag: NEEDS_HUMAN_TAG
    });
  }
  const enqueued = await enqueueContactEventRuns(supabase, input.businessId, {
    kind: "tag_changed",
    tag: NEEDS_HUMAN_TAG,
    change: "added",
    contact: {
      e164: contact.customer_e164 || input.contactE164,
      name: contact.display_name ?? undefined,
      tags: nextTags
    },
    note: `They said: "${input.inboundPreview.slice(0, 300)}"`,
    dedupeKey: `needs-human:${input.contactE164}:${Date.now()}`
  });
  return { tagOk: true, enqueued };
}

/**
 * Flip the contact into the needs-human state and page the owner. Never
 * throws. Ordering is deliberate (Bugbot findings on the first draft):
 *
 *   dedupe checks → page the owner → THEN write the tag + hooks.
 *
 * TEAM-FIRST exception (businesses.needs_human_team_first): the tag + hooks
 * go FIRST because the tag_changed hook is what starts the team-offer flow;
 * the direct page is skipped only when a flow run actually enqueued (the
 * flow's timeout fallback then owns the owner alert). Every other outcome
 * falls back to the page-first ordering below.
 *
 * The page comes before the tag so a failed notification never strands a
 * tagged-but-never-paged contact behind the `already_open` dedupe — a
 * failed page leaves NO state, and the next escalated turn retries. A
 * failed tag write after a successful page errs the other way (a possible
 * duplicate page next turn), which is the safe direction.
 *
 * `already_open` = the contact carries the tag (owner hasn't cleared it),
 * or — for untaggable contacts — a notifications row shows a page within
 * NEEDS_HUMAN_REPAGE_HOURS.
 */
export async function escalateToHuman(
  supabase: AnyClient,
  input: EscalationInput
): Promise<EscalationResult> {
  try {
    // Alias-aware contact lookup (a merged number resolves to the surviving
    // row, same as the reply path's memory lookup).
    const { data, error } = await supabase
      .from("contacts")
      .select("id, customer_e164, alias_e164s, display_name, tags")
      .eq("business_id", input.businessId)
      .or(`customer_e164.eq.${input.contactE164},alias_e164s.cs.{${input.contactE164}}`)
      .maybeSingle();
    if (error) console.error("needs_human: contact lookup", error);
    const contact = data as EscalationContactRow | null;

    // Dedupe 1: the tag is the open/closed state. For contacts that can
    // carry it, it is the ONLY dedupe — when the owner clears the tag they
    // are saying "resolved", and a fresh handoff (even minutes later) must
    // page again rather than silently vanish into a history-window match.
    if (contact && hasNeedsHumanTag(contact.tags)) return "already_open";
    const existingTags = (Array.isArray(contact?.tags) ? contact!.tags! : []).filter(
      (t): t is string => typeof t === "string" && t.trim().length > 0
    );
    const canCarryTag = Boolean(contact?.id) && existingTags.length < MAX_TAGS;

    // TEAM-FIRST: with businesses.needs_human_team_first ON, the tag + hooks
    // go FIRST — the tag_changed hook enqueues the team-offer flow, whose
    // broadcast owns notification (owner paged only by its timeout fallback).
    // The direct owner page is skipped ONLY when a run really enqueued; a
    // deleted/disabled flow, a deduped enqueue, or a failed tag write all
    // fall through to the page below — silence is never the end state.
    // Untaggable contacts (no row, tag cap) never consult the toggle: the
    // tag is the open/closed state the whole feature hangs off.
    let stateAttempted = false;
    let teamFirstTagWritten = false;
    if (canCarryTag && contact?.id && (await teamFirstEnabled(supabase, input.businessId))) {
      stateAttempted = true;
      const opened = await openNeedsHumanState(
        supabase,
        input,
        contact as EscalationContactRow & { id: string },
        existingTags
      );
      teamFirstTagWritten = opened.tagOk;
      if (opened.tagOk && opened.enqueued > 0) return "team_offered";
      // Fall through to the direct page. A failed tag write is NOT retried
      // here: the page below is the alert that matters, and the next
      // escalated turn re-attempts the tag (same semantics as the legacy
      // failed-write path).
    }

    // Dedupe 2 (ONLY for contacts that cannot carry the tag — no CRM row, or
    // a row at the tag cap): recent-page fallback against the notifications
    // history, so every turn of an open escalation doesn't page again. The
    // notifications function stamps contactE164 into every history row for
    // this kind (see supabase/functions/notifications/index.ts basePayload).
    if (!canCarryTag) {
      const sinceIso = new Date(Date.now() - NEEDS_HUMAN_REPAGE_HOURS * 3_600_000).toISOString();
      const { data: recent, error: recentErr } = await supabase
        .from("notifications")
        .select("id")
        .eq("business_id", input.businessId)
        // Only a DELIVERED page counts: the notifications function records
        // skipped/failed channel rows too, and those must not suppress a
        // retry that could actually reach the owner.
        .eq("status", "sent")
        .eq("payload->>taskType", NEEDS_HUMAN_TASK_TYPE)
        .eq("payload->>contactE164", input.contactE164)
        .gte("created_at", sinceIso)
        .limit(1);
      if (recentErr) {
        console.error("needs_human: recent-page lookup", recentErr);
      } else if (((recent ?? []) as unknown[]).length > 0) {
        return "already_open";
      }
    }

    // 1) Page the owner FIRST (notifications function fans out SMS/email/
    // dashboard per their preferences and records the history rows). A
    // failure leaves no state so the next escalated TURN retries — and
    // because the reply path only escalates on the fresh-reply attempt
    // (cached retries skip it), transient upstream blips get a bounded
    // in-call retry here so one 503 can't lose the page for a job whose
    // handoff reply was already cached.
    const label = contact?.display_name?.trim() || input.contactE164;
    const doFetch = input.fetchFn ?? fetch;
    const body = JSON.stringify({
      type: "INSERT",
      table: "coworker_logs",
      record: {
        id: crypto.randomUUID(),
        business_id: input.businessId,
        task_type: NEEDS_HUMAN_TASK_TYPE,
        status: "urgent_alert",
        log_payload: {
          contact_e164: input.contactE164,
          contact_label: label,
          intent: input.intent.slice(0, 80),
          reason: input.reason.slice(0, 300),
          inbound_preview: input.inboundPreview.slice(0, 300)
        },
        created_at: new Date().toISOString()
      }
    });
    let delivered = false;
    for (let attempt = 1; attempt <= NOTIFY_MAX_ATTEMPTS; attempt++) {
      try {
        const res = await doFetch(input.notifyUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${input.bearer}`
          },
          body
        });
        if (res.ok) {
          delivered = true;
          break;
        }
        const transient = res.status === 429 || res.status >= 500;
        console.error("needs_human: notify post failed", res.status);
        if (!transient) break; // a 4xx is permanent — retrying can't help
      } catch (postErr) {
        console.error("needs_human: notify post threw", postErr);
      }
      if (attempt < NOTIFY_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
    if (!delivered) {
      // Team-first wrote the tag BEFORE this page (the flow was supposed to
      // own notification, but no run enqueued). A failed page must not leave
      // the tag behind — the next escalated turn would hit `already_open`
      // and the owner would NEVER hear about it (Bugbot, PR #801). Roll the
      // tag back, best-effort, so the retry semantics match the legacy
      // page-first ordering: a failed page leaves NO state.
      if (teamFirstTagWritten && contact?.id) {
        const { error: revertErr } = await supabase
          .from("contacts")
          .update({ tags: existingTags, updated_at: new Date().toISOString() })
          .eq("id", contact.id);
        if (revertErr) console.error("needs_human: team-first tag rollback", revertErr);
      }
      return "notify_failed";
    }

    // 2) Open the needs-human state (contacts with tag headroom only —
    // untaggable contacts were deduped against the history above; a
    // team-first attempt above already tried, successfully or not).
    if (canCarryTag && contact?.id && !stateAttempted) {
      await openNeedsHumanState(
        supabase,
        input,
        contact as EscalationContactRow & { id: string },
        existingTags
      );
    }
    return "escalated";
  } catch (e) {
    console.error("escalateToHuman", e);
    return "notify_failed";
  }
}
