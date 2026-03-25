import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { Business } from "@/lib/db/schema";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type BusinessRow = {
  id: string;
  name: string;
  owner_email: string;
  tier: "starter" | "standard" | "enterprise";
  status: "online" | "offline" | "high_load";
  hostinger_vps_id: string | null;
  created_at: string;
};

export async function createBusiness(
  data: { id: string; name: string; ownerEmail: string; tier: Business["tier"] },
  client?: SupabaseClient
): Promise<BusinessRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: row, error } = await db
    .from("businesses")
    .insert({
      id: data.id,
      name: data.name,
      owner_email: data.ownerEmail,
      tier: data.tier,
      status: "offline"
    })
    .select()
    .single();

  if (error) throw new Error(`createBusiness: ${error.message}`);
  return row as BusinessRow;
}

export async function getBusiness(id: string, client?: SupabaseClient): Promise<BusinessRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select()
    .eq("id", id)
    .single();

  if (error) return null;
  return data as BusinessRow;
}

export async function listBusinesses(client?: SupabaseClient): Promise<BusinessRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select()
    .order("created_at", { ascending: false });

  if (error) throw new Error(`listBusinesses: ${error.message}`);
  return (data ?? []) as BusinessRow[];
}

export async function updateBusinessStatus(
  id: string,
  status: BusinessRow["status"],
  vpsId?: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const update: Record<string, string> = { status };
  if (vpsId) update["hostinger_vps_id"] = vpsId;

  const { error } = await db.from("businesses").update(update).eq("id", id);
  if (error) throw new Error(`updateBusinessStatus: ${error.message}`);
}
