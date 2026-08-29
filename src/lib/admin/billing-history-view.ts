/**
 * View-model helpers for the admin Billing History page: which metric is being
 * charted, how a bar is sized, and how a change is worded.
 *
 * Kept out of the page component so the arithmetic is unit-tested. The page
 * itself stays markup.
 */

import type { BillingHistoryCell } from "@/lib/admin/billing-history";
import { vendorCents } from "@/lib/admin/billing-history";

type MetricKey =
  | "telnyx"
  | "gemini"
  | "vendor"
  | "revenue"
  | "textUnits"
  | "messages"
  | "voiceMinutes"
  | "calls";

export type MetricDef = {
  key: MetricKey;
  label: string;
  /** How a value renders: money is cents, count is a plain number. */
  format: "money" | "count" | "minutes";
  pick: (cell: BillingHistoryCell) => number;
  /** Whether going UP is bad (cost) or good (revenue, activity). */
  upIsBad: boolean;
};

export const METRICS: MetricDef[] = [
  {
    key: "telnyx",
    label: "Telnyx cost",
    format: "money",
    pick: (c) => c.telnyxCents,
    upIsBad: true
  },
  {
    key: "gemini",
    label: "Gemini cost",
    format: "money",
    pick: (c) => c.geminiCents,
    upIsBad: true
  },
  {
    key: "vendor",
    label: "Vendor total",
    format: "money",
    pick: vendorCents,
    upIsBad: true
  },
  {
    key: "revenue",
    label: "Revenue",
    format: "money",
    pick: (c) => c.revenueCents,
    upIsBad: false
  },
  {
    key: "textUnits",
    label: "Text units",
    format: "count",
    pick: (c) => c.textUnits,
    upIsBad: false
  },
  {
    key: "messages",
    label: "Messages",
    format: "count",
    pick: (c) => c.messages,
    upIsBad: false
  },
  {
    key: "voiceMinutes",
    label: "Voice minutes",
    format: "minutes",
    pick: (c) => c.voiceMinutes,
    upIsBad: false
  },
  { key: "calls", label: "Calls", format: "count", pick: (c) => c.calls, upIsBad: false }
];

/** The requested metric, falling back to Telnyx cost, which is why this page exists. */
export function resolveMetric(raw: string | undefined): MetricDef {
  return METRICS.find((m) => m.key === raw) ?? METRICS[0]!;
}

/** Month-count choices the page offers. */
export const MONTH_CHOICES = [6, 12, 24] as const;

export function resolveMonthCount(raw: string | undefined): number {
  const n = Number(raw);
  return (MONTH_CHOICES as readonly number[]).includes(n) ? n : 12;
}

/** Render one value in its metric's own units. */
export function formatMetric(value: number, format: MetricDef["format"]): string {
  if (format === "money") {
    return `$${(value / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  }
  if (format === "minutes") return value.toFixed(1);
  return Math.round(value).toLocaleString("en-US");
}

/**
 * Bar height as a percent of the tallest bar in the series.
 *
 * A non-zero value never renders as nothing: a month with $0.04 of spend and a
 * month with no rows at all are different facts, and a 0%-height bar makes
 * them look identical.
 */
export function barPercent(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.max((value / max) * 100, 4);
}

export type ChangeTone = "good" | "bad" | "flat" | "unknown";

/**
 * How a percentage change should read.
 *
 * Anything inside +/-5% is "flat": month lengths, weekends and a single busy
 * day move these numbers by a few percent on their own, and colouring that
 * noise trains people to ignore the colour.
 */
export function changeTone(changePct: number | null, upIsBad: boolean): ChangeTone {
  if (changePct === null) return "unknown";
  if (Math.abs(changePct) < 5) return "flat";
  const up = changePct > 0;
  return up === upIsBad ? "bad" : "good";
}

/** "+65%" / "-12%" / "new" when there is no previous month to compare against. */
export function formatChange(changePct: number | null): string {
  if (changePct === null) return "new";
  const rounded = Math.round(changePct);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}
