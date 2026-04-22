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

export async function updateBusinessWebsiteMd(
  businessId: string,
  websiteMd: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("business_configs")
    .update({ website_md: websiteMd, updated_at: new Date().toISOString() })
    .eq("business_id", businessId);
  if (error) throw new Error(`updateBusinessWebsiteMd: ${error.message}`);
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
