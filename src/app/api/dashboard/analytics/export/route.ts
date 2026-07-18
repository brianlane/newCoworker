/**
 * Analytics CSV export (BizBlasts ExportService analog).
 *
 * GET /api/dashboard/analytics/export?businessId=<uuid>&kind=daily|flows|links|link_clicks
 *   → text/csv attachment
 *
 * `daily` — the 30-day volume series (date, calls, texts, voice minutes)
 * `flows` — the per-flow conversion funnel (runs → texts → clicks → goals)
 * `links` — one row per tracked short link (aggregates)
 * `link_clicks` — one row per click event
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
import {
  getSmsLinkStats,
  listLinkClickEventsForBusiness
} from "@/lib/analytics/sms-link-stats";
import { dailySeriesCsv, flowFunnelsCsv, smsLinkClicksCsv, smsLinksCsv } from "@/lib/analytics/export";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  businessId: z.string().uuid(),
  kind: z.enum(["daily", "flows", "links", "link_clicks"]).default("daily"),
  flowId: z.string().uuid().optional()
});

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      businessId: url.searchParams.get("businessId") ?? "",
      kind: url.searchParams.get("kind") ?? "daily",
      flowId: url.searchParams.get("flowId") ?? undefined
    });
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", "businessId (uuid) is required");
    }
    const { businessId, kind } = parsed.data;
    const flowId = parsed.data.flowId;
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

    // One shared instant per request, mirroring the analytics page's shared
    // `now`, so a download describes exactly one day-aligned window.
    const now = new Date();
    let csv: string;
    let filename: string;
    if (kind === "flows") {
      const funnels = await getFlowFunnels(businessId, { client: db, now });
      csv = flowFunnelsCsv(funnels.rows, funnels.clipped);
      filename = "flow-performance-30d.csv";
    } else if (kind === "links") {
      const stats = await getSmsLinkStats(businessId, { client: db, now, flowId });
      csv = smsLinksCsv(
        stats.links.map((l) => ({
          shortCode: l.short_code,
          originalUrl: l.original_url,
          toE164: l.to_e164,
          flowName: l.flowName,
          clickCount: l.click_count,
          firstClickedAt: l.first_clicked_at,
          lastClickedAt: l.last_clicked_at,
          createdAt: l.created_at
        })),
        stats.clipped
      );
      filename = flowId ? `tracked-links-30d-flow-${flowId.slice(0, 8)}.csv` : "tracked-links-30d.csv";
    } else if (kind === "link_clicks") {
      const { events, clipped } = await listLinkClickEventsForBusiness(businessId, {
        client: db,
        now,
        flowId
      });
      csv = smsLinkClicksCsv(
        events.map((e) => ({
          clickedAt: e.clicked_at,
          shortCode: e.short_code,
          originalUrl: e.original_url,
          toE164: e.to_e164,
          flowId: e.flow_id,
          runId: e.run_id,
          likelyPrefetch: e.likely_prefetch
        })),
        clipped
      );
      filename = flowId ? `link-clicks-30d-flow-${flowId.slice(0, 8)}.csv` : "link-clicks-30d.csv";
    } else {
      const series = await getDailyUsageSeries(businessId, { client: db, now });
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
