import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale, isAppLocale } from "@/i18n/routing";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export async function getUserUiLocale(
  userId: string,
  client?: SupabaseClient
): Promise<AppLocale> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { data, error } = await db
      .from("user_preferences")
      .select("ui_locale")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const raw = (data as { ui_locale?: string } | null)?.ui_locale;
    return isAppLocale(raw) ? raw : defaultLocale;
  } catch (err) {
    logger.warn("getUserUiLocale failed; defaulting to en", {
      userId,
      error: err instanceof Error ? err.message : String(err)
    });
    return defaultLocale;
  }
}

export async function setUserUiLocale(
  userId: string,
  locale: AppLocale,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("user_preferences").upsert(
    {
      user_id: userId,
      ui_locale: locale,
      updated_at: new Date().toISOString()
    },
    { onConflict: "user_id" }
  );
  if (error) throw new Error(error.message);
}
