/**
 * Loads this month's one-time usage-pack cash. Vercel, Resend, Zoom, and
 * Cursor are the fixed monthly receipts in software-costs.ts, so a failed
 * grant read does not zero those bills.
 *
 * Pack grants stay central (they are not a purged residency table).
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listVoiceBonusPacks } from "@/lib/billing/voice-bonus-packs";
import { listSmsBonusPacks } from "@/lib/billing/sms-bonus-packs";
import { listChatCreditPacks } from "@/lib/billing/chat-credit-packs";
import { logger } from "@/lib/logger";
import {
  sumUsagePackRevenue,
  usagePackGrantFromRow,
  type UsagePackGrantRow,
  type UsagePackRevenue
} from "@/lib/admin/usage-pack-revenue";
import { monthlySoftwareCosts, type SoftwareCostCents } from "@/lib/admin/software-costs";

export type MoneyGaps = {
  usagePacks: UsagePackRevenue;
  software: SoftwareCostCents;
};

type QueryResult = {
  data: unknown;
  error: { message: string } | null;
  count: number | null;
};

/** Supabase query builder slice this loader uses. Thenable, and chainable. */
export interface MoneyGapQuery extends Promise<QueryResult> {
  gte(column: string, value: string): MoneyGapQuery;
  lt(column: string, value: string): MoneyGapQuery;
}

export type MoneyGapDb = {
  from: (table: string) => {
    select: (columns: string, options?: { count?: "exact"; head?: boolean }) => MoneyGapQuery;
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
  query: Promise<QueryResult>,
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

export async function loadMoneyGaps(now: Date = new Date()): Promise<MoneyGaps> {
  const software = monthlySoftwareCosts();
  const emptyPacks: UsagePackRevenue = { totalCents: 0, byBusiness: new Map() };
  try {
    const db = (await createSupabaseServiceClient()) as unknown as MoneyGapDb;
    const grantRows = await loadUsagePackGrants(db, utcMonthWindow(now));
    return { usagePacks: priceLoadedGrants(grantRows), software };
  } catch (err: unknown) {
    logger.error("money gaps: load failed", {
      message: err instanceof Error ? err.message : String(err)
    });
    return { usagePacks: emptyPacks, software };
  }
}
