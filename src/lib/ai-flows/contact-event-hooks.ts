/**
 * Node-side entry point for AiFlow contact-event triggers (contact_created /
 * tag_changed / owner_assigned — see
 * supabase/functions/_shared/ai_flows/contact_events.ts for the mechanics).
 *
 * The Deno worker calls enqueueContactEventRuns directly; app-side surfaces
 * (contact creation, dashboard tag/owner edits, CSV import) go through this
 * wrapper, which supplies the service-role client and stays best-effort — a
 * trigger failure must never break the contact write that observed it.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  enqueueContactEventRuns,
  type ContactEventInput
} from "../../../supabase/functions/_shared/ai_flows/contact_events";

export type { ContactEventInput };

/** Fire one contact event. Never throws. */
export async function fireContactEvent(
  businessId: string,
  input: ContactEventInput
): Promise<void> {
  try {
    const db = await createSupabaseServiceClient();
    await enqueueContactEventRuns(db, businessId, input);
  } catch (e) {
    // enqueueContactEventRuns itself never throws; this guards client construction.
    console.error("fireContactEvent", e);
  }
}
