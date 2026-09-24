/**
 * Recurring platform software bills: Vercel, Resend, Zoom, and Cursor.
 *
 * These are the card receipts. Each one is the same amount every month, so
 * the Costs page uses the receipt instead of a usage estimate. The Vercel
 * billing export and a count of emails sent both missed the amount that
 * was actually charged.
 *
 *   Vercel receipt 2164-1704, paid Sep 20 2026: $21.66 (Pro $20 plus tax).
 *   Resend receipt 2167-5427, paid Sep 9 2026: $20.00.
 *   Zoom invoice INV370438231, Workplace Pro monthly: $16.99.
 *   Cursor Ultra: $200.00 per month.
 */

const VERCEL_MONTHLY_CENTS = 2_166;
const RESEND_MONTHLY_CENTS = 2_000;
const ZOOM_MONTHLY_CENTS = 1_699;
const CURSOR_MONTHLY_CENTS = 20_000;

export type SoftwareCostCents = {
  vercelCents: number;
  zoomCents: number;
  resendCents: number;
  cursorCents: number;
};

/** The four receipts, in cents. */
export function monthlySoftwareCosts(): SoftwareCostCents {
  return {
    vercelCents: VERCEL_MONTHLY_CENTS,
    zoomCents: ZOOM_MONTHLY_CENTS,
    resendCents: RESEND_MONTHLY_CENTS,
    cursorCents: CURSOR_MONTHLY_CENTS
  };
}

export function softwareCostTotal(costs: SoftwareCostCents): number {
  return costs.vercelCents + costs.zoomCents + costs.resendCents + costs.cursorCents;
}

export function emptySoftwareCosts(): SoftwareCostCents {
  return { vercelCents: 0, zoomCents: 0, resendCents: 0, cursorCents: 0 };
}
