/**
 * Platform lifecycle stage tagging: advance a lead through the business's
 * pipeline stages at the moments every tenant already hits.
 *
 * The Tasks board is a view over `contacts.tags`, and stages ARE tags. That
 * design assumed each tenant would author `update_contact` steps to write
 * those tags, and in practice almost nobody does: the fleet's heaviest
 * tenant has 21 flows and exactly one tag-writing step, so its board is
 * empty even though every lead's state is perfectly well known to the
 * engine. This module closes that gap once, for everyone.
 *
 *   lead filed  -> "New Lead"    (enrichCustomerProfile)
 *   claimed     -> "Contacted"   (assignContactOwnerOnClaim, the "reply 1")
 *   replied     -> "Engaged"     (inbound SMS webhook)
 *   booking     -> "Booked"      (every appointment_booked goal event)
 *
 * Each is a sibling of an existing `GoalEventKind` call site, so this rides
 * instrumentation the engine already had.
 *
 * The write is an ORDINARY tag write firing the ORDINARY hooks (goal events
 * + `tag_changed` contact events), because a stage tag that automations
 * cannot see would be a second, invisible notion of lead state. Five things
 * keep that from looping or surprising a tenant:
 *
 *   1. `sourceFlowId` loop guard, contact_events already excludes the flow
 *      whose own step caused the write, so a flow that files a lead cannot
 *      retrigger itself through the "New Lead" tag it caused.
 *   2. Forward-only + no-op suppression (see planLifecycleStageWrites): a
 *      repeating trigger transitions exactly once per contact, ever.
 *   3. A hard bound of three forward moves per contact per pipeline.
 *   4. The stage-must-exist gate: the tenant created that column.
 *   5. `businesses.auto_lifecycle_stages`, read fail-safe OFF.
 *
 * Best-effort throughout and never throws: a stage tag must never break the
 * lead-filing, claim, reply or booking path that discovered it.
 * Dependency-injected client so this is unit-tested under the shared 100%
 * coverage gate.
 */
import { applyGoalEvent } from "../ai_flows/goal_events.ts";
import { enqueueContactEventRuns } from "../ai_flows/contact_events.ts";
import {
  planLifecycleStageWrites,
  type LifecycleEvent,
  type PipelineStages,
  type StageRef
} from "./stages.ts";

// Minimal structural client (the _shared convention).
// deno-lint-ignore no-explicit-any
type AnyClient = any;

/**
 * Why nothing was written, or that something was. Returned rather than
 * thrown so callers can record the decision without a try/catch.
 */
export type LifecycleStageOutcome =
  | "written"
  /** Nothing to do: already at or past this stage. */
  | "no_change"
  /** The business has no pipeline stage named for this moment. */
  | "no_stage"
  /** No contact row for that number. */
  | "no_contact"
  /** A teammate is never a lead. */
  | "staff"
  /** auto_lifecycle_stages is off, or could not be read. */
  | "disabled"
  /** The 25-tag cap blocked the move. */
  | "dropped_at_cap";

export type ApplyLifecycleStageOptions = {
  /** Loop guard: the flow whose own step caused this, when a flow did. */
  sourceFlowId?: string;
  /**
   * Exactly-once component for the contact-event dedupe key. Build it from
   * the event instance: a run id, an inbound event id, a booking event id.
   */
  dedupeSuffix: string;
};

/**
 * Is auto stage tagging on for this business?
 *
 * Fail-safe direction is OFF, deliberately the OPPOSITE of needs_human's
 * team-first toggle. There the safe direction is "still page someone"; here
 * a tag write is an irreversible side effect that can start a tenant's
 * flow, so an unreadable toggle writes nothing.
 */
async function lifecycleStagesEnabled(
  supabase: AnyClient,
  businessId: string
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("businesses")
      .select("auto_lifecycle_stages")
      .eq("id", businessId)
      .maybeSingle();
    if (error) {
      console.error("lifecycle_stages: toggle read", error);
      return false;
    }
    const row = data as { auto_lifecycle_stages?: boolean | null } | null;
    // A null/absent column (pre-migration row) reads as ON, matching the
    // column default, so the feature is not silently dead on old rows.
    return row === null ? false : row.auto_lifecycle_stages !== false;
  } catch (e) {
    console.error("lifecycle_stages: toggle read", e);
    return false;
  }
}

/**
 * Every pipeline of the business, with its stages ordered by position. One
 * indexed select; zero rows is the fast path for the many tenants who never
 * created a board.
 */
async function loadPipelineStages(
  supabase: AnyClient,
  businessId: string
): Promise<PipelineStages[] | null> {
  try {
    const { data, error } = await supabase
      .from("pipeline_stages")
      .select("id, pipeline_id, name, position")
      .eq("business_id", businessId)
      .order("position", { ascending: true });
    if (error) {
      console.error("lifecycle_stages: stage read", error);
      return null;
    }
    const rows = (data ?? []) as Array<{
      id: string;
      pipeline_id: string;
      name: string;
      position: number;
    }>;
    const byPipeline = new Map<string, StageRef[]>();
    for (const row of rows) {
      const list = byPipeline.get(row.pipeline_id) ?? [];
      list.push({ id: row.id, name: row.name, position: row.position });
      byPipeline.set(row.pipeline_id, list);
    }
    return [...byPipeline.entries()].map(([pipelineId, stages]) => ({
      pipelineId,
      stages
    }));
  } catch (e) {
    console.error("lifecycle_stages: stage read", e);
    return null;
  }
}

