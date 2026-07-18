import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale, isAppLocale } from "@/i18n/routing";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * The user's explicitly saved UI locale, or null when they never saved one.
 * Null matters: resolveUiLocale must fall through to the NEXT_LOCALE cookie
 * (e.g. Spanish picked on marketing pages before signing in) instead of
 * treating a missing row as an explicit English choice.
 */
export async function getUserUiLocale(
  userId: string,
  client?: SupabaseClient
): Promise<AppLocale | null> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { data, error } = await db
      .from("user_preferences")
      .select("ui_locale")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const raw = (data as { ui_locale?: string } | null)?.ui_locale;
    return isAppLocale(raw) ? raw : null;
  } catch (err) {
    logger.warn("getUserUiLocale failed; treating as no saved preference", {
      userId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
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
