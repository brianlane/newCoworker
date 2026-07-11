/**
 * Structured services catalog (BizBlasts-inspired) — DB access.
 *
 * `business_services` rows (name / duration / price / active) are edited on
 * the dashboard Settings page and rendered into
 * `business_configs.profile_md` (see renderBusinessProfileMd), which grounds
 * every surface: knowledge lookups quote exact prices, and the calendar
 * tools see real durations instead of guessing 30 minutes. Service-role-only
 * table (RLS on, no policies), same posture as business_documents.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type BusinessServiceRow = {
  id: string;
  business_id: string;
  name: string;
  description: string;
  duration_minutes: number | null;
  price_text: string;
  active: boolean;
  position: number;
  created_at: string;
  updated_at: string;
};

export async function listBusinessServices(
  businessId: string,
  client?: SupabaseClient
): Promise<BusinessServiceRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_services")
    .select()
    .eq("business_id", businessId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listBusinessServices: ${error.message}`);
  return (data ?? []) as BusinessServiceRow[];
}

export async function insertBusinessService(
  row: Pick<BusinessServiceRow, "id" | "business_id" | "name"> &
    Partial<
      Pick<BusinessServiceRow, "description" | "duration_minutes" | "price_text" | "active" | "position">
    >,
  client?: SupabaseClient
): Promise<BusinessServiceRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_services")
    .insert({ ...row })
    .select()
    .single();
  if (error) throw new Error(`insertBusinessService: ${error.message}`);
  return data as BusinessServiceRow;
}

export type BusinessServicePatch = Partial<
  Pick<BusinessServiceRow, "name" | "description" | "duration_minutes" | "price_text" | "active" | "position">
>;

/** Returns the number of rows updated (0 = no such service for this business). */
export async function patchBusinessService(
  businessId: string,
  serviceId: string,
  patch: BusinessServicePatch,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_services")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", serviceId)
    .select("id");
  if (error) throw new Error(`patchBusinessService: ${error.message}`);
  return Array.isArray(data) ? data.length : 0;
}

/** Returns the number of rows deleted (0 = no such service for this business). */
export async function deleteBusinessService(
  businessId: string,
  serviceId: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_services")
    .delete()
    .eq("business_id", businessId)
    .eq("id", serviceId)
    .select("id");
  if (error) throw new Error(`deleteBusinessService: ${error.message}`);
  return Array.isArray(data) ? data.length : 0;
}
