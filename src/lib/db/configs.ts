import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ConfigRow = {
  business_id: string;
  soul_md: string;
  identity_md: string;
  memory_md: string;
  website_md: string;
  rowboat_project_id?: string | null;
  updated_at: string;
};

export async function upsertBusinessConfig(
  data: Omit<ConfigRow, "updated_at" | "website_md"> & { website_md?: string },
  client?: SupabaseClient
): Promise<ConfigRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: row, error } = await db
    .from("business_configs")
    .upsert({
      ...data,
      website_md: data.website_md ?? "",
      updated_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) throw new Error(`upsertBusinessConfig: ${error.message}`);
  return row as ConfigRow;
}

/**
 * Race-safe partial update for `business_configs`. Used by the onboarding
 * config save and the website-ingest handler so they never clobber fields
 * owned by the other writer during the fire-and-forget window after checkout.
 *
 *   1. `upsert({...empty}, { ignoreDuplicates: true })` creates the row if
 *      it doesn't exist, and is a no-op if it does — so fields owned by other
 *      writers (website_md, soul_md, etc.) are never overwritten here.
 *   2. A targeted `update` patches only the fields the caller provided.
 */
export async function patchBusinessConfig(
  businessId: string,
  patch: {
    soul_md?: string;
    identity_md?: string;
    memory_md?: string;
    website_md?: string;
  },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const now = new Date().toISOString();
  const { error: insertError } = await db
    .from("business_configs")
    .upsert(
      {
        business_id: businessId,
        soul_md: "",
        identity_md: "",
        memory_md: "",
        website_md: "",
        updated_at: now
      },
      { onConflict: "business_id", ignoreDuplicates: true }
    );
  if (insertError) throw new Error(`patchBusinessConfig(ensure): ${insertError.message}`);

  const updatePayload: Record<string, string> = { updated_at: new Date().toISOString() };
  if (patch.soul_md !== undefined) updatePayload.soul_md = patch.soul_md;
  if (patch.identity_md !== undefined) updatePayload.identity_md = patch.identity_md;
  if (patch.memory_md !== undefined) updatePayload.memory_md = patch.memory_md;
  if (patch.website_md !== undefined) updatePayload.website_md = patch.website_md;

  const { error: updateError } = await db
    .from("business_configs")
    .update(updatePayload)
    .eq("business_id", businessId);
  if (updateError) throw new Error(`patchBusinessConfig(patch): ${updateError.message}`);
}

/**
 * Convenience wrapper: idempotently set only `website_md` via
 * `patchBusinessConfig`. Kept as a named export because the website-ingest
 * handler and its tests both import this verb directly — collapsing it to a
 * thin delegate removes the duplicated skeleton-upsert logic that used to
 * live here while preserving the call-site API.
 */
export async function setBusinessWebsiteMd(
  businessId: string,
  websiteMd: string,
  client?: SupabaseClient
): Promise<void> {
  await patchBusinessConfig(businessId, { website_md: websiteMd }, client);
}

export async function getBusinessConfig(
  businessId: string,
  client?: SupabaseClient
): Promise<ConfigRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_configs")
    .select()
    .eq("business_id", businessId)
    .single();

  if (error) return null;
  return data as ConfigRow;
}
