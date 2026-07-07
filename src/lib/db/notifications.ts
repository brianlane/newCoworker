import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { countMovedRows, isVpsReadMode, readMovedRows } from "@/lib/residency/read";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type NotificationDeliveryChannel = "sms" | "email" | "dashboard";
export type NotificationStatus = "queued" | "sent" | "failed" | "skipped";

export type NotificationRow = {
  id: string;
  business_id: string;
  delivery_channel: NotificationDeliveryChannel;
  status: NotificationStatus;
  payload: Record<string, unknown>;
  created_at: string;
  /** Null until the owner views/dismisses; partial index keeps unread count fast. */
  read_at: string | null;
  /** High-level event class (urgent_alert, voice_capture, digest, …). */
  kind: string | null;
  /** Human-readable headline for the dashboard list and bell dropdown. */
  summary: string | null;
};

export type InsertNotificationInput = Omit<
  NotificationRow,
  "created_at" | "read_at" | "kind" | "summary"
> & {
  read_at?: string | null;
  kind?: string | null;
  summary?: string | null;
};

export async function insertNotification(
  data: InsertNotificationInput,
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

export type ListNotificationsOptions = {
  limit?: number;
  unreadOnly?: boolean;
};

export async function getNotifications(
  businessId: string,
  limitOrOptions: number | ListNotificationsOptions = 20,
  client?: SupabaseClient
): Promise<NotificationRow[]> {
  const opts: ListNotificationsOptions =
    typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
  const limit = opts.limit ?? 20;
  const db = client ?? (await createSupabaseServiceClient());
    const vpsReadMode = await isVpsReadMode(businessId, db);
  if (vpsReadMode) {
    return await readMovedRows<NotificationRow>(businessId, {
      table: "notifications",
      filters: [
        { column: "business_id", op: "eq", value: businessId },
        ...(opts.unreadOnly ? [{ column: "read_at", op: "is" as const, value: null }] : [])
      ],
      order: [{ column: "created_at", ascending: false }],
      limit
    });
  }
  let q = db
    .from("notifications")
    .select()
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  if (opts.unreadOnly) {
    q = q.is("read_at", null);
  }
  q = q.limit(limit);
  const { data, error } = await q;

  if (error) throw new Error(`getNotifications: ${error.message}`);
  return (data ?? []) as NotificationRow[];
}

/**
 * Cheap count for the sidebar bell badge. The
 * `notifications_business_unread_idx` partial index keeps this O(N_unread)
 * per business, not O(N_total).
 *
 * Only counts `status='sent'` rows. The dispatcher writes audit rows for
 * every channel attempted (`skipped` when a toggle is off / no recipient,
 * `failed` when the upstream provider errors). Including those in the
 * unread count would inflate the bell badge — an unsubscribed owner would
 * see +3 every urgent event despite having opted out — so the badge tracks
 * "things actually delivered to you" only. The full list view still shows
 * every row regardless of status so the dashboard is the audit source of
 * truth.
 */
export async function getUnreadNotificationCount(
  businessId: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
    const vpsReadMode = await isVpsReadMode(businessId, db);
  if (vpsReadMode) {
    return await countMovedRows(businessId, {
      table: "notifications",
      filters: [
        { column: "business_id", op: "eq", value: businessId },
        { column: "status", op: "eq", value: "sent" },
        { column: "read_at", op: "is", value: null }
      ]
    });
  }
  const { count, error } = await db
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("status", "sent")
    .is("read_at", null);

  if (error) throw new Error(`getUnreadNotificationCount: ${error.message}`);
  return count ?? 0;
}

export async function markNotificationRead(
  notificationId: string,
  businessId: string,
  client?: SupabaseClient
): Promise<NotificationRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .eq("business_id", businessId)
    .is("read_at", null)
    .select()
    .maybeSingle();

  if (error) throw new Error(`markNotificationRead: ${error.message}`);
  return (data as NotificationRow | null) ?? null;
}

export async function markAllNotificationsRead(
  businessId: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .is("read_at", null)
    .select("id");

  if (error) throw new Error(`markAllNotificationsRead: ${error.message}`);
  return (data ?? []).length;
}
