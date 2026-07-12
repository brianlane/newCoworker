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
  | "notify_failed";

/**
 * Fallback re-page window for escalations that cannot carry the tag (no
 * contact row, or a row already at the 25-tag cap): a notifications-history
 * row for this contact younger than this counts as "the owner was already
 * paged", so repeat turns don't page again every message.
 */
export const NEEDS_HUMAN_REPAGE_HOURS = 24;

/**
 * Flip the contact into the needs-human state and page the owner. Never
 * throws. Ordering is deliberate (Bugbot findings on the first draft):
 *
 *   dedupe checks → page the owner → THEN write the tag + hooks.
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
    const contact = data as {
      id?: string;
      customer_e164?: string | null;
      alias_e164s?: string[] | null;
      display_name?: string | null;
      tags?: string[] | null;
    } | null;

    // Dedupe 1: the tag is the open/closed state. For contacts that can
    // carry it, it is the ONLY dedupe — when the owner clears the tag they
    // are saying "resolved", and a fresh handoff (even minutes later) must
    // page again rather than silently vanish into a history-window match.
    if (contact && hasNeedsHumanTag(contact.tags)) return "already_open";
    const existingTags = (Array.isArray(contact?.tags) ? contact!.tags! : []).filter(
      (t): t is string => typeof t === "string" && t.trim().length > 0
    );
    const canCarryTag = Boolean(contact?.id) && existingTags.length < MAX_TAGS;

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
    // failure leaves no state so the next escalated turn retries.
    const label = contact?.display_name?.trim() || input.contactE164;
    const doFetch = input.fetchFn ?? fetch;
    const res = await doFetch(input.notifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.bearer}`
      },
      body: JSON.stringify({
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
      })
    });
    if (!res.ok) {
      console.error("needs_human: notify post failed", res.status);
      return "notify_failed";
    }

    // 2) Open the needs-human state (contacts with tag headroom only —
    // untaggable contacts were deduped against the history above).
    if (canCarryTag && contact?.id) {
      const nextTags = [...existingTags, NEEDS_HUMAN_TAG];
      const { error: tagErr } = await supabase
        .from("contacts")
        .update({ tags: nextTags, updated_at: new Date().toISOString() })
        .eq("id", contact.id);
      if (tagErr) {
        // Safe direction: the page already landed; a failed tag write means
        // the NEXT escalated turn may page again (duplicate), never silence.
        console.error("needs_human: tag write", tagErr);
      } else {
        // 3) Same hooks as every other tag write path: goal events on every
        // linked number, and the tag_changed contact-event trigger.
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
        await enqueueContactEventRuns(supabase, input.businessId, {
          kind: "tag_changed",
          tag: NEEDS_HUMAN_TAG,
          change: "added",
          contact: {
            e164: contact.customer_e164 || input.contactE164,
            name: contact.display_name ?? undefined,
            tags: nextTags
          },
          dedupeKey: `needs-human:${input.contactE164}:${Date.now()}`
        });
      }
    }
    return "escalated";
  } catch (e) {
    console.error("escalateToHuman", e);
    return "notify_failed";
  }
}
