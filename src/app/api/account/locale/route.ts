import { z } from "zod";
import { getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
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
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }

    const { locale } = schema.parse(await request.json());
    if (!isAppLocale(locale)) {
      return errorResponse("VALIDATION_ERROR", "Unsupported locale");
    }

    await setUserUiLocale(user.userId, locale);

    const response = successResponse({ locale });
    response.cookies.set(LOCALE_COOKIE, locale, {
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365
    });
    return response;
  } catch (err) {
    return handleRouteError(err);
  }
}
