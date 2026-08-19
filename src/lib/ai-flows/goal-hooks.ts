/**
 * Node-side entry point for AiFlow Goal Events (the GHL-style "jump to the
 * goal once the milestone lands" behavior, see
 * supabase/functions/_shared/ai_flows/goal_events.ts for the mechanics).
 *
 * The Deno webhooks/worker call applyGoalEvent directly; app-side surfaces
 * (calendar-tool bookings, dashboard contact edits) go through this wrapper,
 * which normalizes the lead phone, supplies the service-role client, and
 * stays best-effort, a goal failure must never break the hosting request.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  applyGoalEvent,
  type ObservedGoalEvent
} from "../../../supabase/functions/_shared/ai_flows/goal_events";
import { isE164, normalizeNanpToE164 } from "../../../supabase/functions/_shared/ai_flows/engine";
import {
  contactKeyEmail,
  emailContactKey
} from "../../../supabase/functions/_shared/contact_key";

export type { ObservedGoalEvent };

/**
 * Fire one observed milestone for a lead, identified by whatever we have.
 *
 * `identity` may be raw user input: an E.164 number, a loose NANP number, a
 * contact key (including the `email:` form the dashboard passes for an
 * email-only contact), or a bare email address. An unusable value is a silent
 * no-op, since a missing lead identity is a data gap, not an error.
 *
 * The email forms matter because a lead with no phone still books, still gets
 * tagged, and still has runs to fast-forward. Before this they were dropped
 * here, one level above the matching: the milestone never fired at all, so a
 * phoneless lead who booked kept receiving follow-ups.
 */
export async function fireGoalEvent(
  businessId: string,
  identity: string | null | undefined,
  event: ObservedGoalEvent
): Promise<void> {
  const raw = (identity ?? "").trim();
  if (!raw) return;
  const resolved = isE164(raw)
    ? raw
    : (normalizeNanpToE164(raw) ?? emailContactKey(contactKeyEmail(raw) ?? raw));
  if (!resolved) return;
  try {
    const db = await createSupabaseServiceClient();
    await applyGoalEvent(db, businessId, resolved, event);
  } catch (e) {
    // applyGoalEvent itself never throws; this guards client construction.
    console.error("fireGoalEvent", e);
  }
}
