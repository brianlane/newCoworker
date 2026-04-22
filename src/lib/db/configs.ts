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
 * Idempotently set `website_md` for a business.
 *
 * Race safety: website ingestion runs fire-and-forget during checkout while the
 * onboarding assistant's drafts are being upserted through `/api/business/config`.
 * If both handlers see "no config row yet" and race on `upsertBusinessConfig`,
 * one side's empty `soul_md`/`identity_md`/`memory_md` defaults would clobber the
 * other side's real drafts. This helper avoids that by:
 *
 *   1. Inserting a row with `ignoreDuplicates: true` — a no-op if the row
 *      already exists, so it never overwrites soul/identity/memory.
 *   2. Patching only `website_md` via a targeted `update`.
 *
 * Either ordering of (website-ingest, config save) now converges to the correct
 * state: website_md is the most recent ingestion result, and soul/identity/
 * memory keep whatever the config save wrote.
 */
export async function setBusinessWebsiteMd(
  businessId: string,
  websiteMd: string,
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
  if (insertError) throw new Error(`setBusinessWebsiteMd(ensure): ${insertError.message}`);

  const { error: updateError } = await db
    .from("business_configs")
    .update({ website_md: websiteMd, updated_at: new Date().toISOString() })
    .eq("business_id", businessId);
  if (updateError) throw new Error(`setBusinessWebsiteMd(patch): ${updateError.message}`);
}

/**
 * Race-safe partial update for `business_configs`. Used by the onboarding
 * config save so it never clobbers `website_md` written by the parallel
 * fire-and-forget `/api/onboard/website-ingest` call.
 *
 * Pattern mirrors `setBusinessWebsiteMd`:
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
