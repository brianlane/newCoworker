/**
 * Node-side entry point for AiFlow Goal Events (the GHL-style "jump to the
 * goal once the milestone lands" behavior — see
 * supabase/functions/_shared/ai_flows/goal_events.ts for the mechanics).
 *
 * The Deno webhooks/worker call applyGoalEvent directly; app-side surfaces
 * (calendar-tool bookings, dashboard contact edits) go through this wrapper,
 * which normalizes the lead phone, supplies the service-role client, and
 * stays best-effort — a goal failure must never break the hosting request.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  applyGoalEvent,
  type ObservedGoalEvent
} from "../../../supabase/functions/_shared/ai_flows/goal_events";
import { isE164, normalizeNanpToE164 } from "../../../supabase/functions/_shared/ai_flows/engine";

export type { ObservedGoalEvent };

/**
 * Fire one observed milestone for a lead. `phone` may be raw user input
 * (E.164 or a loose NANP number); an unusable phone is a silent no-op — a
 * missing lead phone is a data gap, not an error.
 */
export async function fireGoalEvent(
  businessId: string,
  phone: string | null | undefined,
  event: ObservedGoalEvent
): Promise<void> {
  const raw = (phone ?? "").trim();
  if (!raw) return;
  const e164 = isE164(raw) ? raw : normalizeNanpToE164(raw);
  if (!e164) return;
  try {
    const db = await createSupabaseServiceClient();
    await applyGoalEvent(db, businessId, e164, event);
  } catch (e) {
    // applyGoalEvent itself never throws; this guards client construction.
    console.error("fireGoalEvent", e);
  }
}
