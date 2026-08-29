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
  growthStats,
  type GrowthMetric,
  type GrowthMonth,
  type GrowthReport
} from "@/lib/analytics/growth-report";

export type MonthlyGrowthEmailInput = {
  report: GrowthReport;
  businessName: string;
  /** Owner's display name; only the first word is used, and it may be absent. */
  ownerName?: string | null;
  /**
   * When the business signed up (ISO). Distinguishes "your first month with
   * us" from "the first month we have figures for", which are very different
   * sentences to send a customer who has been here since spring.
   */
  customerSince?: string | null;
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
function monthLabel(month: string, locale: AppLocale): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString(
    locale === "es" ? "es-US" : "en-US",
    { month: "long", year: "numeric", timeZone: "UTC" }
  );
}

/** The month after `month`, as "YYYY-MM". */
function nextMonthOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 7);
}

/**
 * First words that mean the "owner name" is a mailbox or a collective, not a
 * person. Greeting a team inbox by its first word produces "Hi Support," and
 * "Hi The,".
 */
const NON_PERSON_FIRST_WORDS = new Set([
  "the",
  "team",
  "support",
  "admin",
  "info",
  "sales",
  "billing",
  "accounts",
  "office",
  "contact",
  "hello",
  "hi"
]);

/**
 * Words that, appended to the business name, make the whole thing the
 * organisation rather than a person: "New Coworker" + "Team".
 */
const ORG_SUFFIX_WORDS = new Set([
  "team",
  "group",
  "hq",
  "staff",
  "crew",
  "co",
  "company",
  "llc",
  "inc",
  "ltd",
  "agency",
  "partners",
  "associates"
]);

/**
 * " Amy" for a greeting, or "" when the name we hold is not a person's.
 *
 * First word only: owner_name carries a full name, and "Hi Amy Laidlaw," in a
 * monthly note reads like a form letter, which is exactly what this is trying
 * not to be.
 *
 * The hard case is telling an organisation from a person, and BOTH directions
 * of getting it wrong are live in this fleet:
 *
 * - HQ's owner_name is "New Coworker Team" against a business called "New
 *   Coworker", and the first word produced "Hi New," on the first real send;
 * - a realtor's business is very often their own name, so "Amy Laidlaw" for
 *   "Amy Laidlaw", or an owner "Amy Laidlaw" at a business called "Laidlaw".
 *   A blunt "owner name contains business name" rule silences all of those,
 *   which is the same defect wearing different clothes.
 *
 * So the org test is narrow: the owner name must be the business name plus a
 * collective word. Equality is deliberately treated as a PERSON, because in
 * this product a business named exactly after someone is the common case and
 * a nameless "Hi," is the cheaper mistake than "Hi New,".
 */
function greetingSuffix(
  ownerName: string | null | undefined,
  businessName: string
): string {
  const name = (ownerName ?? "").trim();
  if (!name) return "";

  const folded = name.toLowerCase();
  const business = businessName.trim().toLowerCase();
  if (business && folded.startsWith(business)) {
    // Split on anything that is not alphanumeric, not just whitespace. The
    // suffix list is precisely the set of words that normally arrive
    // punctuated ("New Coworker, LLC", "New Coworker Inc."), so tokenizing on
    // spaces alone left `, llc` and `inc.` unmatched and fell straight back to
    // "Hi New," for the exact names this test exists to catch.
    const rest = folded.slice(business.length).split(/[^a-z0-9]+/).filter(Boolean);
    // No leftover tokens means the two are the same string, which reads as a
    // person here.
    if (rest.length > 0 && rest.every((w) => ORG_SUFFIX_WORDS.has(w))) return "";
  }

  // `split(sep, 1).join("")` rather than `[0]`: indexing needs a fallback for
  // an empty result that split can never produce, and an unreachable fallback
  // is a branch nothing can test.
  const first = name.split(/\s+/, 1).join("");
  if (NON_PERSON_FIRST_WORDS.has(first.toLowerCase())) return "";
  return ` ${first}`;
}

