/**
 * Contact-event triggers (contact_created / tag_changed / owner_assigned).
 *
 * Push-based like the webhook channel: the write sites call
 * `enqueueContactEventRuns` when the event happens,
 *   - contact_created: dashboard/API contact creation, CSV import, and the
 *     upsert_customer worker step (when it actually created a row);
 *   - tag_changed: dashboard tag edits and the update_contact worker step;
 *   - owner_assigned: a route_to_team claim's auto-assign and the manual
 *     owner picker on the contact page.
 *
 * Conditions evaluate over a "key: value" text of the contact's fields (the
 * same shape email/webhook windowText uses, so extract_text and templates
 * work unchanged); `from` is the contact's phone so `from_matches` can scope
 * a flow to a person. The text carries what the PLATFORM already knows about
 * the contact, `lead_source` included, because the alternative is every flow
 * re-deriving it from free text and falling back when it cannot.
 *
 * Callers only have to supply the phone. Whatever name/email/tags they leave
 * out is read from the contact row here (see `hydrateContactEventContact`),
 * so the event text always has the shape flows are written against no matter
 * which write site produced it. That read happens only once a flow watching
 * this event has actually been found.
 *
 * Loop guard: `sourceFlowId` (the flow whose own update_contact step wrote
 * the tag) is excluded, so a flow can never retrigger itself through its own
 * tag writes. Cross-flow chains are allowed by design, they are the
 * state-machine composition this trigger exists for, bounded by each flow's
 * dedupe key.
 *
 * Best-effort: a failure here never breaks the contact write that observed
 * the event.
 */
import { evaluateSmsTrigger, isE164 } from "./engine.ts";
import {
  resolveFromMatchesRefValues,
  type ContactRefSupabase
} from "./contact_ref.ts";
import { recordStageChangeForMeta } from "./meta_capi.ts";
import { reentryBlocked } from "./reentry.ts";
import type { TriggerCondition } from "./types.ts";
import { contactKeyEmail, isEmailContactKey } from "../contact_key.ts";

export type ContactEventKind = "contact_created" | "tag_changed" | "owner_assigned";

export type ContactEventContact = {
  e164: string;
  name?: string;
  email?: string;
  tags?: string[];
  /**
   * `contacts.lead_source`, the network the lead arrived from
   * ("ReferralExchange", "Clever", "HomeLight"). Hydrated from the row like
   * name/email/tags, so a flow reading this event never has to guess it.
   */
  source?: string;
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
  /**
   * Free-text context for the event, rendered as a `note: …` line in the
   * windowText and exposed to templates as `{{trigger.note}}`. The
   * needs-human escalation passes the customer's last message here so a
   * team-offer flow can show WHAT the person needs, not just who they are.
   */
  note?: string;
  /** Loop guard: the flow whose own step caused this write, if any. */
  sourceFlowId?: string;
  /**
   * Exactly-once component, combined with the flow id by the runs table's
   * unique (flow_id, dedupe_key) index. Callers build it from the event
   * instance (e.g. `ce:<runId>:<stepIndex>:<tag>` for worker writes).
   */
  dedupeKey: string;
};

/** Flow-listing page size (paged so no enabled flow is silently skipped). */
const FLOW_PAGE = 100;

/**
 * The "key: value" text conditions and extract_text see (same convention as
 * the calendar/webhook channels).
 */
/**
 * The contact's lead source as both readers must see it.
 *
 * One definition on purpose: the `source:` line and
 * `{{trigger.contact_source}}` are documented as the same value, so a stored
 * "  Clever  " must not reach a template padded while the extraction reads it
 * trimmed. A template comparing the two would then disagree with itself.
 */
function normalizedSource(contact: ContactEventContact): string {
  return typeof contact.source === "string" ? contact.source.trim() : "";
}

export function contactEventText(input: ContactEventInput): string {
  const c = input.contact;
  const tags = c.tags ?? [];
  // `e164` is the contact KEY, and a key is not always a phone number. For an
  // email-keyed contact it is `email:<addr>`, and printing that under a
  // `phone:` label tells every reader of this text, including the Gemini
  // extraction that lifts lead_phone out of it, that the person's phone number
  // is "email:val@example.com". A contact with no phone gets no phone line;
  // the `email:` line below already carries their identity.
  const phone = isEmailContactKey(c.e164) ? "" : c.e164;
  const source = normalizedSource(c);
  const lines = [
    `event: ${input.kind}`,
    c.name ? `name: ${c.name}` : "",
    phone ? `phone: ${phone}` : "",
    c.email ? `email: ${c.email}` : "",
    tags.length > 0 ? `tags: ${tags.join(", ")}` : "",
    // Where the lead came from, straight off `contacts.lead_source`. Without
    // it a flow reading this event can only guess the network from whatever
    // happens to be in `tags:`, and a lead whose source is a column rather
    // than a tag reads as unknown: on Amy Laidlaw's follow-up cadence, 23 of
    // 42 runs fell back to the unknown-source phrase while the contact row
    // said "ReferralExchange" the whole time.
    source ? `source: ${source}` : "",
    input.kind === "tag_changed" ? `tag: ${input.tag ?? ""}` : "",
    input.kind === "tag_changed" ? `change: ${input.change ?? "added"}` : "",
    input.kind === "owner_assigned" && input.ownerName ? `owner: ${input.ownerName}` : "",
    input.note ? `note: ${input.note}` : ""
  ];
  return lines.filter((l) => l.length > 0).join("\n");
}

