/**
 * Platform software the fleet cost model used to omit: Vercel, Zoom,
 * Resend, and Cursor. Vercel comes from the FOCUS billing export (the Pro
 * seat's effective cost, plus anything FOCUS marks as actually billed).
 * Resend is priced from emails we logged this month against the free
 * quota, plus an optional base. Zoom and the Cursor seat have no bill
 * API on the credentials this app holds, so they come from
 * PLATFORM_COST_ZOOM_MONTHLY_CENTS and PLATFORM_COST_CURSOR_MONTHLY_CENTS.
 * Cursor on-demand spend is added when CURSOR_ADMIN_API_KEY is set.
 */

export const RESEND_FREE_MONTHLY_EMAILS = 3_000;
/** Paid-plan overage, $0.90 per 1,000 emails past the included quota. */
export const RESEND_OVERAGE_CENTS_PER_THOUSAND = 90;

export const SOFTWARE_COST_CACHE_KEY = "platform_software_cost_cache";
/** Re-pull Vercel at most this often. The export is about 11MB. */
export const SOFTWARE_COST_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type SoftwareCostCents = {
  vercelCents: number;
  zoomCents: number;
  resendCents: number;
  cursorCents: number;
};

export type SoftwareCostCache = SoftwareCostCents & {
  syncedAt: string;
  resendEmails: number;
};

export type FocusChargeRow = {
  BilledCost?: unknown;
  EffectiveCost?: unknown;
  ServiceName?: unknown;
  PricingCategory?: unknown;
};

/** Non-negative integer cents from an env string. Anything else is 0. */
export function monthlyCentsFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * Resend's published price for a month of email. The first 3,000 are
 * free. Above that, each started thousand is the overage rate. `baseCents`
 * is a paid-plan subscription the usage API cannot see (the send-only
 * key is restricted to sending).
 */
export function resendCentsForEmailCount(emails: number, baseCents = 0): number {
  const count = Number.isFinite(emails) && emails > 0 ? Math.floor(emails) : 0;
  const over = Math.max(0, count - RESEND_FREE_MONTHLY_EMAILS);
  const thousands = over === 0 ? 0 : Math.ceil(over / 1_000);
  const base = Number.isFinite(baseCents) && baseCents > 0 ? Math.round(baseCents) : 0;
  return base + thousands * RESEND_OVERAGE_CENTS_PER_THOUSAND;
}

/**
 * Dollars FOCUS actually charges this month, in cents.
 *
 * BilledCost is overage cash. The Pro seat is a real subscription that
 * FOCUS reports as committed effective cost with a zero billed cost, so
 * that seat is included and other committed usage (allowance already
 * covered by the seat) is not.
 */
export function vercelCentsFromFocusCharges(rows: FocusChargeRow[]): number {
  let dollars = 0;
  for (const row of rows) {
    const billed = typeof row.BilledCost === "number" ? row.BilledCost : 0;
    if (billed > 0) {
      dollars += billed;
      continue;
    }
    if (row.ServiceName === "Pro" && row.PricingCategory === "Committed") {
      const effective = typeof row.EffectiveCost === "number" ? row.EffectiveCost : 0;
      if (effective > 0) dollars += effective;
    }
  }
  return Math.round(dollars * 100);
}

export function parseFocusJsonl(body: string): FocusChargeRow[] {
  const rows: FocusChargeRow[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed !== null && typeof parsed === "object") rows.push(parsed as FocusChargeRow);
    } catch {
      // A truncated last line must not drop the charges already parsed.
    }
  }
  return rows;
}

/** On-demand cents from a Cursor `/teams/spend` body. Included usage is not cash. */
export function cursorOnDemandCents(body: unknown): number {
  if (body === null || typeof body !== "object") return 0;
  const members = (body as { teamMemberSpend?: unknown }).teamMemberSpend;
  if (!Array.isArray(members)) return 0;
  let cents = 0;
  for (const member of members) {
    if (member === null || typeof member !== "object") continue;
    const spend = (member as { spendCents?: unknown }).spendCents;
    if (typeof spend === "number" && Number.isFinite(spend) && spend > 0) cents += spend;
  }
  return Math.round(cents);
}

export function softwareCostTotal(costs: SoftwareCostCents): number {
  return costs.vercelCents + costs.zoomCents + costs.resendCents + costs.cursorCents;
}

export function emptySoftwareCosts(): SoftwareCostCents {
  return { vercelCents: 0, zoomCents: 0, resendCents: 0, cursorCents: 0 };
}

export function parseSoftwareCostCache(raw: unknown): SoftwareCostCache | null {
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.syncedAt !== "string") return null;
  const num = (key: string): number => {
    const value = row[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
  };
  return {
    syncedAt: row.syncedAt,
    vercelCents: num("vercelCents"),
    zoomCents: num("zoomCents"),
    resendCents: num("resendCents"),
    cursorCents: num("cursorCents"),
    resendEmails: num("resendEmails")
  };
}

export function softwareCacheIsFresh(cache: SoftwareCostCache, now: Date, maxAgeMs: number): boolean {
  const synced = Date.parse(cache.syncedAt);
  if (!Number.isFinite(synced)) return false;
  const age = now.getTime() - synced;
  if (age < 0 || age >= maxAgeMs) return false;
  const syncedAt = new Date(synced);
  return (
    syncedAt.getUTCFullYear() === now.getUTCFullYear() &&
    syncedAt.getUTCMonth() === now.getUTCMonth()
  );
}