/** Minutes render whole; everything else is a plain count. */
function metricValue(metric: GrowthMetric, value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** "+42%" / "-8%" / the localized "new" when there was no previous month. */
function changeLabel(percent: number | null, newLabel: string): string {
  if (percent === null) return newLabel;
  const rounded = Math.round(percent);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

/**
 * Leads by month as horizontal bars.
 *
 * Widths, not heights: an email client will honour a percentage width on a
 * table cell and will not reliably honour a height on a div, so a column
 * chart silently collapses in Outlook while this does not. Everything is a
 * nested table with inline styles for the same reason.
 */
function chartHtml(months: GrowthMonth[], peak: number, title: string): string {
  const rows = months
    .map((m, i) => {
      const isLatest = i === months.length - 1;
      // A month with real leads never renders as nothing: 2% keeps a small
      // month visible next to a big one, which is the honest picture.
      const pct = peak > 0 && m.leads > 0 ? Math.max(Math.round((m.leads / peak) * 100), 2) : 0;
      const colour = isLatest ? "#1BD96A" : "#2f5673";
      const bar =
        pct > 0
          ? `<table role="presentation" cellpadding="0" cellspacing="0" width="${pct}%" ` +
            `style="border-collapse:collapse;"><tr><td style="background-color:${colour};` +
            `height:10px;line-height:10px;font-size:0;border-radius:3px;">&nbsp;</td></tr></table>`
          : "";
      return (
        `<tr>` +
        `<td style="padding:3px 10px 3px 0;font-size:13px;color:#8a9bb0;white-space:nowrap;">` +
        `${escapeHtml(m.month)}</td>` +
        `<td width="100%" style="padding:3px 10px;">${bar}</td>` +
        `<td align="right" style="padding:3px 0;font-size:13px;font-weight:600;` +
        `color:${isLatest ? "#1BD96A" : "#e8eef5"};">${escapeHtml(String(m.leads))}</td>` +
        `</tr>`
      );
    })
    .join("");
  return (
    `<p style="margin:0 0 8px;font-size:14px;color:#8a9bb0;font-weight:600;">` +
    `${escapeHtml(title)}</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" ` +
    `style="border-collapse:collapse;margin:0 0 8px;">${rows}</table>`
  );
}

/**
 * The metrics the table shows: everything except the ones that went DOWN.
 *
 * Brian's call, Aug 2026. Filtered on the ROUNDED percentage so that what is
 * hidden matches what would have been displayed: a -0.4% month renders as
 * "0%", so it stays.
 *
 * A metric with no previous month (`percent === null`, shown as "new") is
 * kept: nothing declined, there is simply nothing to compare against.
 *
 * NOTE the deliberate limit of this. It hides declining ROWS, not declines:
 * the leads chart, the "gone from A to B" line and the "on where you started"
 * percentage all still print a fall, because a recap that could only ever
 * show good news would stop being worth reading. See buildMonthlyGrowthEmail.
 */
function visibleMetrics(changes: GrowthReport["changes"]): GrowthMetric[] {
  if (!changes) return [...GROWTH_METRICS];
  return GROWTH_METRICS.filter((metric) => {
    const percent = changes[metric].percent;
    return percent === null || Math.round(percent) >= 0;
  });
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

  const rows = visibleMetrics(changes).map((metric) => {
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
  const ownerFirstName = greetingSuffix(input.ownerName, input.businessName);
  const stats = growthStats(report);

  const subject = fmtEmail(copy.subject, { businessName: input.businessName, month });
  const heading = fmtEmail(copy.heading, { month });

  // Three cases, not two. "No previous month" used to mean "your first full
  // month", which told Amy, a customer since spring, that July was her first:
  // her June has no snapshot rows because the table only starts in July, not
  // because nothing happened. If the business predates the reported month, say
  // the honest thing instead.
  const startedBeforeReportedMonth =
    typeof input.customerSince === "string" &&
    input.customerSince.slice(0, 7) < report.latest.month;
  const intro = report.previous
    ? fmtEmail(copy.intro, { ownerFirstName, businessName: input.businessName, month })
    : startedBeforeReportedMonth
      ? fmtEmail(copy.firstMeasuredIntro, {
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

  const totalsLine =
    stats.measuredMonths > 1
      ? fmtEmail(copy.totalsLine, {
          monthCount: String(stats.measuredMonths),
          leads: stats.totals.leads.toLocaleString("en-US"),
          texts: stats.totals.texts.toLocaleString("en-US"),
          calls: stats.totals.calls.toLocaleString("en-US"),
          minutes: Math.round(stats.totals.voiceMinutes).toLocaleString("en-US")
        })
      : null;

  const growthPctLine =
    stats.leadsGrowthPct === null
      ? null
      : fmtEmail(copy.growthPctLine, { pct: changeLabel(stats.leadsGrowthPct, copy.changeNew) });

  const bestMonthLine = stats.latestIsBestForLeads
    ? fmtEmail(copy.bestMonthLine, { month })
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

  const tail = [
    trendLine,
    growthPctLine,
    bestMonthLine,
    totalsLine,
    projectionLine,
    projectionCaveat,
    coverageNote
  ].filter((line): line is string => line !== null);

  const shown = visibleMetrics(report.changes);
  const textTable = shown.map((metric) => {
    const current = metricValue(metric, report.latest![metric]);
    const previous = report.previous ? metricValue(metric, report.previous[metric]) : "-";
    const change = changeLabel(
      report.changes ? report.changes[metric].percent : null,
      copy.changeNew
    );
    return `- ${labels[metric]}: ${current} (${previous} last month, ${change})`;
  }).join("\n");

  const chartText =
    stats.measuredMonths > 1
      ? [copy.chartTitle, ...report.months.map((m) => `  ${m.month}: ${m.leads}`)].join("\n")
      : null;

  const signoff = emailMessagesForLocale(locale).ncSignoff;
  // Every metric down means no rows survive the filter. Print no table and no
  // caption rather than a heading over nothing; the chart, the totals and the
  // coverage note still carry the month.
  const tableBlock =
    shown.length > 0
      ? [report.previous ? fmtEmail(copy.tableCaption, { month, previousMonth }) : month, textTable]
      : [];

  const text = [
    intro,
    ...tableBlock,
    ...(chartText ? [chartText] : []),
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
      ...(shown.length === 0
        ? []
        : [{
        kind: "raw" as const,
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
      }]),
      ...(stats.measuredMonths > 1
        ? [
            {
              kind: "raw" as const,
              html: chartHtml(report.months, stats.peakLeads, copy.chartTitle)
            }
          ]
        : []),
      ...tail.map((t) => ({ kind: "text" as const, text: t }))
    ],
    cta: { label: copy.cta, href: analyticsUrl },
    includeFallbackLink: true,
    recipientEmail: input.recipientEmail,
    unsubscribeUrl: input.unsubscribeUrl ?? null
  });

  return { subject, text, html };
}
