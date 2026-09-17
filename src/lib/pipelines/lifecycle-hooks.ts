/**
 * Node-side entry point for platform lifecycle stage tagging (see
 * supabase/functions/_shared/pipelines/lifecycle.ts for the mechanics and
 * the five loop brakes).
 *
 * The Deno worker and inbound webhooks call applyLifecycleStage directly;
 * app-side surfaces (calendar-tool and booking-page bookings, meeting
 * minutes) go through this wrapper, which normalizes the lead's contact key,
 * supplies the service-role client, and stays best-effort, a stage tag must
 * never break the booking that discovered it. Mirrors
 * src/lib/ai-flows/goal-hooks.ts, which sits beside it at every call site.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  applyLifecycleStage,
  type ApplyLifecycleStageOptions,
  type LifecycleStageOutcome
} from "../../../supabase/functions/_shared/pipelines/lifecycle";
import type { LifecycleEvent } from "../../../supabase/functions/_shared/pipelines/stages";
import { classifyContactKey } from "../../../supabase/functions/_shared/contact_key";
import { coerceDialableE164 } from "../../../supabase/functions/_shared/ai_flows/engine";

export type { LifecycleEvent, LifecycleStageOutcome };

/**
 * Advance a lead to the stage this lifecycle event implies.
 *
 * `contactKey` may be raw user input (E.164, a formatted international
 * number, a loose NANP number) or a stored contact key. A VALID `email:`
 * key passes through UNNORMALIZED: it is already canonical
 * (emailContactKey lowercases at the boundary), it is not a number to be
 * reshaped, and refusing it here was why an email-only lead never reached
 * a board. `classifyContactKey` rather than `isEmailContactKey` on purpose:
 * the former validates the address behind the prefix, so a malformed
 * `email:` string is refused here instead of becoming a query that matches
 * nothing. An unusable key is a silent no-op, a missing lead key is a data
 * gap, not an error.
 *
 * Phone keys go through `coerceDialableE164`, not `isE164` then NANP. The
 * short-circuit dropped formatted non-US numbers ("+61 415 972 868"):
 * spaces fail isE164, and the NANP fallback cannot see +61, so the
 * Contacted reconcile treated an already-filed outreach prospect as
 * "no contact" and left them on New Lead.
 */
export async function fireLifecycleStage(
  businessId: string,
  contactKey: string | null | undefined,
  event: LifecycleEvent,
  opts: ApplyLifecycleStageOptions
): Promise<LifecycleStageOutcome> {
  const raw = (contactKey ?? "").trim();
  if (!raw) return "no_contact";
  const resolved =
    classifyContactKey(raw) === "email" ? raw : coerceDialableE164(raw);
  if (!resolved) return "no_contact";
  try {
    const db = await createSupabaseServiceClient();
    return await applyLifecycleStage(db, businessId, resolved, event, opts);
  } catch (e) {
    // applyLifecycleStage itself never throws; this guards client construction.
    console.error("fireLifecycleStage", e);
    return "no_change";
  }
}
