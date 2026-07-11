/**
 * Contact-event triggers (contact_created / tag_changed / owner_assigned).
 *
 * Push-based like the webhook channel: the write sites call
 * `enqueueContactEventRuns` when the event happens —
 *   - contact_created: dashboard/API contact creation, CSV import, and the
 *     upsert_customer worker step (when it actually created a row);
 *   - tag_changed: dashboard tag edits and the update_contact worker step;
 *   - owner_assigned: a route_to_team claim's auto-assign and the manual
 *     owner picker on the contact page.
 *
 * Conditions evaluate over a "key: value" text of the contact's fields (the
 * same shape email/webhook windowText uses, so extract_text and templates
 * work unchanged); `from` is the contact's phone so `from_matches` can scope
 * a flow to a person.
 *
 * Loop guard: `sourceFlowId` (the flow whose own update_contact step wrote
 * the tag) is excluded, so a flow can never retrigger itself through its own
 * tag writes. Cross-flow chains are allowed by design — they are the
 * state-machine composition this trigger exists for — bounded by each flow's
 * dedupe key.
 *
 * Best-effort: a failure here never breaks the contact write that observed
 * the event.
 */
import { evaluateSmsTrigger } from "./engine.ts";
import {
  resolveFromMatchesRefValues,
  type ContactRefSupabase
} from "./contact_ref.ts";
import type { TriggerCondition } from "./types.ts";

export type ContactEventKind = "contact_created" | "tag_changed" | "owner_assigned";

export type ContactEventContact = {
  e164: string;
  name?: string;
  email?: string;
  tags?: string[];
};

export type ContactEventInput = {
  kind: ContactEventKind;
  contact: ContactEventContact;
  /** tag_changed: the tag that changed. */
  tag?: string;
  /** tag_changed: what happened to it. Default "added". */
  change?: "added" | "removed";
  /** owner_assigned: the roster member's display name. */
  ownerName?: string;
  /** Loop guard: the flow whose own step caused this write, if any. */
  sourceFlowId?: string;
  /**
   * Exactly-once component, combined with the flow id by the runs table's
   * unique (flow_id, dedupe_key) index. Callers build it from the event
   * instance (e.g. `ce:<runId>:<stepIndex>:<tag>` for worker writes).
   */
  dedupeKey: string;
};

/** Most flows one event evaluates against (defense against tag-storm loops). */
const MAX_FLOWS_PER_EVENT = 50;

/**
 * The "key: value" text conditions and extract_text see (same convention as
 * the calendar/webhook channels).
 */
export function contactEventText(input: ContactEventInput): string {
  const c = input.contact;
  const tags = c.tags ?? [];
  const lines = [
    `event: ${input.kind}`,
    c.name ? `name: ${c.name}` : "",
    `phone: ${c.e164}`,
    c.email ? `email: ${c.email}` : "",
    tags.length > 0 ? `tags: ${tags.join(", ")}` : "",
    input.kind === "tag_changed" ? `tag: ${input.tag ?? ""}` : "",
    input.kind === "tag_changed" ? `change: ${input.change ?? "added"}` : "",
    input.kind === "owner_assigned" && input.ownerName ? `owner: ${input.ownerName}` : ""
  ];
  return lines.filter((l) => l.length > 0).join("\n");
}

/** The enqueued run's `context.trigger` (what {{trigger.x}} renders from). */
export function contactEventTriggerScope(input: ContactEventInput): Record<string, unknown> {
  return {
    channel: input.kind,
    windowText: contactEventText(input),
    url: "",
    from: input.contact.e164,
    contact_name: input.contact.name ?? "",
    contact_email: input.contact.email ?? "",
    ...(input.kind === "tag_changed"
      ? { tag: input.tag ?? "", change: input.change ?? "added" }
      : {}),
    ...(input.kind === "owner_assigned" ? { owner_name: input.ownerName ?? "" } : {})
  };
}

