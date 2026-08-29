/**
 * Transactional email: the monthly "here is what your coworker did" recap.
 *
 * Sent once a month, a few days after the month ends, about the month that
 * ENDED. It exists because the product is invisible when it works: the leads
 * it caught and the calls it answered at 9pm never show up as an event the
 * owner witnesses, so the only way they learn whether it is earning its place
 * is if we tell them, with their own numbers.
 *
 * COMMITMENTS THIS FILE KEEPS:
 *
 * - Every figure comes from the same snapshots the dashboard analytics page
 *   renders. If the email and the app disagree, that is a bug, not a rounding
 *   choice.
 * - Nothing is inflated. A month that went down says it went down; the
 *   comparison table shows the previous month beside it either way.
 * - The forward-looking line is optional and clearly hedged, and the report
 *   layer refuses to produce one at all below three months of history.
 * - Coverage is disclosed. A tenant who went live mid-month gets a line
 *   saying how many days are actually counted, so a short first month is not
 *   read as a bad one.
 *
 * Keep this file deterministic and input-pure: no DB reads, no Date.now(), no
 * env lookups.
 */

import { buildBrandedEmailHtml, escapeHtml } from "@/lib/email/branded-html";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";
import {
  GROWTH_METRICS,
  type GrowthMetric,
  type GrowthMonth,
  type GrowthReport
} from "@/lib/analytics/growth-report";

export type MonthlyGrowthEmailInput = {
  report: GrowthReport;
  businessName: string;
  /** Owner's display name; only the first word is used, and it may be absent. */
  ownerName?: string | null;
  recipientEmail: string;
  /** App origin without trailing slash. */
  siteUrl: string;
  unsubscribeUrl?: string | null;
  locale?: AppLocale;
};

export type MonthlyGrowthEmail = {
  subject: string;
  text: string;
  html: string;
};

/** "2026-08" -> "August 2026", in the recipient's locale. */
export function monthLabel(month: string, locale: AppLocale): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString(
    locale === "es" ? "es-US" : "en-US",
    { month: "long", year: "numeric", timeZone: "UTC" }
  );
}

/** The month after `month`, as "YYYY-MM". */
export function nextMonthOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 7);
}

/**
 * ", Amy" for a greeting, or "" when we have no name.
 *
 * First word only: owner_name carries a full name, and "Hi Amy Laidlaw," in a
 * monthly note reads like a form letter, which is exactly what this is trying
 * not to be.
 */
export function greetingSuffix(ownerName: string | null | undefined): string {
  // `split(sep, 1).join("")` rather than `[0]`: indexing needs a fallback for
  // an empty result that split can never produce, and an unreachable fallback
  // is a branch nothing can test.
  const first = (ownerName ?? "").trim().split(/\s+/, 1).join("");
  return first ? ` ${first}` : "";
}