type ContactRow = {
  id: string;
  customer_e164: string | null;
  alias_e164s: string[] | null;
  tags: string[] | null;
  type: string | null;
};

/**
 * Is this contact a teammate rather than a lead?
 *
 * "A teammate is never a lead, however the step addressed them" (README).
 * Two independent signals: the stored `type`, and the roster itself, keyed
 * on every number linked to the row. Fails SAFE (an unreadable roster is
 * treated as staff), so an outage can never start tagging the broker as a
 * lead in their own pipeline.
 *
 * Deliberately NOT gated on `businesses.aiflow_protect_staff_contacts`:
 * that toggle exists so a business can maintain lead-state tags over its
 * own team through its OWN flows, which is not consent to receive automatic
 * platform tags.
 */
async function isStaffContact(
  supabase: AnyClient,
  businessId: string,
  contact: ContactRow,
  numbers: string[]
): Promise<boolean> {
  const storedType = (contact.type ?? "").trim().toLowerCase();
  if (storedType === "owner" || storedType === "employee") return true;
  // `numbers` always carries at least the targeted phone, which the caller
  // validated as non-empty, so there is no empty case to guard.
  try {
    const { data, error } = await supabase
      .from("ai_flow_team_members")
      .select("id")
      .eq("business_id", businessId)
      .in("phone_e164", numbers)
      .limit(1);
    if (error) {
      console.error("lifecycle_stages: roster check", error);
      return true;
    }
    return ((data ?? []) as unknown[]).length > 0;
  } catch (e) {
    console.error("lifecycle_stages: roster check", e);
    return true;
  }
}

/** Alias-aware contact lookup, matching every other tag write path. */
async function loadContact(
  supabase: AnyClient,
  businessId: string,
  contactE164: string
): Promise<ContactRow | null> {
  try {
    const { data, error } = await supabase
      .from("contacts")
      .select("id, customer_e164, alias_e164s, tags, type")
      .eq("business_id", businessId)
      .or(`customer_e164.eq.${contactE164},alias_e164s.cs.{${contactE164}}`)
      .maybeSingle();
    if (error) {
      console.error("lifecycle_stages: contact read", error);
      return null;
    }
    return (data as ContactRow | null) ?? null;
  } catch (e) {
    console.error("lifecycle_stages: contact read", e);
    return null;
  }
}

/**
 * Advance a contact to the stage this lifecycle event implies. Never throws.
 */
export async function applyLifecycleStage(
  supabase: AnyClient,
  businessId: string,
  contactE164: string | null | undefined,
  event: LifecycleEvent,
  opts: ApplyLifecycleStageOptions
): Promise<LifecycleStageOutcome> {
  const phone = (contactE164 ?? "").trim();
  if (!phone) return "no_contact";

  if (!(await lifecycleStagesEnabled(supabase, businessId))) return "disabled";

  // Cheapest discriminator first: most tenants have no board at all, and
  // that costs exactly one indexed select.
  const pipelines = await loadPipelineStages(supabase, businessId);
  if (pipelines === null || pipelines.length === 0) return "no_stage";

  const contact = await loadContact(supabase, businessId, phone);
  if (!contact) return "no_contact";

  const numbers = [
    ...new Set(
      [contact.customer_e164 ?? "", ...(contact.alias_e164s ?? []), phone].filter(
        (n) => typeof n === "string" && n.length > 0
      )
    )
  ];
  if (await isStaffContact(supabase, businessId, contact, numbers)) return "staff";

  const currentTags = (Array.isArray(contact.tags) ? contact.tags : []).filter(
    (t): t is string => typeof t === "string" && t.trim().length > 0
  );
  const plan = planLifecycleStageWrites({ event, currentTags, pipelines });
  if (!plan.changed) return plan.droppedAtCap ? "dropped_at_cap" : "no_change";

  try {
    const { error } = await supabase
      .from("contacts")
      .update({ tags: plan.nextTags, updated_at: new Date().toISOString() })
      .eq("id", contact.id);
    if (error) {
      console.error("lifecycle_stages: tag write", error);
      return "no_change";
    }
  } catch (e) {
    console.error("lifecycle_stages: tag write", e);
    return "no_change";
  }

  // The same hooks, in the same order, as update_contact's tag write. Runs
  // match by the EXACT number they were triggered with, which after a
  // profile merge may be any of the row's numbers, so fan out over all.
  for (const tag of plan.added) {
    for (const number of numbers) {
      await applyGoalEvent(supabase, businessId, number, { kind: "tag_added", tag });
    }
  }
  for (const [tag, change] of [
    ...plan.added.map((t) => [t, "added"] as const),
    ...plan.removed.map((t) => [t, "removed"] as const)
  ]) {
    await enqueueContactEventRuns(supabase, businessId, {
      kind: "tag_changed",
      contact: { e164: contact.customer_e164 || phone, tags: plan.nextTags },
      tag,
      change,
      ...(opts.sourceFlowId ? { sourceFlowId: opts.sourceFlowId } : {}),
      dedupeKey: `ce:stage:${opts.dedupeSuffix}:${tag.toLowerCase()}:${change}`
    });
  }

  return "written";
}
