/**
 * The template's small helpers (month label, greeting, change label) are
 * module-private: an export whose only caller is a test is dead code wearing
 * coverage (scripts/knip-exports-ratchet.mjs). They are asserted here through
 * the rendered email, which is the only thing anyone actually reads.
 *
 * Reports are built through the real `loadGrowthReport` rather than
 * hand-assembled, so a shape the producer cannot emit cannot pass here. See
 * .cursor/memory/feedback_assert_the_producer_not_the_fixture.md.
 */
import { describe, it, expect, vi } from "vitest";
import { buildMonthlyGrowthEmail } from "@/lib/email/templates/monthly-growth";
import { loadGrowthReport, type GrowthReport } from "@/lib/analytics/growth-report";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/residency/read", () => ({
  isVpsReadMode: vi.fn(async () => false),
  countMovedRows: vi.fn(async () => 0)
}));

const SITE = "https://www.newcoworker.com";

/** Sep 4 2026, so August is the newest complete month. */
const NOW = new Date("2026-09-04T00:00:00.000Z");

type SnapshotRow = {
  snapshot_date: string;
  calls: number | null;
  sms_sent: number | null;
  voice_minutes: number | null;
};

/** Every day of `month` carrying the same counters. */
function fullMonth(
  month: string,
  per: { calls: number; sms: number; minutes: number }
): SnapshotRow[] {
  const days = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)
  ).getUTCDate();
  return Array.from({ length: days }, (_, i) => ({
    snapshot_date: `${month}-${String(i + 1).padStart(2, "0")}`,
    calls: per.calls,
    sms_sent: per.sms,
    voice_minutes: per.minutes
  }));
}

async function reportFor(
  snapshots: SnapshotRow[],
  leads: number[],
  months: number,
  now: Date = NOW
): Promise<GrowthReport> {
  let i = 0;
  // Thenable rather than resolving on a terminal method: the snapshot query
  // has no upper bound (the days after the reported month answer "are they
  // still active?"), so a mock keyed to `.lt()` would hand back the builder.
  const builder = (result: () => unknown): Record<string, unknown> => {
    const b: Record<string, unknown> = {
      then: (onFulfilled?: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) =>
        Promise.resolve(result()).then(onFulfilled, onRejected)
    };
    for (const method of ["select", "eq", "gte", "lt", "order"]) b[method] = () => b;
    return b;
  };
  const snapshotBuilder = builder(() => ({ data: snapshots, error: null }));
  return await loadGrowthReport("biz-1", {
    client: {
      from: (t: string) =>
        t === "analytics_daily_snapshots"
          ? snapshotBuilder
          : builder(() => ({ count: leads[i++] ?? 0, error: null }))
    } as never,
    now,
    months
  });
}

const base = {
  businessName: "Amy Laidlaw Real Estate",
  ownerName: "Amy Laidlaw",
  recipientEmail: "amy@example.com",
  siteUrl: SITE
};

/** Three rising months: the shape that produces every optional line. */
const threeMonths = () =>
  reportFor(
    [
      ...fullMonth("2026-06", { calls: 1, sms: 10, minutes: 2 }),
      ...fullMonth("2026-07", { calls: 2, sms: 20, minutes: 4 }),
      ...fullMonth("2026-08", { calls: 3, sms: 30, minutes: 6 })
    ],
    [51, 108, 127],
    3
  );

