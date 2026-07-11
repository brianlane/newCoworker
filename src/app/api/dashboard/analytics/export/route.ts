/**
 * Analytics CSV export (BizBlasts ExportService analog).
 *
 * GET /api/dashboard/analytics/export?businessId=<uuid>&kind=daily|flows
 *   → text/csv attachment
 *
 * `daily` — the 30-day volume series (date, calls, texts, voice minutes)
 * `flows` — the per-flow conversion funnel (runs → texts → clicks → goals)
 *
 * Auth mirrors the analytics page: any dashboard role on the business
 * (view_dashboard), admins bypass; tier-gated like the page itself.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { analyticsAllowedForTier } from "@/lib/plans/analytics";
import { getDailyUsageSeries } from "@/lib/analytics/dashboard-analytics";
import { getFlowFunnels } from "@/lib/analytics/flow-funnels";
import { dailySeriesCsv, flowFunnelsCsv } from "@/lib/analytics/export";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  businessId: z.string().uuid(),
  kind: z.enum(["daily", "flows"]).default("daily")
});

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      businessId: url.searchParams.get("businessId") ?? "",
      kind: url.searchParams.get("kind") ?? "daily"
    });
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", "businessId (uuid) is required");
    }
    const { businessId, kind } = parsed.data;
    if (!user.isAdmin) await requireBusinessRole(businessId, "view_dashboard");

    const db = await createSupabaseServiceClient();
    const { data: business, error } = await db
      .from("businesses")
      .select("tier")
      .eq("id", businessId)
      .maybeSingle();
    if (error) return errorResponse("INTERNAL_SERVER_ERROR", "Lookup failed", 500);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");
    if (!analyticsAllowedForTier((business as { tier: string | null }).tier)) {
      return errorResponse("FORBIDDEN", "Analytics requires the Standard plan", 403);
    }

    let csv: string;
    let filename: string;
    if (kind === "flows") {
      const funnels = await getFlowFunnels(businessId, { client: db });
      csv = flowFunnelsCsv(funnels.rows, funnels.clipped);
      filename = "flow-performance-30d.csv";
    } else {
      const series = await getDailyUsageSeries(businessId, { client: db });
      csv = dailySeriesCsv(series.days, series.clipped);
      filename = "analytics-daily-30d.csv";
    }
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store"
      }
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