/** The enqueued run's `context.trigger` (what {{trigger.x}} renders from). */
export function contactEventTriggerScope(input: ContactEventInput): Record<string, unknown> {
  return {
    channel: input.kind,
    windowText: contactEventText(input),
    url: "",
    // The contact KEY, deliberately, including the `email:` form. Several
    // consumers look the contact up by this value (the worker seeds
    // {{vars.contact_language}} from it with a customer_e164 lookup), so it has
    // to be the identity, not a rendering of it. from_matches is made to line
    // up from the OTHER side: resolveRefIdentityValues returns the key
    // alongside the address.
    from: input.contact.e164,
    contact_name: input.contact.name ?? "",
    contact_email: input.contact.email ?? "",
    // Same value as the `source:` line in windowText, addressable directly so
    // a template can say it without an extract_text step to lift it back out.
    // Normalized through the SAME helper the line uses, so "same value" is
    // structural rather than a claim in a comment.
    contact_source: normalizedSource(input.contact),
    note: input.note ?? "",
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

/**
 * Fill in the identity fields the write site did not have in hand.
 *
 * `contactEventText` documents a `name: / phone: / email: / tags: / source: …` shape,
 * and flows are written against it: a condition asking "does this lead carry
 * the Clever tag?", an extract_text step reading the name line. But most
 * write sites only know the phone: a route_to_team claim has the lead's
 * number and nothing else, so its owner_assigned event rendered as just
 * `event: / phone: / owner:` and no tag condition could ever match. That is
 * not a flow that fires rarely, it is a flow that can never fire.
 *
 * One indexed read closes the gap for every site at once. Caller-supplied
 * values always win: a tag_changed site passes the POST-write tag list,
 * which is fresher than anything this read can return. Only a field the
 * caller left UNDEFINED is looked up.
 *
 * Best-effort by contract. Every caller is a write that already happened
 * (a claim, a tag edit, an import row) and must not be undone by a trigger
 * lookup, so a read failure returns the contact untouched and the event
 * still fires with whatever the caller had.
 */
export async function hydrateContactEventContact(
  supabase: AnyClient,
  businessId: string,
  contact: ContactEventContact
): Promise<ContactEventContact> {
  // Absent means UNDEFINED, never "empty". A caller that passes `tags: []`
  // is stating the contact has no tags (a tag_changed site does exactly that
  // after the last tag is removed), and that answer is the caller's to give.
  // Reading over it would put tags back on an event that just cleared them.
  const needsName = contact.name === undefined;
  const needsEmail = contact.email === undefined;
  const needsTags = contact.tags === undefined;
  const needsSource = contact.source === undefined;
  if (!needsName && !needsEmail && !needsTags && !needsSource) return contact;
  // The key is interpolated into a PostgREST `or` filter, where a stray comma
  // or paren would change what the filter means. A clean E.164 number is safe;
  // so is an `email:` key, whose address was validated against the same
  // metacharacters before it could become a key (contact_key.ts), and which is
  // matched exactly rather than through the alias arm. Anything else skips
  // hydration, which is the pre-fix behavior.
  const e164 = typeof contact.e164 === "string" ? contact.e164.trim() : "";
  const emailKeyed = isEmailContactKey(e164) && contactKeyEmail(e164) !== null;
  if (!isE164(e164) && !emailKeyed) return contact;
  try {
    const base = supabase
      .from("contacts")
      .select("display_name, email, tags, lead_source")
      .eq("business_id", businessId);
    const { data, error } = await (emailKeyed
      ? base.eq("customer_e164", e164)
      : base.or(`customer_e164.eq.${e164},alias_e164s.cs.{${e164}}`)
    ).maybeSingle();
    if (error) {
      console.error("contact_events: hydrate", error);
      return contact;
    }
    const row = (data ?? null) as {
      display_name?: string | null;
      email?: string | null;
      tags?: string[] | null;
      lead_source?: string | null;
    } | null;
    if (!row) return contact;
    const rowTags = (Array.isArray(row.tags) ? row.tags : []).filter(
      (t): t is string => typeof t === "string" && t.trim().length > 0
    );
    const rowSource = typeof row.lead_source === "string" ? row.lead_source.trim() : "";
    return {
      ...contact,
      ...(needsName && row.display_name ? { name: row.display_name } : {}),
      ...(needsEmail && row.email ? { email: row.email } : {}),
      ...(needsTags && rowTags.length > 0 ? { tags: rowTags } : {}),
      ...(needsSource && rowSource ? { source: rowSource } : {})
    };
  } catch (e) {
    console.error("contact_events: hydrate", e);
    return contact;
  }
}

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
    // Meta Conversion Leads feedback: an ADDED pipeline-stage tag is a CRM
    // funnel transition worth reporting back to Meta. This chokepoint sees
    // every stage-tag writer (board moves, tag editor, MCP, worker
    // update_contact), so one hook covers them all. Best-effort inside.
    if (input.kind === "tag_changed" && (input.change ?? "added") === "added") {
      await recordStageChangeForMeta(supabase, businessId, {
        contactE164: input.contact.e164,
        tag: input.tag ?? "",
        dedupeKey: input.dedupeKey
      });
    }
    // Paged listing (like the calendar poller's) so a tenant with many
    // enabled flows never has a matching automation silently dropped. A
    // later page failing keeps the flows already in hand.
    const rows: Array<{ id: string; definition?: unknown }> = [];
    for (let offset = 0; ; offset += FLOW_PAGE) {
      const { data, error } = await supabase
        .from("ai_flows")
        .select("id, definition")
        .eq("business_id", businessId)
        .eq("enabled", true)
        .is("deleted_at", null)
        .or(
          `definition->trigger->>channel.eq.${input.kind},definition->triggers.not.is.null`
        )
        .order("id", { ascending: true })
        .range(offset, offset + FLOW_PAGE - 1);
      if (error) {
        console.error("contact_events: flow lookup", error);
        if (rows.length === 0) return 0;
        break;
      }
      const batch = (data ?? []) as typeof rows;
      rows.push(...batch);
      if (batch.length < FLOW_PAGE) break;
    }
    // Narrow to the flows whose trigger actually watches this event BEFORE
    // spending a read on hydration: most tenants have no flow on this
    // channel at all, and then the identity fields cost nothing.
    type Candidate = {
      id: string;
      def: {
        trigger?: EventTrigger;
        triggers?: EventTrigger[];
        drip?: { intervalMinutes?: number };
      } | null;
      matching: EventTrigger[];
    };
    const candidates: Candidate[] = [];
    for (const row of rows) {
      if (input.sourceFlowId && row.id === input.sourceFlowId) continue; // loop guard
      const def = row.definition as Candidate["def"];
      const triggers = [def?.trigger, ...(def?.triggers ?? [])];
      const matching = triggers.filter(
        (t): t is EventTrigger => !!t && contactEventTriggerMatches(t, input)
      );
      if (matching.length === 0) continue;
      candidates.push({ id: row.id, def, matching });
    }
    if (candidates.length === 0) return 0;

    // Something is listening, so give it the documented event shape: fill in
    // whatever name/email/tags the write site could not supply.
    const hydrated: ContactEventInput = {
      ...input,
      contact: await hydrateContactEventContact(supabase, businessId, input.contact)
    };
    const scope = contactEventTriggerScope(hydrated);
    const windowText = String(scope.windowText);
    let enqueued = 0;

    for (const { id: rowId, def, matching } of candidates) {
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
          { messages: [{ text: windowText, from: hydrated.contact.e164, atMs: Date.now() }] },
          refValues
        );
        if (res.matched) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;

      // Re-entry gate: a flow with allowReentry=false never re-enrolls a
      // contact who already has a (non-test) run of it. Both identities are
      // passed so a prior email-channel enrollment blocks too.
      if (
        await reentryBlocked(supabase, businessId, rowId, def, [
          hydrated.contact.e164,
          hydrated.contact.email
        ])
      ) {
        continue;
      }

      // Drip pacing (definition.drip): stagger this run after the flow's
      // latest scheduled one, a tag storm or bulk import enrolls hundreds
      // of contacts through THIS path, exactly the burst drip exists for.
      // Best-effort: a read failure enqueues immediately (mirrors the
      // Node-side enqueueAiFlowRun).
      let earliestClaimAt: string | null = null;
      const intervalMinutes = def?.drip?.intervalMinutes;
      if (typeof intervalMinutes === "number" && intervalMinutes >= 1) {
        try {
          const { data: lastRow } = await supabase
            .from("ai_flow_runs")
            .select("earliest_claim_at")
            .eq("flow_id", rowId)
            .eq("status", "queued")
            .not("earliest_claim_at", "is", null)
            .order("earliest_claim_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          const lastIso = (lastRow as { earliest_claim_at?: string | null } | null)
            ?.earliest_claim_at;
          const lastMs = lastIso ? Date.parse(lastIso) : NaN;
          const nowMs = Date.now();
          const nextMs = Number.isFinite(lastMs)
            ? Math.max(nowMs, lastMs + intervalMinutes * 60_000)
            : nowMs;
          earliestClaimAt = new Date(nextMs).toISOString();
        } catch (e) {
          console.error("contact_events: drip", e);
        }
      }

      const { error: runErr } = await supabase.from("ai_flow_runs").insert({
        flow_id: rowId,
        business_id: businessId,
        status: "queued",
        context: { trigger: scope },
        current_step: 0,
        dedupe_key: input.dedupeKey,
        ...(earliestClaimAt ? { earliest_claim_at: earliestClaimAt } : {})
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