describe("buildMonthlyGrowthEmail", () => {
  it("returns null when there is no complete month to report", async () => {
    const empty = await reportFor([], [], 0);
    expect(buildMonthlyGrowthEmail({ ...base, report: empty })).toBeNull();
  });

  it("names the business and the month in the subject", async () => {
    const email = buildMonthlyGrowthEmail({ ...base, report: await threeMonths() })!;
    expect(email.subject).toBe("Amy Laidlaw Real Estate: your August 2026 recap");
  });

  it("greets by first name only", async () => {
    const report = await threeMonths();
    expect(buildMonthlyGrowthEmail({ ...base, report })!.text).toMatch(/^Hi Amy,/);
    expect(
      buildMonthlyGrowthEmail({ ...base, ownerName: "Amy", report })!.text
    ).toMatch(/^Hi Amy,/);
  });

  it("greets without a name when there is none to use", async () => {
    const report = await threeMonths();
    for (const ownerName of ["   ", null, undefined]) {
      expect(buildMonthlyGrowthEmail({ ...base, ownerName, report })!.text).toMatch(/^Hi,/);
    }
  });

  it("puts every metric and its comparison in the plain-text part", async () => {
    const email = buildMonthlyGrowthEmail({ ...base, report: await threeMonths() })!;
    expect(email.text).toContain("New leads captured: 127 (108 last month, +18%)");
    expect(email.text).toContain("Texts sent: 930 (620 last month, +50%)");
    expect(email.text).toContain("Calls answered: 93 (62 last month, +50%)");
    expect(email.text).toContain("Minutes on the phone: 186 (124 last month, +50%)");
  });

  it("describes the span and hedges the projection", async () => {
    const email = buildMonthlyGrowthEmail({ ...base, report: await threeMonths() })!;
    expect(email.text).toContain("Over the last 3 months");
    expect(email.text).toContain("from 51 to 127");
    expect(email.text).toContain("September 2026");
    expect(email.text).toContain("not a promise");
  });

  it("rolls the projected month across a year boundary", async () => {
    const report = await reportFor(
      [
        ...fullMonth("2026-10", { calls: 1, sms: 10, minutes: 2 }),
        ...fullMonth("2026-11", { calls: 2, sms: 20, minutes: 4 }),
        ...fullMonth("2026-12", { calls: 3, sms: 30, minutes: 6 })
      ],
      [10, 20, 30],
      3,
      new Date("2027-01-04T00:00:00Z")
    );
    const email = buildMonthlyGrowthEmail({ ...base, report })!;
    expect(email.subject).toContain("December 2026");
    expect(email.text).toContain("January 2027");
  });

  it("renders an HTML table with the numbers in it", async () => {
    const email = buildMonthlyGrowthEmail({ ...base, report: await threeMonths() })!;
    expect(email.html).toContain("<table");
    expect(email.html).toContain("New leads captured");
    expect(email.html).toContain("127");
    expect(email.html).toContain(`${SITE}/dashboard/analytics`);
  });

  it("escapes a business name that contains markup", async () => {
    const email = buildMonthlyGrowthEmail({
      ...base,
      businessName: '<script>alert("x")</script>',
      report: await threeMonths()
    })!;
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("omits the trend and projection lines on a first full month", async () => {
    const report = await reportFor(
      fullMonth("2026-08", { calls: 3, sms: 30, minutes: 6 }),
      [12],
      1
    );
    const email = buildMonthlyGrowthEmail({ ...base, report })!;
    expect(email.text).not.toContain("If that pace holds");
    expect(email.text).not.toContain("have gone from");
    expect(email.text).toContain("your first full month");
    expect(email.text).toContain("New leads captured: 12 (- last month, new)");
  });

  it("omits only the projection when there are two months but not three", async () => {
    const report = await reportFor(
      [
        ...fullMonth("2026-07", { calls: 1, sms: 10, minutes: 2 }),
        ...fullMonth("2026-08", { calls: 2, sms: 20, minutes: 4 })
      ],
      [10, 20],
      2
    );
    const email = buildMonthlyGrowthEmail({ ...base, report })!;
    expect(email.text).toContain("from 10 to 20");
    expect(email.text).not.toContain("If that pace holds");
  });

  it("says how much of a partial month is actually counted", async () => {
    const report = await reportFor(
      fullMonth("2026-08", { calls: 1, sms: 5, minutes: 1 }).slice(0, 9),
      [4],
      1
    );
    const email = buildMonthlyGrowthEmail({ ...base, report })!;
    expect(email.text).toContain("9 of its 31 days");
  });

  it("says nothing about coverage when the month is fully covered", async () => {
    const email = buildMonthlyGrowthEmail({ ...base, report: await threeMonths() })!;
    expect(email.text).not.toContain("of its 31 days");
  });

  it("states a fall plainly instead of colouring it alarming", async () => {
    const report = await reportFor(
      [
        ...fullMonth("2026-07", { calls: 4, sms: 40, minutes: 8 }),
        ...fullMonth("2026-08", { calls: 1, sms: 10, minutes: 2 })
      ],
      [100, 40],
      2
    );
    const email = buildMonthlyGrowthEmail({ ...base, report })!;
    expect(email.text).toContain("New leads captured: 40 (100 last month, -60%)");
    // Only a rise is coloured; a fall stays in the muted body colour.
    expect(email.html).not.toContain("#1BD96A;font-weight:600");
  });

  it("does not sign a rounded-to-zero change", async () => {
    const report = await reportFor(
      [
        ...fullMonth("2026-07", { calls: 1, sms: 1000, minutes: 1 }),
        ...fullMonth("2026-08", { calls: 1, sms: 1000, minutes: 1 })
      ],
      [100, 100],
      2
    );
    const email = buildMonthlyGrowthEmail({ ...base, report })!;
    expect(email.text).toContain("last month, 0%)");
  });

  it("carries the unsubscribe link into the HTML when given one", async () => {
    const email = buildMonthlyGrowthEmail({
      ...base,
      report: await threeMonths(),
      unsubscribeUrl: `${SITE}/api/notifications/unsubscribe?bid=abc`
    })!;
    expect(email.html).toContain("unsubscribe?bid=abc");
  });

  it("builds a Spanish recap when the owner reads Spanish", async () => {
    const email = buildMonthlyGrowthEmail({
      ...base,
      report: await threeMonths(),
      locale: "es"
    })!;
    expect(email.subject).toContain("tu resumen");
    expect(email.text).toContain("Nuevos clientes potenciales: 127");
    // The month name is localized too, not left in English.
    expect(email.subject).not.toContain("August");
  });

  it("tolerates a site URL with a trailing slash", async () => {
    const email = buildMonthlyGrowthEmail({
      ...base,
      siteUrl: `${SITE}/`,
      report: await threeMonths()
    })!;
    expect(email.text).toContain(`${SITE}/dashboard/analytics`);
    expect(email.text).not.toContain("//dashboard");
  });
});
