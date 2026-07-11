/**
 * Platform-admin configuration knobs (admin_platform_settings: key →
 * jsonb). Service-role only (RLS on, no policies); every caller must gate
 * on requireAdmin() first. First consumer: the Gemini spend-velocity alert
 * config edited from Admin → System and read by the
 * chat-spend-velocity-alerts Edge cron.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export async function getAdminPlatformSetting(
  key: string,
  client?: SupabaseClient
): Promise<unknown | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("admin_platform_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) throw new Error(`getAdminPlatformSetting: ${error.message}`);
  return data ? (data as { value: unknown }).value : null;
}

export async function upsertAdminPlatformSetting(
  key: string,
  value: unknown,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("admin_platform_settings")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(`upsertAdminPlatformSetting: ${error.message}`);
}
