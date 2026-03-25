import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type NotificationRow = {
  id: string;
  business_id: string;
  delivery_channel: "sms" | "email" | "dashboard";
  status: "queued" | "sent" | "failed";
  payload: Record<string, unknown>;
  created_at: string;
};

export async function insertNotification(
  data: Omit<NotificationRow, "created_at">,
  client?: SupabaseClient
): Promise<NotificationRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: row, error } = await db
    .from("notifications")
    .insert(data)
    .select()
    .single();

  if (error) throw new Error(`insertNotification: ${error.message}`);
  return row as NotificationRow;
}

export async function getNotifications(
  businessId: string,
  limit = 20,
  client?: SupabaseClient
): Promise<NotificationRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("notifications")
    .select()
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`getNotifications: ${error.message}`);
  return (data ?? []) as NotificationRow[];
}
