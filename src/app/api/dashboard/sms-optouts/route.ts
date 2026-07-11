/**
 * Owner-facing SMS opt-out (STOP list) management.
 *
 * GET  ?businessId= — list suppressed numbers (with contact names resolved
 *      for display) so owners have compliance visibility into who can't be
 *      texted.
 * POST { businessId, e164 } — proactively suppress a number ("never text
 *      this person"). There is NO owner-facing removal: a customer's STOP
 *      holds until they text START themselves.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listSmsOptOuts, setSmsOptOut } from "@/lib/sms/opt-outs";
import { resolveContactNames, type ContactName } from "@/lib/db/contact-names";
import { normalizeContactNumber } from "@/lib/telnyx/format";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const parsed = z.string().uuid().safeParse(url.searchParams.get("businessId"));
    if (!parsed.success) return errorResponse("VALIDATION_ERROR", "businessId is required");

    await requireBusinessRole(parsed.data, "manage_settings");

    const db = await createSupabaseServiceClient();
    const rows = await listSmsOptOuts(parsed.data, db);

    // Display-only name resolution; a resolver failure leaves raw numbers.
    let names = new Map<string, ContactName>();
    if (rows.length > 0) {
      names = await resolveContactNames(
        parsed.data,
        rows.map((r) => r.sender_e164),
        db
      ).catch(() => new Map<string, ContactName>());
    }

    return successResponse({
      optOuts: rows.map((r) => ({
        e164: r.sender_e164,
        name: names.get(r.sender_e164)?.name ?? null,
        setAt: r.set_at
      }))
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

const postSchema = z.object({
  businessId: z.string().uuid(),
  e164: z.string().transform((val, ctx) => {
    const result = normalizeContactNumber(val);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.reason });
      return z.NEVER;
    }
    return result.value;
  })
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    // requireBusinessRole passes admins through — keep view-as read-only.
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }

    const body = postSchema.parse(await request.json());
    await requireBusinessRole(body.businessId, "manage_settings");

    const db = await createSupabaseServiceClient();
    const { isNew } = await setSmsOptOut(body.businessId, body.e164, db);
    return successResponse({ e164: body.e164, isNew });
  } catch (err) {
    return handleRouteError(err);
  }
}
