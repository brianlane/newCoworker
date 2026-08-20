/**
 * Deals (a lead's money view), pure domain rules.
 *
 * A deal is a named opportunity attached to a contact: expected value,
 * expected close date, commission. Status is a small fixed funnel:
 *
 *   open -> under_contract -> won | lost
 *
 * with the direct open -> won/lost jump allowed (plenty of deals never pass
 * through a contract stage). Winning stamps `won_at`, losing stamps
 * `lost_at`, and reopening (won/lost back to open/under_contract) clears
 * both, so the stamps always describe the CURRENT terminal state, never a
 * stale one. A won deal cannot flip straight to lost (or back): reopen
 * first, so a mis-click never silently rewrites history.
 *
 * Money is integer cents plus an ISO 4217 currency code; commission is basis
 * points (100 bps = 1%). No floating-point money math anywhere.
 *
 * Types-only + pure functions (no Supabase import) so client components can
 * validate and format without server code.
 */
import { z } from "zod";

export const DEAL_STATUSES = ["open", "under_contract", "won", "lost"] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

export const MAX_DEAL_TITLE_LENGTH = 200;
/** $1T in cents, far under Number.MAX_SAFE_INTEGER (the column is bigint). */
export const MAX_DEAL_VALUE_CENTS = 100_000_000_000_000;
/** 10000 bps = 100%. */
export const MAX_DEAL_COMMISSION_BPS = 10_000;

export const dealStatusSchema = z.enum(DEAL_STATUSES);

/** Uppercased ISO 4217 alpha code ("USD", "MXN"). */
const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code like USD.");

/** Calendar date as YYYY-MM-DD; rejects shapes like 2026-02-31. */
const closeDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "That date does not exist.");

const dealFields = {
  title: z.string().trim().min(1).max(MAX_DEAL_TITLE_LENGTH),
  /** Contact this deal belongs to; null = not linked. */
  contactId: z.string().uuid().nullable(),
  valueCents: z.number().int().min(0).max(MAX_DEAL_VALUE_CENTS).nullable(),
  currency: currencySchema,
  commissionBps: z.number().int().min(0).max(MAX_DEAL_COMMISSION_BPS).nullable(),
  expectedCloseDate: closeDateSchema.nullable(),
  status: dealStatusSchema
};

/** POST body: title required, everything else optional. `strict()` so a
 * typo'd key is a validation error instead of a silently-dropped field. */
export const dealCreateSchema = z
  .object({
    title: dealFields.title,
    contactId: dealFields.contactId.optional(),
    valueCents: dealFields.valueCents.optional(),
    currency: dealFields.currency.optional(),
    commissionBps: dealFields.commissionBps.optional(),
    expectedCloseDate: dealFields.expectedCloseDate.optional(),
    status: dealFields.status.optional()
  })
  .strict();

export type DealCreateInput = z.infer<typeof dealCreateSchema>;

/** PATCH body: any subset of the fields, but not an empty patch. */
export const dealPatchSchema = z
  .object({
    title: dealFields.title.optional(),
    contactId: dealFields.contactId.optional(),
    valueCents: dealFields.valueCents.optional(),
    currency: dealFields.currency.optional(),
    commissionBps: dealFields.commissionBps.optional(),
    expectedCloseDate: dealFields.expectedCloseDate.optional(),
    status: dealFields.status.optional()
  })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: "Nothing to update."
  });

export type DealPatchInput = z.infer<typeof dealPatchSchema>;

/** A deal as the API serves it. */
export type Deal = {
  id: string;
  businessId: string;
  contactId: string | null;
  title: string;
  valueCents: number | null;
  currency: string;
  commissionBps: number | null;
  expectedCloseDate: string | null;
  status: DealStatus;
  wonAt: string | null;
  lostAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * The funnel's legal moves (staying put is always legal). Won and lost never
 * swap directly: a terminal state is left by reopening, which clears its
 * stamp, so `won_at`/`lost_at` can never both be live.
 */
const ALLOWED_TRANSITIONS: Record<DealStatus, readonly DealStatus[]> = {
  open: ["under_contract", "won", "lost"],
  under_contract: ["open", "won", "lost"],
  won: ["open", "under_contract"],
  lost: ["open", "under_contract"]
};

export function canTransitionDealStatus(from: DealStatus, to: DealStatus): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * The `won_at`/`lost_at` values a move INTO `next` must write: winning
 * stamps won_at, losing stamps lost_at, and any non-terminal destination
 * clears both (that clearing is what makes a reopen honest).
 */
export function dealStatusStamps(
  next: DealStatus,
  nowIso: string
): { won_at: string | null; lost_at: string | null } {
  return {
    won_at: next === "won" ? nowIso : null,
    lost_at: next === "lost" ? nowIso : null
  };
}

/**
 * "$12,500" / "$1,234.56" for the board cards and analytics. Whole-dollar
 * values drop the cents. Null in, null out (an unsized deal shows nothing,
 * not $0). Unknown currency codes fall back to a plain "1234.56 XXX" so a
 * hand-edited row can never crash a render.
 */
export function formatDealValue(valueCents: number | null, currency: string): string | null {
  if (valueCents === null) return null;
  const whole = valueCents % 100 === 0;
  const digits = whole ? 0 : 2;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(valueCents / 100);
  } catch {
    return `${(valueCents / 100).toFixed(digits)} ${currency}`;
  }
}

/** "250 bps" -> "2.5%" (trailing zeros trimmed: 300 -> "3%"). */
export function formatCommissionBps(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

/**
 * Commission owed on the deal in cents (rounded to the cent), or null when
 * either side is unknown.
 */
export function commissionValueCents(
  valueCents: number | null,
  commissionBps: number | null
): number | null {
  if (valueCents === null || commissionBps === null) return null;
  return Math.round((valueCents * commissionBps) / MAX_DEAL_COMMISSION_BPS);
}
