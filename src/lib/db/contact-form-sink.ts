/**
 * Platform contact-form sink (`businesses.contact_form_sink`).
 *
 * At most ONE business — the internal HQ dogfood tenant — can be designated
 * to receive public /contact submissions as webhook-channel AiFlow events
 * (source "contact_form"), so the company's own coworker can triage them.
 * Enforced by the partial unique index `uq_businesses_contact_form_sink`;
 * flipped from the admin business page via POST /api/admin/contact-form-sink.
 *
 * No sink designated = the contact route's pre-existing email-only behavior.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * Unconditional-await client resolution: `client ?? (await create…())` inline
 * would make the following statements a conditional continuation block, which
 * v8 coverage mis-attributes when a branch follows (negative implicit-else
 * counts). Resolving through one always-awaited helper keeps the accounting
 * honest.
 */
async function resolveClient(client?: SupabaseClient): Promise<SupabaseClient> {
  return client ?? (await createSupabaseServiceClient());
}

/** The business currently designated as the sink, or null when none is. */
export async function getContactFormSinkBusinessId(
  client?: SupabaseClient
): Promise<string | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("id")
    .eq("contact_form_sink", true)
    .maybeSingle();
  if (error) throw new Error(`getContactFormSinkBusinessId: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Designate (or undesignate) a business as the platform contact-form sink.
 *
 * Enabling first clears any OTHER sink so the partial unique index never
 * rejects the write — two sequential statements, not a transaction, which is
 * fine for an admin-only, low-frequency toggle: the worst interleaving of
 * two concurrent enables leaves exactly one sink (the index guarantees it),
 * never two.
 */
export async function setContactFormSink(
  businessId: string,
  enabled: boolean,
  client?: SupabaseClient
): Promise<void> {
  const db = await resolveClient(client);
  if (enabled) {
    const { error: clearErr } = await db
      .from("businesses")
      .update({ contact_form_sink: false })
      .eq("contact_form_sink", true)
      .neq("id", businessId);
    if (clearErr) throw new Error(`setContactFormSink clear: ${clearErr.message}`);
  }
  const { error } = await db
    .from("businesses")
    .update({ contact_form_sink: enabled })
    .eq("id", businessId);
  if (error) throw new Error(`setContactFormSink: ${error.message}`);
}
