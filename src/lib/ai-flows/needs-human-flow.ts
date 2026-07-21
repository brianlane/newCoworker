/**
 * The seeded "team-first human handoff" flow, managed by the Employees-page
 * toggle (businesses.needs_human_team_first):
 *
 *   Needs Human tag added (the escalation hook in _shared/needs_human.ts)
 *     → route_to_team with broadcastAll: every active, available roster
 *       member is texted the handoff offer at once on one 10-minute
 *       deadline — first "1" claims (contact auto-assigned, losers told),
 *       "2" passes — and the OWNER is alerted only by the timeout /
 *       all-passed fallback.
 *
 * The flow is a REGULAR flow — visible and editable on /dashboard/aiflows
 * (owners can reword templates or change the window). The toggle only
 * manages enablement, keyed by the seeded name; escalateToHuman skips its
 * direct owner page purely on "did a run enqueue", so a deleted or disabled
 * flow self-heals back to page-the-owner.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { setNeedsHumanTeamFirst } from "@/lib/db/businesses";

/** Seeded name — the toggle's lookup key. */
export const NEEDS_HUMAN_TEAM_FLOW_NAME = "Human handoff — offer to team first";

/** Matches _shared/needs_human.ts NEEDS_HUMAN_TAG (kept literal — this
 * module is Next-side, that one is Deno-side; the unit test pins parity). */
const NEEDS_HUMAN_TAG = "Needs Human";

export function needsHumanTeamFlowDefinition(): Record<string, unknown> {
  return {
    version: 1,
    trigger: {
      channel: "tag_changed",
      tag: NEEDS_HUMAN_TAG,
      change: "added",
      conditions: []
    },
    steps: [
      {
        id: "offer-team",
        type: "route_to_team",
        broadcastAll: true,
        responseMinutes: 10,
        offerTemplate:
          "{{trigger.contact_name}} ({{trigger.from}}) asked to speak with a person. " +
          "{{trigger.note}}\n" +
          "Reply 1 to take this conversation (first to reply wins) or 2 to pass. " +
          "Claim by {{offer.deadline}}.",
        ownerFallbackTemplate:
          "Nobody on the team claimed the human handoff for {{trigger.contact_name}} " +
          "({{trigger.from}}) within 10 minutes. {{trigger.note}}\n" +
          "Please take over the conversation.",
        claimedNotifyTemplate:
          "{{agent.name}} took the human handoff for {{trigger.contact_name}} ({{trigger.from}})."
      }
    ]
  };
}

async function resolveDb(client?: SupabaseClient): Promise<SupabaseClient> {
  return client ?? (await createSupabaseServiceClient());
}

/**
 * Create the seeded flow (enabled) if the business doesn't have one, or
 * re-enable an existing disabled one. Idempotent; throws on any DB error so
 * the toggle save fails loudly instead of silently arming a no-op.
 */
export async function ensureNeedsHumanTeamFlow(
  businessId: string,
  client?: SupabaseClient
): Promise<{ flowId: string; created: boolean }> {
  const db = await resolveDb(client);
  const { data, error } = await db
    .from("ai_flows")
    .select("id, enabled")
    .eq("business_id", businessId)
    .eq("name", NEEDS_HUMAN_TEAM_FLOW_NAME)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`ensureNeedsHumanTeamFlow: lookup: ${error.message}`);
  const existing = data as { id: string; enabled: boolean } | null;
  if (existing) {
    if (!existing.enabled) {
      const { error: enableErr } = await db
        .from("ai_flows")
        .update({ enabled: true })
        .eq("id", existing.id);
      if (enableErr) throw new Error(`ensureNeedsHumanTeamFlow: enable: ${enableErr.message}`);
    }
    return { flowId: existing.id, created: false };
  }
  const { data: inserted, error: insertErr } = await db
    .from("ai_flows")
    .insert({
      business_id: businessId,
      name: NEEDS_HUMAN_TEAM_FLOW_NAME,
      enabled: true,
      definition: parseAiFlowDefinition(needsHumanTeamFlowDefinition())
    })
    .select("id")
    .single();
  if (insertErr) throw new Error(`ensureNeedsHumanTeamFlow: insert: ${insertErr.message}`);
  return { flowId: (inserted as { id: string }).id, created: true };
}

/**
 * Enable/disable the seeded flow by its name (toggle-off path). A renamed
 * flow is simply not found — harmless, since escalateToHuman only skips the
 * owner page when a run actually enqueues.
 */
export async function setNeedsHumanTeamFlowEnabled(
  businessId: string,
  enabled: boolean,
  client?: SupabaseClient
): Promise<void> {
  const db = await resolveDb(client);
  const { error } = await db
    .from("ai_flows")
    .update({ enabled })
    .eq("business_id", businessId)
    .eq("name", NEEDS_HUMAN_TEAM_FLOW_NAME);
  if (error) throw new Error(`setNeedsHumanTeamFlowEnabled: ${error.message}`);
}

/**
 * Apply the toggle atomically-in-spirit (the settings route's single entry
 * point). ON: arm the flow FIRST, then flip the column — and if the column
 * write fails, best-effort DISARM the flow again before rethrowing, so a
 * half-applied save never leaves an enabled flow beside an OFF column
 * (which would broadcast AND page on every escalation — Bugbot, PR #801).
 * OFF: disable the flow, then clear the column; a failed column write there
 * leaves flow-disabled + column-ON, which degrades safely (zero enqueued
 * runs → escalations fall through to the direct owner page).
 */
export async function applyNeedsHumanTeamFirstSetting(
  businessId: string,
  teamFirst: boolean,
  client?: SupabaseClient
): Promise<void> {
  const db = await resolveDb(client);
  if (teamFirst) {
    await ensureNeedsHumanTeamFlow(businessId, db);
    try {
      await setNeedsHumanTeamFirst(businessId, true, db);
    } catch (e) {
      try {
        await setNeedsHumanTeamFlowEnabled(businessId, false, db);
      } catch (revertErr) {
        console.error("applyNeedsHumanTeamFirstSetting: disarm rollback", revertErr);
      }
      throw e;
    }
    return;
  }
  await setNeedsHumanTeamFlowEnabled(businessId, false, db);
  await setNeedsHumanTeamFirst(businessId, false, db);
}
