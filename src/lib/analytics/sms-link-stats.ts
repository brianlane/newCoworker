/**
 * Per-link SMS short-link analytics for the dashboard + CSV export.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { analyticsWindowStart } from "@/lib/analytics/dashboard-analytics";
import {
  listSmsLinksForBusiness,
  type SmsLinkClickRow,
  type SmsLinkView
} from "@/lib/db/sms-links";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type SmsLinkStatsOverview = {
  links: SmsLinkView[];
  /** True when the link scan hit its cap. */
  clipped: boolean;
};

export const SMS_LINK_STATS_SCAN_LIMIT = 500;

export async function getSmsLinkStats(
  businessId: string,
  opts: {
    client?: SupabaseClient;
    now?: Date;
    days?: number;
    flowId?: string;
  } = {}
): Promise<SmsLinkStatsOverview> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const days = opts.days ?? 30;
  const cutoffIso = analyticsWindowStart(opts.now ?? new Date(), days).toISOString();
  let query = db
    .from("sms_links")
    .select("id")
    .eq("business_id", businessId)
    .gte("created_at", cutoffIso);
  if (opts.flowId) query = query.eq("flow_id", opts.flowId);
  const { data: scan, error: scanErr } = await query
    .order("created_at", { ascending: false })
    .limit(SMS_LINK_STATS_SCAN_LIMIT + 1);
  if (scanErr) throw new Error(`getSmsLinkStats scan: ${scanErr.message}`);
  const clipped = ((scan as { id: string }[] | null) ?? []).length > SMS_LINK_STATS_SCAN_LIMIT;
  const links = await listSmsLinksForBusiness(businessId, {
    client: db,
    now: opts.now,
    days,
    flowId: opts.flowId,
    limit: SMS_LINK_STATS_SCAN_LIMIT,
    includeClicks: true
  });
  return { links, clipped };
}

export async function listLinkClickEventsForBusiness(
  businessId: string,
  opts: {
    client?: SupabaseClient;
    now?: Date;
    days?: number;
    flowId?: string;
    limit?: number;
  } = {}
): Promise<
  Array<
    SmsLinkClickRow & {
      short_code: string;
      original_url: string;
      to_e164: string | null;
      flow_id: string | null;
      run_id: string | null;
    }
  >
> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const days = opts.days ?? 30;
  const limit = opts.limit ?? 5000;
  const cutoffIso = analyticsWindowStart(opts.now ?? new Date(), days).toISOString();
  const { links } = await getSmsLinkStats(businessId, { client: db, now: opts.now, days, flowId: opts.flowId });
  const linkIds = links.map((l) => l.id);
  if (linkIds.length === 0) return [];
  const { data, error } = await db
    .from("sms_link_clicks")
    .select("id, link_id, clicked_at")
    .eq("business_id", businessId)
    .in("link_id", linkIds)
    .gte("clicked_at", cutoffIso)
    .order("clicked_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listLinkClickEventsForBusiness: ${error.message}`);
  const byId = new Map(links.map((l) => [l.id, l]));
  return ((data as SmsLinkClickRow[] | null) ?? []).map((click) => {
    const link = byId.get(click.link_id);
    return {
      ...click,
      short_code: link?.short_code ?? "",
      original_url: link?.original_url ?? "",
      to_e164: link?.to_e164 ?? null,
      flow_id: link?.flow_id ?? null,
      run_id: link?.run_id ?? null
    };
  });
}