/** Minutes render whole; everything else is a plain count. */
function metricValue(metric: GrowthMetric, value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** "+42%" / "-8%" / the localized "new" when there was no previous month. */
export function changeLabel(percent: number | null, newLabel: string): string {
  if (percent === null) return newLabel;
  const rounded = Math.round(percent);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

/** The comparison table, as email-safe inline-styled HTML. */
function tableHtml(
  latest: GrowthMonth,
  previous: GrowthMonth | null,
  changes: GrowthReport["changes"],
  labels: Record<GrowthMetric, string>,
  headers: { metric: string; current: string; previous: string; change: string },
  newLabel: string
): string {
  const cell = "padding:8px 10px;font-size:14px;line-height:1.4;";
  const head =
    `<tr>` +
    [headers.metric, headers.current, headers.previous, headers.change]
      .map(
        (h, i) =>
          `<th align="${i === 0 ? "left" : "right"}" style="${cell}color:#8a9bb0;font-weight:600;` +
          `border-bottom:1px solid #1f3247;">${escapeHtml(h)}</th>`
      )
      .join("") +
    `</tr>`;

  const rows = GROWTH_METRICS.map((metric) => {
    const change = changes ? changes[metric] : null;
    // Green only for a real rise. Every metric here counts work done, so up is
    // good across the board; a fall is stated plainly rather than coloured
    // alarming, because one quiet month is not a fault report.
    const color = change?.direction === "up" ? "#1BD96A" : "#8a9bb0";
    return (
      `<tr>` +
      `<td align="left" style="${cell}color:#e8eef5;">${escapeHtml(labels[metric])}</td>` +
      `<td align="right" style="${cell}color:#e8eef5;font-weight:600;">${escapeHtml(metricValue(metric, latest[metric]))}</td>` +
      `<td align="right" style="${cell}color:#8a9bb0;">${escapeHtml(previous ? metricValue(metric, previous[metric]) : "-")}</td>` +
      `<td align="right" style="${cell}color:${color};font-weight:600;">${escapeHtml(
        changeLabel(change ? change.percent : null, newLabel)
      )}</td>` +
      `</tr>`
    );
  }).join("");

  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" ` +
    `style="border-collapse:collapse;margin:0 0 8px;">${head}${rows}</table>`
  );
}

/**
 * Build the recap. Returns null when there is no complete month to report on,
 * which is the correct answer for a tenant in their first calendar month: the
 * caller skips the send rather than mailing an empty table.
 */
export function buildMonthlyGrowthEmail(input: MonthlyGrowthEmailInput): MonthlyGrowthEmail | null {
  const { report } = input;
  if (!report.latest) return null;

  const locale = input.locale ?? defaultLocale;
  const copy = emailMessagesForLocale(locale).monthlyGrowth;
  const site = input.siteUrl.replace(/\/$/, "");
  const analyticsUrl = `${site}/dashboard/analytics`;
  const month = monthLabel(report.latest.month, locale);
  const ownerFirstName = greetingSuffix(input.ownerName);

  const subject = fmtEmail(copy.subject, { businessName: input.businessName, month });
  const heading = fmtEmail(copy.heading, { month });

  const intro = report.previous
    ? fmtEmail(copy.intro, {
        ownerFirstName,
        businessName: input.businessName,
        month
      })
    : fmtEmail(copy.firstMonthIntro, {
        ownerFirstName,
        businessName: input.businessName
      });

  const labels: Record<GrowthMetric, string> = {
    leads: copy.metricLeads,
    texts: copy.metricTexts,
    calls: copy.metricCalls,
    voiceMinutes: copy.metricVoiceMinutes
  };
  const previousMonth = report.previous ? monthLabel(report.previous.month, locale) : "";

  // The trend sentence needs a real span to describe; with one month there is
  // no "from ... to ..." to write.
  const trendLine =
    report.months.length >= 2
      ? fmtEmail(copy.trendLine, {
          monthCount: String(report.months.length),
          firstLeads: String(report.months[0]!.leads),
          latestLeads: String(report.latest.leads)
        })
      : null;

  const projectionLine = report.projection
    ? fmtEmail(copy.projectionLine, {
        nextMonth: monthLabel(nextMonthOf(report.latest.month), locale),
        projectedLeads: String(report.projection.leads),
        projectedCalls: String(report.projection.calls)
      })
    : null;
  const projectionCaveat = report.projection
    ? fmtEmail(copy.projectionCaveat, { monthCount: String(report.months.length) })
    : null;

  const coverageNote = report.latestMonthIncomplete
    ? fmtEmail(copy.coverageNote, {
        month,
        coveredDays: String(report.latest.coveredDays),
        daysInMonth: String(report.latest.daysInMonth)
      })
    : null;

  const tail = [trendLine, projectionLine, projectionCaveat, coverageNote].filter(
    (line): line is string => line !== null
  );

  const textTable = GROWTH_METRICS.map((metric) => {
    const current = metricValue(metric, report.latest![metric]);
    const previous = report.previous ? metricValue(metric, report.previous[metric]) : "-";
    const change = changeLabel(
      report.changes ? report.changes[metric].percent : null,
      copy.changeNew
    );
    return `- ${labels[metric]}: ${current} (${previous} last month, ${change})`;
  }).join("\n");

  const signoff = emailMessagesForLocale(locale).ncSignoff;
  const text = [
    intro,
    report.previous
      ? fmtEmail(copy.tableCaption, { month, previousMonth })
      : month,
    textTable,
    ...tail,
    fmtEmail(copy.fallback, { analyticsUrl }),
    signoff
  ].join("\n\n");

  const html = buildBrandedEmailHtml({
    siteUrl: site,
    documentTitle: subject,
    heading,
    bodyBlocks: [
      { kind: "text", text: intro },
      {
        kind: "raw",
        html: tableHtml(
          report.latest,
          report.previous,
          report.changes,
          labels,
          {
            metric: copy.colMetric,
            current: fmtEmail(copy.colCurrent, { month }),
            previous: report.previous
              ? fmtEmail(copy.colPrevious, { previousMonth })
              : copy.changeNew,
            change: copy.colChange
          },
          copy.changeNew
        )
      },
      ...tail.map((t) => ({ kind: "text" as const, text: t }))
    ],
    cta: { label: copy.cta, href: analyticsUrl },
    includeFallbackLink: true,
    recipientEmail: input.recipientEmail,
    unsubscribeUrl: input.unsubscribeUrl ?? null
  });

  return { subject, text, html };
}