type EventTrigger = {
  channel?: string;
  tag?: unknown;
  change?: unknown;
  conditions?: unknown;
};

/** Does one trigger of the flow match this event (channel + tag/change narrowing)? */
export function contactEventTriggerMatches(trig: EventTrigger, input: ContactEventInput): boolean {
  if (trig.channel !== input.kind) return false;
  if (input.kind !== "tag_changed") return true;
  const wantedChange = trig.change === "removed" ? "removed" : "added";
  if ((input.change ?? "added") !== wantedChange) return false;
  const wantedTag = typeof trig.tag === "string" ? trig.tag.trim().toLowerCase() : "";
  if (!wantedTag) return true;
  return (input.tag ?? "").trim().toLowerCase() === wantedTag;
}

// Minimal structural client (matches the _shared convention).
// deno-lint-ignore no-explicit-any
type AnyClient = any;

/**
 * Evaluate every enabled flow with a matching contact-event trigger and
 * enqueue a queued run per match. Returns how many runs were enqueued.
 * Never throws.
 */
export async function enqueueContactEventRuns(
  supabase: AnyClient,
  businessId: string,
  input: ContactEventInput
): Promise<number> {
  try {
    const { data, error } = await supabase
      .from("ai_flows")
      .select("id, definition")
      .eq("business_id", businessId)
      .eq("enabled", true)
      .or(
        `definition->trigger->>channel.eq.${input.kind},definition->triggers.not.is.null`
      )
      .limit(MAX_FLOWS_PER_EVENT);
    if (error) {
      console.error("contact_events: flow lookup", error);
      return 0;
    }
    const rows = (data ?? []) as Array<{ id: string; definition?: unknown }>;
    const scope = contactEventTriggerScope(input);
    const windowText = String(scope.windowText);
    let enqueued = 0;

    for (const row of rows) {
      if (input.sourceFlowId && row.id === input.sourceFlowId) continue; // loop guard
      const def = row.definition as
        | { trigger?: EventTrigger; triggers?: EventTrigger[] }
        | null;
      const triggers = [def?.trigger, ...(def?.triggers ?? [])];
      const matching = triggers.filter(
        (t): t is EventTrigger => !!t && contactEventTriggerMatches(t, input)
      );
      if (matching.length === 0) continue;

      // ANY matching trigger's condition list may fire the flow (OR set).
      let matched = false;
      for (const trig of matching) {
        const conditions = Array.isArray(trig.conditions)
          ? (trig.conditions as TriggerCondition[])
          : [];
        // Reuse the SMS evaluator over a single synthetic message: windowText
        // is the contact text, `from` is the contact's phone. from_matches
        // saved-person refs resolve to live identity values; a resolution
        // failure fails CLOSED for that trigger only.
        let refValues: ReadonlyMap<string, string[]> | undefined;
        try {
          refValues = await resolveFromMatchesRefValues(
            supabase as ContactRefSupabase,
            businessId,
            conditions
          );
        } catch (e) {
          console.error("contact_events: ref resolution", e);
          continue;
        }
        const res = evaluateSmsTrigger(
          { channel: "sms", conditions },
          { messages: [{ text: windowText, from: input.contact.e164, atMs: Date.now() }] },
          refValues
        );
        if (res.matched) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;

      const { error: runErr } = await supabase.from("ai_flow_runs").insert({
        flow_id: row.id,
        business_id: businessId,
        status: "queued",
        context: { trigger: scope },
        current_step: 0,
        dedupe_key: input.dedupeKey
      });
      // 23505 = an earlier delivery of the same event already enqueued it.
      if (runErr && (runErr as { code?: string }).code !== "23505") {
        console.error("contact_events: run insert", runErr);
        continue;
      }
      if (!runErr) enqueued += 1;
    }
    return enqueued;
  } catch (e) {
    console.error("enqueueContactEventRuns", e);
    return 0;
  }
}
