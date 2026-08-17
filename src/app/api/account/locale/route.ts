/**
 * The signed-in user's dashboard language.
 *
 * USER-scoped, not business-scoped: the row is keyed on the auth user id. So
 * under admin view-as the save is retargeted at the impersonated OWNER's auth
 * user (`resolveViewAsTargetUser`): an admin setting a tenant's language
 * must change the tenant's preference, never their own. The response cookie
 * is deliberately NOT set while impersonating: it belongs to the admin's
 * browser and would flip the admin's own UI to the tenant's choice.
 */
import { z } from "zod";
import { getAuthUser } from "@/lib/auth";
import { resolveViewAsTargetUser } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getUserUiLocale, setUserUiLocale } from "@/lib/db/user-preferences";
import { defaultLocale, isAppLocale, LOCALE_COOKIE } from "@/i18n/routing";

const schema = z.object({
  locale: z.enum(["en", "es"])
});

export async function GET() {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required", 401);
    const locale = (await getUserUiLocale(user.userId)) ?? defaultLocale;
    return successResponse({ locale });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required", 401);

    const { locale } = schema.parse(await request.json());
    if (!isAppLocale(locale)) {
      return errorResponse("VALIDATION_ERROR", "Unsupported locale");
    }

    // Whose preference is this? The signed-in user's normally; the
    // impersonated owner's under view-as. A tenant whose owner_email has no
    // auth user behind it (pending/placeholder owner) has no row to write, so
    // refuse rather than silently retarget the admin's own preference.
    const target = await resolveViewAsTargetUser(user);
    if (!target.userId) {
      return errorResponse(
        "NOT_FOUND",
        "This tenant's owner has no login yet, so there is no language preference to set",
        404
      );
    }

    await setUserUiLocale(target.userId, locale);

    const response = successResponse({ locale });
    // The cookie is this BROWSER's locale. Setting it while impersonating
    // would flip the admin's own dashboard language to the tenant's pick, so
    // only a caller changing their OWN preference gets it.
    if (!target.impersonating) {
      response.cookies.set(LOCALE_COOKIE, locale, {
        path: "/",
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 365
      });
    }
    return response;
  } catch (err) {
    return handleRouteError(err);
  }
}
