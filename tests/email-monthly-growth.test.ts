import { describe, it, expect } from "vitest";
import {
  buildMonthlyGrowthEmail,
  changeLabel,
  greetingSuffix,
  monthLabel,
  nextMonthOf
} from "@/lib/email/templates/monthly-growth";
import { composeGrowthReport, type SnapshotRow } from "@/lib/analytics/growth-report";

const SITE = "https://www.newcoworker.com";

const snapshot = (date: string, over: Partial<SnapshotRow> = {}): SnapshotRow => ({
  snapshot_date: date,
  calls: 0,
  sms_sent: 0,
  voice_minutes: 0,
  ...over
});

/** A full-month report: 31 covered days so nothing is flagged incomplete. */
function fullMonth(month: string, per: { calls: number; sms: number; minutes: number }) {
  const days = Number(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate());
  return Array.from({ length: days }, (_, i) =>
    snapshot(`${month}-${String(i + 1).padStart(2, "0")}`, {
      calls: per.calls,
      sms_sent: per.sms,
      voice_minutes: per.minutes
    })
  );
}

const THREE_MONTHS = composeGrowthReport({
  months: ["2026-06", "2026-07", "2026-08"],
  snapshots: [
    ...fullMonth("2026-06", { calls: 1, sms: 10, minutes: 2 }),
    ...fullMonth("2026-07", { calls: 2, sms: 20, minutes: 4 }),
    ...fullMonth("2026-08", { calls: 3, sms: 30, minutes: 6 })
  ],
  leadsByMonth: new Map([
    ["2026-06", 51],
    ["2026-07", 108],
    ["2026-08", 127]
  ])
});

const base = {
  businessName: "Amy Laidlaw Real Estate",
  ownerName: "Amy Laidlaw",
  recipientEmail: "amy@example.com",
  siteUrl: SITE
};

describe("small helpers", () => {
  it("labels a month in the recipient's language", () => {
    expect(monthLabel("2026-08", "en")).toBe("August 2026");
    expect(monthLabel("2026-08", "es")).toContain("2026");
  });

  it("rolls a month forward across a year boundary", () => {
    expect(nextMonthOf("2026-08")).toBe("2026-09");
    expect(nextMonthOf("2026-12")).toBe("2027-01");
  });

  it("greets by first name only, and gracefully with no name", () => {
    expect(greetingSuffix("Amy Laidlaw")).toBe(" Amy");
    expect(greetingSuffix("Amy")).toBe(" Amy");
    expect(greetingSuffix("   ")).toBe("");
    expect(greetingSuffix(null)).toBe("");
    expect(greetingSuffix(undefined)).toBe("");
  });

  it("signs a change and falls back to a word when there is no baseline", () => {
    expect(changeLabel(17.6, "new")).toBe("+18%");
    expect(changeLabel(-8.2, "new")).toBe("-8%");
    expect(changeLabel(0, "new")).toBe("0%");
    expect(changeLabel(null, "new")).toBe("new");
  });
});

