/**
 * Loads the two money gaps the admin pages used to leave out:
 * this month's one-time usage-pack cash, and Vercel / Zoom / Resend / Cursor.
 *
 * Pack grants stay central (they are not a purged residency table).
 * Email volume is split by residency: supabase-mode tenants are counted
 * on central, vps-mode tenants on their box, so a purged central copy
 * cannot drop a whole month of Resend sends. A box that does not answer
 * contributes 0 for that tenant rather than failing the page.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { countMovedRows } from "@/lib/residency/read";
import { listVoiceBonusPacks } from "@/lib/billing/voice-bonus-packs";
import { listSmsBonusPacks } from "@/lib/billing/sms-bonus-packs";
import { listChatCreditPacks } from "@/lib/billing/chat-credit-packs";
import {
  getAdminPlatformSetting,
  upsertAdminPlatformSetting
} from "@/lib/admin/platform-settings";
import { logger } from "@/lib/logger";
import {
  sumUsagePackRevenue,
  usagePackGrantFromRow,
  type UsagePackGrantRow,
  type UsagePackRevenue
} from "@/lib/admin/usage-pack-revenue";
import {
  SOFTWARE_COST_CACHE_KEY,
  SOFTWARE_COST_CACHE_MAX_AGE_MS,
  cursorOnDemandCents,
  emptySoftwareCosts,
  monthlyCentsFromEnv,
  parseFocusJsonl,
  parseSoftwareCostCache,
  resendCentsForEmailCount,
  softwareCacheIsFresh,
  vercelCentsFromFocusCharges,
  type SoftwareCostCache,
  type SoftwareCostCents
} from "@/lib/admin/software-costs";

export type MoneyGaps = {
  usagePacks: UsagePackRevenue;
  software: SoftwareCostCents;
};

type FilterResult = Promise<{
  data: unknown;
  error: { message: string } | null;
  count: number | null;
}>;

type GrantQuery = {
  gte: (column: string, value: string) => { lt: (column: string, value: string) => FilterResult };
};

type EmailCountQuery = {
  gte: (
    column: string,
    value: string
  ) => {
    lt: (
      column: string,
      value: string
    ) => { in: (column: string, values: string[]) => FilterResult };
  };
};

export type MoneyGapDb = {
  from: (table: string) => {
    select: (columns: string, options?: { count?: "exact"; head?: boolean }) => GrantQuery &
      EmailCountQuery & {
        // businesses list: no date filter, the builder is still thenable in tests
        then?: undefined;
      };
  };
};

export function utcMonthWindow(now: Date): { startIso: string; endIso: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function asGrantRows(data: unknown, unitColumn: string): UsagePackGrantRow[] {
  if (!Array.isArray(data)) return [];
  const rows: UsagePackGrantRow[] = [];
  for (const item of data) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.business_id !== "string") continue;
    const units = row[unitColumn];
    rows.push({
      business_id: row.business_id,
      stripe_checkout_session_id:
        typeof row.stripe_checkout_session_id === "string" ? row.stripe_checkout_session_id : null,
      voided_at: typeof row.voided_at === "string" ? row.voided_at : null,
      units: typeof units === "number" && Number.isFinite(units) ? units : 0
    });
  }
  return rows;
}

async function readGrants(
  query: FilterResult,
  unitColumn: string,
  table: string
): Promise<UsagePackGrantRow[]> {
  const { data, error } = await query;
  if (error) {
    logger.error("money gaps: usage pack grant read failed", { table, message: error.message });
    return [];
  }
  return asGrantRows(data, unitColumn);
}

export async function loadUsagePackGrants(
  db: MoneyGapDb,
  window: { startIso: string; endIso: string }
): Promise<UsagePackGrantRow[]> {
  const voice = db
    .from("voice_bonus_grants")
    .select("business_id, stripe_checkout_session_id, voided_at, seconds_purchased")
    .gte("purchased_at", window.startIso)
    .lt("purchased_at", window.endIso);
  const sms = db
    .from("sms_bonus_grants")
    .select("business_id, stripe_checkout_session_id, voided_at, texts_purchased")
    .gte("purchased_at", window.startIso)
    .lt("purchased_at", window.endIso);
  const chat = db
    .from("chat_spend_credit_grants")
    .select("business_id, stripe_checkout_session_id, voided_at, credit_micros_purchased")
    .gte("purchased_at", window.startIso)
    .lt("purchased_at", window.endIso);
  const [voiceRows, smsRows, chatRows] = await Promise.all([
    readGrants(voice, "seconds_purchased", "voice_bonus_grants"),
    readGrants(sms, "texts_purchased", "sms_bonus_grants"),
    readGrants(chat, "credit_micros_purchased", "chat_spend_credit_grants")
  ]);
  return [...voiceRows, ...smsRows, ...chatRows];
}

export function priceLoadedGrants(rows: UsagePackGrantRow[]): UsagePackRevenue {
  const packs = [
    ...listVoiceBonusPacks().map((pack) => ({ unit: pack.seconds, priceCents: pack.priceCents })),
    ...listSmsBonusPacks().map((pack) => ({ unit: pack.texts, priceCents: pack.priceCents })),
    ...listChatCreditPacks().map((pack) => ({
      unit: pack.creditMicros,
      priceCents: pack.priceCents
    }))
  ];
  return sumUsagePackRevenue(rows.map(usagePackGrantFromRow), packs);
}

type BusinessMode = { id: string; vps: boolean };

export async function countFleetEmailsThisMonth(params: {
  db: MoneyGapDb;
  businesses: BusinessMode[];
  window: { startIso: string; endIso: string };
  countBox: (businessId: string) => Promise<number>;
}): Promise<number> {
  const supabaseIds = params.businesses.filter((b) => !b.vps).map((b) => b.id);
  const vpsIds = params.businesses.filter((b) => b.vps).map((b) => b.id);
  let total = 0;
  if (supabaseIds.length > 0) {
    const { count, error } = await params.db
      .from("email_log")
      .select("id", { count: "exact", head: true })
      .gte("created_at", params.window.startIso)
      .lt("created_at", params.window.endIso)
      .in("business_id", supabaseIds);
    if (error) {
      logger.error("money gaps: central email count failed", { message: error.message });
    } else {
      total += count ?? 0;
    }
  }
  for (const businessId of vpsIds) {
    try {
      total += await params.countBox(businessId);
    } catch (err: unknown) {
      logger.error("money gaps: box email count failed", {
        businessId,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return total;
}

async function fetchVercelFocus(window: { startIso: string; endIso: string }): Promise<string | null> {
  const token = process.env.VERCEL_TOKEN?.trim();
  const teamId = process.env.VERCEL_ORG_ID?.trim();
  if (!token || !teamId) return null;
  const url =
    `https://api.vercel.com/v1/billing/charges?teamId=${encodeURIComponent(teamId)}` +
    `&from=${encodeURIComponent(window.startIso)}&to=${encodeURIComponent(window.endIso)}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    logger.error("money gaps: vercel billing read failed", { status: response.status });
    return null;
  }
  return response.text();
}

async function fetchCursorOnDemandCents(): Promise<number> {
  const key = process.env.CURSOR_ADMIN_API_KEY?.trim();
  if (!key) return 0;
  let cents = 0;
  for (let page = 1; page <= 20; page += 1) {
    const response = await fetch("https://api.cursor.com/teams/spend", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ page, pageSize: 100 })
    });
    if (!response.ok) {
      logger.error("money gaps: cursor spend read failed", { status: response.status });
      return cents;
    }
    const body: unknown = await response.json();
    cents += cursorOnDemandCents(body);
    const members = (body as { teamMemberSpend?: unknown }).teamMemberSpend;
    if (!Array.isArray(members) || members.length < 100) break;
  }
  return cents;
}

export async function loadSoftwareCosts(now: Date, emailCount: number): Promise<SoftwareCostCents> {
  const window = utcMonthWindow(now);
  let cache: SoftwareCostCache | null = null;
  try {
    cache = parseSoftwareCostCache(await getAdminPlatformSetting(SOFTWARE_COST_CACHE_KEY));
  } catch (err: unknown) {
    logger.error("money gaps: software cost cache read failed", {
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const fresh = cache !== null && softwareCacheIsFresh(cache, now, SOFTWARE_COST_CACHE_MAX_AGE_MS);
  let vercelCents = fresh && cache ? cache.vercelCents : 0;
  if (!fresh) {
    try {
      const body = await fetchVercelFocus(window);
      vercelCents =
        body === null ? (cache?.vercelCents ?? 0) : vercelCentsFromFocusCharges(parseFocusJsonl(body));
    } catch (err: unknown) {
      logger.error("money gaps: vercel billing fetch threw", {
        message: err instanceof Error ? err.message : String(err)
      });
      vercelCents = cache?.vercelCents ?? 0;
    }
  }

  let cursorOnDemand = 0;
  try {
    cursorOnDemand = await fetchCursorOnDemandCents();
  } catch (err: unknown) {
    logger.error("money gaps: cursor spend fetch threw", {
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const costs: SoftwareCostCents = {
    vercelCents,
    zoomCents: monthlyCentsFromEnv(process.env.PLATFORM_COST_ZOOM_MONTHLY_CENTS),
    resendCents: resendCentsForEmailCount(
      emailCount,
      monthlyCentsFromEnv(process.env.PLATFORM_COST_RESEND_MONTHLY_CENTS)
    ),
    cursorCents: monthlyCentsFromEnv(process.env.PLATFORM_COST_CURSOR_MONTHLY_CENTS) + cursorOnDemand
  };

  if (!fresh) {
    const next: SoftwareCostCache = {
      ...costs,
      syncedAt: now.toISOString(),
      resendEmails: emailCount
    };
    try {
      await upsertAdminPlatformSetting(SOFTWARE_COST_CACHE_KEY, next);
    } catch (err: unknown) {
      logger.error("money gaps: software cost cache write failed", {
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return costs;
}

type BusinessRow = { id?: unknown; data_residency_mode?: unknown };

async function listBusinessModes(db: MoneyGapDb): Promise<BusinessMode[]> {
  const { data, error } = await db
    .from("businesses")
    .select("id, data_residency_mode")
    .gte("created_at", "1970-01-01T00:00:00.000Z")
    .lt("created_at", "2999-01-01T00:00:00.000Z");
  if (error || !Array.isArray(data)) {
    logger.error("money gaps: business list failed", { message: error?.message ?? "no rows" });
    return [];
  }
  const businesses: BusinessMode[] = [];
  for (const item of data as BusinessRow[]) {
    if (item === null || typeof item !== "object") continue;
    if (typeof item.id !== "string") continue;
    businesses.push({ id: item.id, vps: item.data_residency_mode === "vps" });
  }
  return businesses;
}

export async function loadMoneyGaps(now: Date = new Date()): Promise<MoneyGaps> {
  const emptyPacks: UsagePackRevenue = { totalCents: 0, byBusiness: new Map() };
  try {
    const db = (await createSupabaseServiceClient()) as unknown as MoneyGapDb;
    const window = utcMonthWindow(now);
    const [grantRows, businesses] = await Promise.all([
      loadUsagePackGrants(db, window),
      listBusinessModes(db)
    ]);
    const emailCount = await countFleetEmailsThisMonth({
      db,
      businesses,
      window,
      countBox: (businessId) =>
        countMovedRows(businessId, {
          table: "email_log",
          filters: [
            { column: "created_at", op: "gte", value: window.startIso },
            { column: "created_at", op: "lt", value: window.endIso }
          ]
        })
    });
    const [usagePacks, software] = await Promise.all([
      Promise.resolve(priceLoadedGrants(grantRows)),
      loadSoftwareCosts(now, emailCount)
    ]);
    return { usagePacks, software };
  } catch (err: unknown) {
    logger.error("money gaps: load failed", {
      message: err instanceof Error ? err.message : String(err)
    });
    return { usagePacks: emptyPacks, software: emptySoftwareCosts() };
  }
}
