import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { findAuthUserIdByEmail } from "@/lib/auth";
import { getUserUiLocale } from "@/lib/db/user-preferences";

/** Resolve owner UI locale from login email (businesses have no stable owner_user_id). */
export async function resolveOwnerUiLocaleForEmail(
  email: string | null | undefined
): Promise<AppLocale> {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return defaultLocale;
  try {
    const userId = await findAuthUserIdByEmail(normalized);
    if (!userId) return defaultLocale;
    return (await getUserUiLocale(userId)) ?? defaultLocale;
  } catch {
    return defaultLocale;
  }
}