describe("buildMonthlyGrowthEmail", () => {
  it("returns null when there is no complete month to report", () => {
    const empty = composeGrowthReport({ months: [], snapshots: [], leadsByMonth: new Map() });
    expect(buildMonthlyGrowthEmail({ ...base, report: empty })).toBeNull();
  });

  it("names the business and the month in the subject", () => {
    const email = buildMonthlyGrowthEmail({ ...base, report: THREE_MONTHS })!;
    expect(email.subject).toBe("Amy Laidlaw Real Estate: your August 2026 recap");
  });

  it("puts every metric and its comparison in the plain-text part", () => {
    const email = buildMonthlyGrowthEmail({ ...base, report: THREE_MONTHS })!;
    expect(email.text).toContain("Hi Amy");
    expect(email.text).toContain("New leads captured: 127 (108 last month, +18%)");
    expect(email.text).toContain("Texts sent: 930 (620 last month, +50%)");
    expect(email.text).toContain("Calls answered: 93 (62 last month, +50%)");
    expect(email.text).toContain("Minutes on the phone: 186 (124 last month, +50%)");
  });

  it("describes the span and hedges the projection", () => {
    const email = buildMonthlyGrowthEmail({ ...base, report: THREE_MONTHS })!;
    expect(email.text).toContain("Over the last 3 months");
    expect(email.text.toLowerCase()).toContain("from 51 to 127");
    expect(email.text).toContain("September 2026");
    expect(email.text).toContain("not a promise");
  });

  it("renders an HTML table with the numbers escaped into it", () => {
    const email = buildMonthlyGrowthEmail({ ...base, report: THREE_MONTHS })!;
    expect(email.html).toContain("<table");
    expect(email.html).toContain("New leads captured");
    expect(email.html).toContain("127");
    expect(email.html).toContain(`${SITE}/dashboard/analytics`);
  });

  it("escapes a business name that contains markup", () => {
    const email = buildMonthlyGrowthEmail({
      ...base,
      businessName: '<script>alert("x")</script>',
      report: THREE_MONTHS
    })!;
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("omits the trend and projection lines on a first full month", () => {
    const firstMonth = composeGrowthReport({
      months: ["2026-08"],
      snapshots: fullMonth("2026-08", { calls: 3, sms: 30, minutes: 6 }),
      leadsByMonth: new Map([["2026-08", 12]])
    });
    const email = buildMonthlyGrowthEmail({ ...base, report: firstMonth })!;
    expect(email.text).not.toContain("If that pace holds");
    expect(email.text).not.toContain("have gone from");
    // The first-month greeting, not the comparison one.
    expect(email.text).toContain("your first full month");
    expect(email.text).toContain("New leads captured: 12 (- last month, new)");
  });

  it("omits only the projection when there are two months but not three", () => {
    const twoMonths = composeGrowthReport({
      months: ["2026-07", "2026-08"],
      snapshots: [
        ...fullMonth("2026-07", { calls: 1, sms: 10, minutes: 2 }),
        ...fullMonth("2026-08", { calls: 2, sms: 20, minutes: 4 })
      ],
      leadsByMonth: new Map([
        ["2026-07", 10],
        ["2026-08", 20]
      ])
    });
    const email = buildMonthlyGrowthEmail({ ...base, report: twoMonths })!;
    expect(email.text).toContain("from 10 to 20");
    expect(email.text).not.toContain("If that pace holds");
  });

  it("says how much of a partial month is actually counted", () => {
    const partial = composeGrowthReport({
      months: ["2026-08"],
      snapshots: fullMonth("2026-08", { calls: 1, sms: 5, minutes: 1 }).slice(0, 9),
      leadsByMonth: new Map([["2026-08", 4]])
    });
    const email = buildMonthlyGrowthEmail({ ...base, report: partial })!;
    expect(email.text).toContain("9 of its 31 days");
  });

  it("says nothing about coverage when the month is fully covered", () => {
    const email = buildMonthlyGrowthEmail({ ...base, report: THREE_MONTHS })!;
    expect(email.text).not.toContain("of its 31 days");
  });

  it("states a fall plainly instead of colouring it alarming", () => {
    const falling = composeGrowthReport({
      months: ["2026-07", "2026-08"],
      snapshots: [
        ...fullMonth("2026-07", { calls: 4, sms: 40, minutes: 8 }),
        ...fullMonth("2026-08", { calls: 1, sms: 10, minutes: 2 })
      ],
      leadsByMonth: new Map([
        ["2026-07", 100],
        ["2026-08", 40]
      ])
    });
    const email = buildMonthlyGrowthEmail({ ...base, report: falling })!;
    expect(email.text).toContain("New leads captured: 40 (100 last month, -60%)");
    // Only a rise is coloured; a fall stays in the muted body colour.
    expect(email.html).not.toContain("#1BD96A;font-weight:600");
  });

  it("carries the unsubscribe link into the HTML when given one", () => {
    const email = buildMonthlyGrowthEmail({
      ...base,
      report: THREE_MONTHS,
      unsubscribeUrl: `${SITE}/api/notifications/unsubscribe?bid=abc`
    })!;
    expect(email.html).toContain("unsubscribe?bid=abc");
  });

  it("builds a Spanish recap when the owner reads Spanish", () => {
    const email = buildMonthlyGrowthEmail({ ...base, report: THREE_MONTHS, locale: "es" })!;
    expect(email.subject).toContain("tu resumen");
    expect(email.text).toContain("Nuevos clientes potenciales: 127");
  });

  it("tolerates a site URL with a trailing slash", () => {
    const email = buildMonthlyGrowthEmail({
      ...base,
      siteUrl: `${SITE}/`,
      report: THREE_MONTHS
    })!;
    expect(email.text).toContain(`${SITE}/dashboard/analytics`);
    expect(email.text).not.toContain("//dashboard");
  });
});
