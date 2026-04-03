import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type NotificationPreferencesRow = {
  business_id: string;
  sms_urgent: boolean;
  email_digest: boolean;
  email_urgent: boolean;
  dashboard_alerts: boolean;
  phone_number: string | null;
  alert_email: string | null;
  updated_at: string;
};

export type NotificationPreferencesUpdate = Partial<
  Pick<
    NotificationPreferencesRow,
    | "sms_urgent"
    | "email_digest"
    | "email_urgent"
    | "dashboard_alerts"
    | "phone_number"
    | "alert_email"
  >
>;

const defaults: Omit<NotificationPreferencesRow, "business_id" | "updated_at"> = {
  sms_urgent: true,
  email_digest: true,
  email_urgent: true,
  dashboard_alerts: true,
  phone_number: null,
  alert_email: null
};

export function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "23505" ||
    error.message?.toLowerCase().includes("duplicate key") === true ||
    error.message?.toLowerCase().includes("unique constraint") === true
  );
}

export async function getNotificationPreferences(
  businessId: string,
  client?: SupabaseClient
): Promise<NotificationPreferencesRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("notification_preferences")
    .select()
    .eq("business_id", businessId)
    .maybeSingle();

  if (error) throw new Error(`getNotificationPreferences: ${error.message}`);
  return (data as NotificationPreferencesRow) ?? null;
}

export async function getOrCreateNotificationPreferences(
  businessId: string,
  client?: SupabaseClient
): Promise<NotificationPreferencesRow> {
  const existing = await getNotificationPreferences(businessId, client);
  if (existing) return existing;

  const db = client ?? (await createSupabaseServiceClient());
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("notification_preferences")
    .insert({
      business_id: businessId,
      ...defaults,
      updated_at: now
    })
    .select()
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      const concurrent = await getNotificationPreferences(businessId, db);
      if (concurrent) return concurrent;
    }
    throw new Error(`getOrCreateNotificationPreferences: ${error.message}`);
  }
  return data as NotificationPreferencesRow;
}

export async function updateNotificationPreferences(
  businessId: string,
  patch: NotificationPreferencesUpdate,
  client?: SupabaseClient
): Promise<NotificationPreferencesRow> {
  await getOrCreateNotificationPreferences(businessId, client);
  const db = client ?? (await createSupabaseServiceClient());
  const now = new Date().toISOString();

  const keys: (keyof NotificationPreferencesUpdate)[] = [
    "sms_urgent",
    "email_digest",
    "email_urgent",
    "dashboard_alerts",
    "phone_number",
    "alert_email"
  ];
  const update: Record<string, unknown> = { updated_at: now };
  for (const key of keys) {
    const v = patch[key];
    if (v !== undefined) {
      update[key] = v;
    }
  }

  const { data, error } = await db
    .from("notification_preferences")
    .update(update)
    .eq("business_id", businessId)
    .select()
    .single();

  if (error) throw new Error(`updateNotificationPreferences: ${error.message}`);
  return data as NotificationPreferencesRow;
}
