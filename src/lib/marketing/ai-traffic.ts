/**
 * Did any of the AI search work actually land?
 *
 * Records two signals against `ai_traffic_events`: an AI crawler fetching a
 * public page (we are being READ) and a human arriving from an AI answer
 * surface (we are being CITED). Without these, every other piece of AEO work
 * is unfalsifiable.
 *
 * Deliberately not analytics. No IP, no session, no user, no query string:
 * one row says an agent touched a public path at a time. Recording is
 * best-effort everywhere and never blocks or fails a page render.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { matchAiCrawler, matchAiReferrer } from "@/lib/marketing/ai-crawlers";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Fixed platform retention, matching the KG ledger's ops-data window. */
export const AI_TRAFFIC_RETENTION_DAYS = 90;

export type AiTrafficKind = "crawler" | "referral";

export type AiTrafficEvent = {
  kind: AiTrafficKind;
  /** Crawler token, or the AI surface's label for a referral. */
  source: string;
  operator: string;
  path: string;
};

/**
 * Paths worth recording: the public marketing surface plus the machine-facing
 * files. Authenticated and API paths are excluded because robots.txt already
 * disallows them, so a hit there is noise rather than signal.
 */
export function isTrackablePath(pathname: string): boolean {
  if (
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/admin") ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/oauth") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/widget") ||
    // Per-tenant capability-token surfaces: noindex, and the token itself
    // would end up in the path column.
    pathname.startsWith("/book") ||
    pathname.startsWith("/intake") ||
    pathname.startsWith("/sign") ||
    pathname.startsWith("/s/")
  ) {
    return false;
  }
  return true;
}

/**
 * Classify one request. Crawler identity wins over referrer: an agent that
 * sends both is a fetch on someone's behalf, and counting it as a human
 * visit would inflate the referral number with robot traffic.
 */
export function classifyAiTraffic(input: {
  pathname: string;
  userAgent: string | null | undefined;
  referrer: string | null | undefined;
}): AiTrafficEvent | null {
  if (!isTrackablePath(input.pathname)) return null;

  const crawler = matchAiCrawler(input.userAgent);
  if (crawler) {
    return {
      kind: "crawler",
      source: crawler.token,
      operator: crawler.operator,
      path: input.pathname
    };
  }

  const referrer = matchAiReferrer(input.referrer);
  if (referrer) {
    return {
      kind: "referral",
      source: referrer.surface,
      operator: referrer.surface,
      path: input.pathname
    };
  }

  return null;
}

/** Write one event. Never throws: a logging failure is not a page failure. */
export async function recordAiTrafficEvent(
  event: AiTrafficEvent,
  client?: SupabaseClient
): Promise<void> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { error } = await db.from("ai_traffic_events").insert(event);
    if (error) throw new Error(error.message);
  } catch (err) {
    logger.warn("ai-traffic: record failed", {
      kind: event.kind,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export type AiTrafficRow = {
  kind: AiTrafficKind;
  source: string;
  operator: string;
  path: string;
  created_at: string;
};

/**
 * Rows since `sinceIso`, newest first and bounded. A busy crawl should cost
 * the admin page a truncated chart, not a timeout.
 */
export async function listAiTrafficRows(
  sinceIso: string,
  limit = 5000,
  client?: SupabaseClient
): Promise<AiTrafficRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("ai_traffic_events")
    .select("kind, source, operator, path, created_at")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listAiTrafficRows: ${error.message}`);
  return (data ?? []) as AiTrafficRow[];
}

/** Fixed-window prune (daily retention sweep). Returns rows deleted. */
export async function pruneAiTrafficEvents(
  now: Date = new Date(),
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const cutoffIso = new Date(
    now.getTime() - AI_TRAFFIC_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data, error } = await db
    .from("ai_traffic_events")
    .delete()
    .lt("created_at", cutoffIso)
    .select("id");
  if (error) throw new Error(`pruneAiTrafficEvents: ${error.message}`);
  return Array.isArray(data) ? data.length : 0;
}

// ── Aggregation (pure) ───────────────────────────────────────────────────

export type AiTrafficDay = { day: string; crawler: number; referral: number };

export type AiTrafficSummary = {
  crawlerHits: number;
  referrals: number;
  /** Ascending by day, with zero-filled gaps so the trend reads honestly. */
  byDay: AiTrafficDay[];
  /** Descending by count. */
  topSources: Array<{ source: string; kind: AiTrafficKind; count: number }>;
  topPaths: Array<{ path: string; count: number }>;
  /**
   * Operators seen crawling. The interesting reading is which registry
   * entries are MISSING: an assistant absent here is either not interested
   * or being blocked at the edge (run debug/aeo-crawler-probe.ts).
   */
  crawlerOperators: string[];
};

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Every UTC day from `sinceIso` through `now`, so gaps render as zero. */
function dayRange(sinceIso: string, now: Date): string[] {
  const days: string[] = [];
  const cursor = new Date(`${dayKey(sinceIso)}T00:00:00.000Z`);
  const end = dayKey(now.toISOString());
  // Bounded by the caller's window; the guard is belt and braces against a
  // malformed `sinceIso` spinning here.
  for (let i = 0; i < 400; i += 1) {
    const key = dayKey(cursor.toISOString());
    days.push(key);
    if (key >= end) break;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function topN<T extends string>(counts: Map<T, number>, n: number): Array<[T, number]> {
  return [...counts.entries()]
    // Count first, then the key, so equal counts render in a stable order
    // instead of shuffling between page loads.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n);
}

export function summarizeAiTraffic(
  rows: AiTrafficRow[],
  sinceIso: string,
  now: Date = new Date()
): AiTrafficSummary {
  const perDay = new Map<string, AiTrafficDay>();
  for (const day of dayRange(sinceIso, now)) {
    perDay.set(day, { day, crawler: 0, referral: 0 });
  }

  const sourceCounts = new Map<string, number>();
  const sourceKind = new Map<string, AiTrafficKind>();
  const pathCounts = new Map<string, number>();
  const operators = new Set<string>();
  let crawlerHits = 0;
  let referrals = 0;

  for (const row of rows) {
    if (row.kind === "crawler") {
      crawlerHits += 1;
      operators.add(row.operator);
    } else {
      referrals += 1;
    }

    const bucket = perDay.get(dayKey(row.created_at));
    // A row outside the rendered range (clock skew, a window edge) still
    // counts in the totals; it just has no column to sit in.
    if (bucket) bucket[row.kind] += 1;

    sourceCounts.set(row.source, (sourceCounts.get(row.source) ?? 0) + 1);
    sourceKind.set(row.source, row.kind);
    pathCounts.set(row.path, (pathCounts.get(row.path) ?? 0) + 1);
  }

  return {
    crawlerHits,
    referrals,
    byDay: [...perDay.values()],
    topSources: topN(sourceCounts, 10).map(([source, count]) => ({
      source,
      // Every source name belongs to exactly one kind, recorded above.
      kind: sourceKind.get(source) as AiTrafficKind,
      count
    })),
    topPaths: topN(pathCounts, 10).map(([path, count]) => ({ path, count })),
    crawlerOperators: [...operators].sort()
  };
}
