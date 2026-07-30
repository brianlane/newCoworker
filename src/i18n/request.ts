import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { defaultLocale, isAppLocale, LOCALE_COOKIE } from "@/i18n/routing";
import { getAuthUser } from "@/lib/auth";
import { getUserUiLocale } from "@/lib/db/user-preferences";
import { resolveUiLocale } from "@/lib/i18n/resolve-locale";

function hasSupabaseSessionCookie(
  cookieStore: Awaited<ReturnType<typeof cookies>>
): boolean {
  // Supabase SSR stores the session as `sb-<ref>-auth-token` (possibly
  // chunked as `.0`, `.1`, ...). Anonymous marketing scrapes have none of
  // these and must not pay for getAuthUser + a preferences round-trip on
  // every GET (see 2026-07-30 function-invocation spike).
  return cookieStore.getAll().some((cookie) => cookie.name.startsWith("sb-"));
}

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value ?? null;

  let savedPreference: string | null = null;
  if (hasSupabaseSessionCookie(cookieStore)) {
    try {
      const user = await getAuthUser();
      if (user) {
        savedPreference = await getUserUiLocale(user.userId);
      }
    } catch {
      /* auth/db unavailable: fall through to cookie/default */
    }
  }

  const headerStore = await headers();
  const locale = resolveUiLocale({
    savedPreference,
    cookieLocale,
    acceptLanguage: headerStore.get("accept-language")
  });

  return {
    locale: isAppLocale(locale) ? locale : defaultLocale,
    messages: (await import(`../../messages/${locale}.json`)).default
  };
});
