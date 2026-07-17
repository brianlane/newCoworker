/**
 * Tracked SMS short-link reads for the owner dashboard.
 *
 * `sms_links` and `sms_link_clicks` are central-only (service-role reads).
 * Outbound log pairing uses `sms_outbound_log_id` when set; older rows fall
 * back to `run_id` + timestamp heuristics in the UI.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { analyticsWindowStart } from "@/lib/analytics/dashboard-analytics";
import { resolveContactNames } from "@/lib/db/contact-names";
import { shortLinkUrl } from "../../../supabase/functions/_shared/sms_short_links";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

const SMS_LINK_SELECT =
  "id, business_id, short_code, original_url, to_e164, source, flow_id, run_id, sms_outbound_log_id, click_count, first_clicked_at, last_clicked_at, created_at";

export type SmsLinkRow = {
  id: string;
  business_id: string;
  short_code: string;
  original_url: string;
  to_e164: string | null;
  source: string;
  flow_id: string | null;
  run_id: string | null;
  sms_outbound_log_id: string | null;
  click_count: number;
  first_clicked_at: string | null;
  last_clicked_at: string | null;
  created_at: string;
};

export type SmsLinkClickRow = {
  id: string;
  link_id: string;
  clicked_at: string;
};

export type SmsLinkView = SmsLinkRow & {
  shortUrl: string;
  contactName: string | null;
  flowName: string | null;
  clicks: SmsLinkClickRow[];
};

export const DEFAULT_LINK_CLICKS_LIMIT = 20;

function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

function daysCutoff(days: number, now = new Date()): string {
  return analyticsWindowStart(now, days).toISOString();
}

async function fetchFlowNames(
  businessId: string,
  flowIds: string[],
  client: SupabaseClient
): Promise<Map<string, string>> {
  const unique = [...new Set(flowIds.filter(Boolean))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const { data, error } = await client
    .from("ai_flows")
    .select("id, name")
    .eq("business_id", businessId)
    .in("id", unique);
  if (error) throw new Error(`fetchFlowNames: ${error.message}`);
  for (const row of (data as { id: string; name: string }[] | null) ?? []) {
    out.set(row.id, row.name);
  }
  return out;
}

// Only called from enrichLinks with a non-empty id list.
async function fetchClickEvents(
  linkIds: string[],
  client: SupabaseClient,
  limit = DEFAULT_LINK_CLICKS_LIMIT
): Promise<Map<string, SmsLinkClickRow[]>> {
  const out = new Map<string, SmsLinkClickRow[]>();
  const { data, error } = await client
    .from("sms_link_clicks")
    .select("id, link_id, clicked_at")
    .in("link_id", linkIds)
    .order("clicked_at", { ascending: false })
    .limit(linkIds.length * limit);
  if (error) throw new Error(`fetchClickEvents: ${error.message}`);
  for (const row of (data as SmsLinkClickRow[] | null) ?? []) {
    const list = out.get(row.link_id) ?? [];
    if (list.length < limit) list.push(row);
    out.set(row.link_id, list);
  }
  return out;
}

async function enrichLinks(
  businessId: string,
  rows: SmsLinkRow[],
  client: SupabaseClient,
  opts: { includeClicks?: boolean } = {}
): Promise<SmsLinkView[]> {
  if (rows.length === 0) return [];
  const base = appBaseUrl();
  const flowNames = await fetchFlowNames(
    businessId,
    rows.map((r) => r.flow_id).filter((id): id is string => Boolean(id)),
    client
  );
  const numbers = [...new Set(rows.map((r) => r.to_e164).filter((n): n is string => Boolean(n)))];
  const contactNames =
    numbers.length > 0
      ? await resolveContactNames(businessId, numbers, client).catch(() => new Map())
      : new Map();
  const clicksByLink = opts.includeClicks
    ? await fetchClickEvents(
        rows.map((r) => r.id),
        client
      )
    : new Map<string, SmsLinkClickRow[]>();

  return rows.map((row) => ({
    ...row,
    shortUrl: shortLinkUrl(base, row.short_code),
    contactName: row.to_e164 ? contactNames.get(row.to_e164)?.name ?? null : null,
    flowName: row.flow_id ? flowNames.get(row.flow_id) ?? null : null,
    clicks: clicksByLink.get(row.id) ?? []
  }));
}

export async function listClickEventsForLink(
  linkId: string,
  opts: { limit?: number; client?: SupabaseClient } = {}
): Promise<SmsLinkClickRow[]> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const limit = opts.limit ?? DEFAULT_LINK_CLICKS_LIMIT;
  const { data, error } = await db
    .from("sms_link_clicks")
    .select("id, link_id, clicked_at")
    .eq("link_id", linkId)
    .order("clicked_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listClickEventsForLink: ${error.message}`);
  return (data as SmsLinkClickRow[] | null) ?? [];
}

export async function listSmsLinksByOutboundLogIds(
  businessId: string,
  outboundLogIds: string[],
  opts: { includeClicks?: boolean; client?: SupabaseClient } = {}
): Promise<SmsLinkView[]> {
  const ids = [...new Set(outboundLogIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const db = opts.client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("sms_links")
    .select(SMS_LINK_SELECT)
    .eq("business_id", businessId)
    .in("sms_outbound_log_id", ids)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listSmsLinksByOutboundLogIds: ${error.message}`);
  return enrichLinks(businessId, (data as SmsLinkRow[] | null) ?? [], db, opts);
}

export async function listSmsLinksForContact(
  businessId: string,
  toE164: string,
  opts: { days?: number; includeClicks?: boolean; client?: SupabaseClient; now?: Date } = {}
): Promise<SmsLinkView[]> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const days = opts.days ?? 90;
  let query = db
    .from("sms_links")
    .select(SMS_LINK_SELECT)
    .eq("business_id", businessId)
    .eq("to_e164", toE164)
    .gte("created_at", daysCutoff(days, opts.now))
    .order("created_at", { ascending: false })
    .limit(100);
  const { data, error } = await query;
  if (error) throw new Error(`listSmsLinksForContact: ${error.message}`);
  return enrichLinks(businessId, (data as SmsLinkRow[] | null) ?? [], db, opts);
}

export async function listSmsLinksForRun(
  businessId: string,
  runId: string,
  opts: { includeClicks?: boolean; client?: SupabaseClient } = {}
): Promise<SmsLinkView[]> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("sms_links")
    .select(SMS_LINK_SELECT)
    .eq("business_id", businessId)
    .eq("run_id", runId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listSmsLinksForRun: ${error.message}`);
  return enrichLinks(businessId, (data as SmsLinkRow[] | null) ?? [], db, opts);
}

export async function listSmsLinksForFlow(
  businessId: string,
  flowId: string,
  opts: { days?: number; client?: SupabaseClient; now?: Date } = {}
): Promise<SmsLinkRow[]> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const days = opts.days ?? 30;
  const { data, error } = await db
    .from("sms_links")
    .select(SMS_LINK_SELECT)
    .eq("business_id", businessId)
    .eq("flow_id", flowId)
    .gte("created_at", daysCutoff(days, opts.now))
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`listSmsLinksForFlow: ${error.message}`);
  return (data as SmsLinkRow[] | null) ?? [];
}

export async function listSmsLinksForBusiness(
  businessId: string,
  opts: {
    days?: number;
    flowId?: string;
    limit?: number;
    includeClicks?: boolean;
    client?: SupabaseClient;
    now?: Date;
  } = {}
): Promise<SmsLinkView[]> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const days = opts.days ?? 30;
  const limit = opts.limit ?? 200;
  let query = db
    .from("sms_links")
    .select(SMS_LINK_SELECT)
    .eq("business_id", businessId)
    .gte("created_at", daysCutoff(days, opts.now));
  if (opts.flowId) query = query.eq("flow_id", opts.flowId);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listSmsLinksForBusiness: ${error.message}`);
  return enrichLinks(businessId, (data as SmsLinkRow[] | null) ?? [], db, opts);
}

/** Map outbound log id → enriched links for thread rendering. */
export async function mapSmsLinksByOutboundLogIds(
  businessId: string,
  outboundLogIds: string[],
  opts: { includeClicks?: boolean; client?: SupabaseClient } = {}
): Promise<Map<string, SmsLinkView[]>> {
  const links = await listSmsLinksByOutboundLogIds(businessId, outboundLogIds, opts);
  const out = new Map<string, SmsLinkView[]>();
  for (const link of links) {
    if (!link.sms_outbound_log_id) continue;
    const list = out.get(link.sms_outbound_log_id) ?? [];
    list.push(link);
    out.set(link.sms_outbound_log_id, list);
  }
  return out;
}
