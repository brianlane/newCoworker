/**
 * Node-side entry point for platform lifecycle stage tagging (see
 * supabase/functions/_shared/pipelines/lifecycle.ts for the mechanics and
 * the five loop brakes).
 *
 * The Deno worker and inbound webhooks call applyLifecycleStage directly;
 * app-side surfaces (calendar-tool and booking-page bookings) go through
 * this wrapper, which normalizes the lead phone, supplies the service-role
 * client, and stays best-effort, a stage tag must never break the booking
 * that discovered it. Mirrors src/lib/ai-flows/goal-hooks.ts, which sits
 * beside it at every call site.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  applyLifecycleStage,
  type ApplyLifecycleStageOptions,
  type LifecycleStageOutcome
} from "../../../supabase/functions/_shared/pipelines/lifecycle";
import type { LifecycleEvent } from "../../../supabase/functions/_shared/pipelines/stages";
import { isE164, normalizeNanpToE164 } from "../../../supabase/functions/_shared/ai_flows/engine";

export type { LifecycleEvent, LifecycleStageOutcome };

/**
 * Advance a lead to the stage this lifecycle event implies. `phone` may be
 * raw user input (E.164 or a loose NANP number); an unusable phone is a
 * silent no-op, a missing lead phone is a data gap, not an error.
 */
export async function fireLifecycleStage(
  businessId: string,
  phone: string | null | undefined,
  event: LifecycleEvent,
  opts: ApplyLifecycleStageOptions
): Promise<LifecycleStageOutcome> {
  const raw = (phone ?? "").trim();
  if (!raw) return "no_contact";
  const e164 = isE164(raw) ? raw : normalizeNanpToE164(raw);
  if (!e164) return "no_contact";
  try {
    const db = await createSupabaseServiceClient();
    return await applyLifecycleStage(db, businessId, e164, event, opts);
  } catch (e) {
    // applyLifecycleStage itself never throws; this guards client construction.
    console.error("fireLifecycleStage", e);
    return "no_change";
  }
}
