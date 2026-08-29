import { describe, it, expect, vi } from "vitest";
import { sweepMonthlyGrowthEmails } from "@/lib/analytics/monthly-growth-sweep";
import type { GrowthReport } from "@/lib/analytics/growth-report";
import type { BusinessRow } from "@/lib/db/businesses";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

/** Sep 4 2026: past the send day, so August is the month being reported. */
const NOW = new Date("2026-09-04T16:20:00.000Z");
const MONTH = "2026-08";

const biz = (over: Partial<BusinessRow> & { monthly_growth_email_sent_for?: string | null } = {}) =>
  ({
    id: "biz-1",
    name: "Amy Laidlaw Real Estate",
    owner_email: "amy@example.com",
    owner_name: "Amy Laidlaw",
    status: "online",
    ...over
  }) as BusinessRow & { monthly_growth_email_sent_for?: string | null };

/**
 * The sweep takes `loadReport` as a dependency, so a report is plain input
 * here. Its own construction is asserted in analytics-growth-report.test.ts
 * against the real loader; duplicating that here would only re-test the
 * producer through a second door.
 */
function month(name: string, over: Partial<GrowthReport["months"][number]> = {}) {
  return {
    month: name,
    leads: 20,
    texts: 30,
    calls: 3,
    voiceMinutes: 6,
    coveredDays: 31,
    daysInMonth: 31,
    ...over
  };
}

function reportWith(over: { leads?: number; texts?: number; calls?: number } = {}): GrowthReport {
  const previous = month("2026-07", { leads: 10 });
  const latest = month("2026-08", {
    leads: over.leads ?? 20,
    texts: over.texts ?? 30,
    calls: over.calls ?? 3
  });
  return {
    months: [previous, latest],
    latest,
    previous,
    changes: null,
    projection: null,
    latestMonthIncomplete: false
  };
}

const EMPTY_REPORT: GrowthReport = {
  months: [],
  latest: null,
  previous: null,
  changes: null,
  projection: null,
  latestMonthIncomplete: false
};

/** Client mock that only has to answer the claim update. */
function claimClient(won = true) {
  const update = vi.fn();
  const client = {
    from: () => ({
      update: (patch: unknown) => {
        update(patch);
        return {
          eq: () => ({
            or: () => ({
              select: () => ({
                maybeSingle: async () => ({ data: won ? { id: "biz-1" } : null, error: null })
              })
            })
          })
        };
      }
    })
  } as never;
  return { client, update };
}

/** The body of the first send: the options argument sendOwnerEmail received. */
function sentBody(sendEmail: unknown): { text: string; html: string } {
  const calls = (sendEmail as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[0]![3] as { text: string; html: string };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    client: claimClient().client,
    now: NOW,
    siteUrl: "https://www.newcoworker.com",
    resendApiKey: "re_test",
    loadBusinesses: vi.fn(async () => [biz()]),
    loadReport: vi.fn(async () => reportWith()),
    loadPreferences: vi.fn(
      async () => ({ unsubscribed_at: null, email_monthly_recap: true }) as never
    ),
    sendEmail: vi.fn(async () => "msg-1"),
    resolveLocale: vi.fn(async () => "en" as const),
    ...over
  };
}

describe("timing", () => {
  it("reports the month before the current one", async () => {
    const result = await sweepMonthlyGrowthEmails(deps());
    expect(result.month).toBe(MONTH);
  });

  it("waits until the previous month's snapshots have settled, then sends", async () => {
    for (const iso of ["2026-09-01T00:00:00Z", "2026-09-02T23:59:00Z"]) {
      const d = deps({ now: new Date(iso) });
      expect((await sweepMonthlyGrowthEmails(d)).sent).toBe(0);
      expect(d.loadBusinesses).not.toHaveBeenCalled();
    }
    const d = deps({ now: new Date("2026-09-03T00:00:00Z") });
    expect((await sweepMonthlyGrowthEmails(d)).sent).toBe(1);
  });

  it("does nothing at all before the send day", async () => {
    const d = deps({ now: new Date("2026-09-01T16:20:00Z") });
    const result = await sweepMonthlyGrowthEmails(d);
    expect(result).toMatchObject({ scanned: 0, sent: 0, skipped: 0 });
    expect(d.loadBusinesses).not.toHaveBeenCalled();
  });

  it("rolls the reported month back across a year boundary", async () => {
    const result = await sweepMonthlyGrowthEmails(deps({ now: new Date("2027-01-04T00:00:00Z") }));
    expect(result.month).toBe("2026-12");
  });
});

describe("who is skipped", () => {
  const only = async (over: Record<string, unknown>) => {
    const d = deps(over);
    const result = await sweepMonthlyGrowthEmails(d);
    return { result, d };
  };

  it("does not even scan one already stamped with this month", async () => {
    const { result, d } = await only({
      loadBusinesses: vi.fn(async () => [biz({ monthly_growth_email_sent_for: MONTH })])
    });
    expect(result.scanned).toBe(0);
    expect(result.sent).toBe(0);
    expect(d.loadReport).not.toHaveBeenCalled();
  });

  it("still sends when the stamp is an older month", async () => {
    const { result } = await only({
      loadBusinesses: vi.fn(async () => [biz({ monthly_growth_email_sent_for: "2026-07" })])
    });
    expect(result.sent).toBe(1);
  });

  it("skips a wiped tenant and one with no owner email", async () => {
    const { result } = await only({
      loadBusinesses: vi.fn(async () => [
        biz({ id: "a", status: "wiped" }),
        biz({ id: "b", owner_email: "  " })
      ])
    });
    expect(result.skipReasons).toEqual({ wiped: 1, no_owner_email: 1 });
  });
});

describe("the claim", () => {
  it("stamps the month before sending", async () => {
    const { client, update } = claimClient(true);
    const d = deps({ client });
    await sweepMonthlyGrowthEmails(d);
    expect(update).toHaveBeenCalledWith({ monthly_growth_email_sent_for: MONTH });
  });

  it("records a write error as a per-business error rather than sending anyway", async () => {
    const client = {
      from: () => ({
        update: () => ({
          eq: () => ({
            or: () => ({
              select: () => ({
                maybeSingle: async () => ({ data: null, error: { message: "denied" } })
              })
            })
          })
        })
      })
    } as never;
    const d = deps({ client });
    const result = await sweepMonthlyGrowthEmails(d);
    expect(result.errors).toEqual([
      { businessId: "biz-1", message: "claimGrowthEmail: denied" }
    ]);
    expect(d.sendEmail).not.toHaveBeenCalled();
  });
});

describe("sweepMonthlyGrowthEmails", () => {
  it("sends one recap to a healthy tenant", async () => {
    const d = deps();
    const result = await sweepMonthlyGrowthEmails(d);
    expect(result).toMatchObject({ scanned: 1, sent: 1, skipped: 0, errors: [] });
    expect(d.sendEmail).toHaveBeenCalledWith(
      "re_test",
      "amy@example.com",
      expect.stringContaining("August 2026"),
      expect.objectContaining({ text: expect.stringContaining("New leads captured: 20") })
    );
  });

  it("carries a per-business unsubscribe link into the email", async () => {
    const d = deps();
    await sweepMonthlyGrowthEmails(d);
    const html = sentBody(d.sendEmail).html;
    expect(html).toContain("/api/notifications/unsubscribe?bid=biz-1");
  });

  it("sends nothing and says why when Resend is not configured", async () => {
    const d = deps({ resendApiKey: null });
    const result = await sweepMonthlyGrowthEmails(d);
    expect(result).toMatchObject({ scanned: 1, sent: 0, skipped: 1 });
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it("respects a global unsubscribe", async () => {
    const d = deps({
      loadPreferences: vi.fn(
        async () =>
          ({ unsubscribed_at: "2026-08-01T00:00:00Z", email_monthly_recap: true }) as never
      )
    });
    const result = await sweepMonthlyGrowthEmails(d);
    expect(result.skipReasons).toEqual({ unsubscribed: 1 });
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it("respects the recap's own off-switch without touching anything else", async () => {
    const d = deps({
      loadPreferences: vi.fn(
        async () => ({ unsubscribed_at: null, email_monthly_recap: false }) as never
      )
    });
    const result = await sweepMonthlyGrowthEmails(d);
    expect(result.skipReasons).toEqual({ recap_declined: 1 });
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it("still sends to a row written before the recap flag existed", async () => {
    const d = deps({
      loadPreferences: vi.fn(async () => ({ unsubscribed_at: null }) as never)
    });
    expect((await sweepMonthlyGrowthEmails(d)).sent).toBe(1);
  });

  it("points the footer link at the recap-only opt-out, not the global one", async () => {
    const d = deps();
    await sweepMonthlyGrowthEmails(d);
    const html = sentBody(d.sendEmail).html;
    // `&amp;` because the branded builder escapes href attributes, which is
    // what makes the rendered link valid HTML.
    expect(html).toContain("bid=biz-1&amp;scope=monthly_recap");
  });

  it("treats a preferences read failure as unsubscribed rather than mailing anyway", async () => {
    const d = deps({
      loadPreferences: vi.fn(async () => {
        throw new Error("prefs down");
      })
    });
    const result = await sweepMonthlyGrowthEmails(d);
    expect(result.skipReasons).toEqual({ unsubscribed: 1 });
  });

  it("skips a tenant with no complete month", async () => {
    const d = deps({ loadReport: vi.fn(async () => EMPTY_REPORT) });
    const result = await sweepMonthlyGrowthEmails(d);
    expect(result.skipReasons).toEqual({ no_complete_month: 1 });
  });

  it("refuses to mail an older month under this month's stamp", async () => {
    // A tenant whose newest MEASURED month is July while the pass is claiming
    // August: sending would stamp August and mail a July recap, and the stamp
    // would then stop August ever going out.
    const july = month("2026-07");
    const stale: GrowthReport = {
      months: [july],
      latest: july,
      previous: null,
      changes: null,
      projection: null,
      latestMonthIncomplete: false
    };
    const d = deps({ loadReport: vi.fn(async () => stale) });
    const result = await sweepMonthlyGrowthEmails(d);
    expect(result.skipReasons).toEqual({ no_data_for_month: 1 });
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it("skips a silent month rather than mailing a table of zeros", async () => {
    const d = deps({ loadReport: vi.fn(async () => reportWith({ leads: 0, texts: 0, calls: 0 })) });
    const result = await sweepMonthlyGrowthEmails(d);
    expect(result.skipReasons).toEqual({ no_activity: 1 });
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it("skips when another pass won the claim first", async () => {
    const d = deps({ client: claimClient(false).client });
    const result = await sweepMonthlyGrowthEmails(d);
    expect(result.skipReasons).toEqual({ already_sent: 1 });
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it("records a send failure per business and keeps going", async () => {
    const d = deps({
      loadBusinesses: vi.fn(async () => [biz(), biz({ id: "biz-2", name: "KYP Ads" })]),
      sendEmail: vi
        .fn()
        .mockRejectedValueOnce(new Error("resend 500"))
        .mockResolvedValueOnce("msg-2")
    });
    const result = await sweepMonthlyGrowthEmails(d);
    expect(result.sent).toBe(1);
    expect(result.errors).toEqual([{ businessId: "biz-1", message: "resend 500" }]);
  });

  it("stringifies a non-Error failure", async () => {
    const d = deps({
      sendEmail: vi.fn(async () => {
        throw "kaput";
      })
    });
    const result = await sweepMonthlyGrowthEmails(d);
    expect(result.errors).toEqual([{ businessId: "biz-1", message: "kaput" }]);
  });

  it("counts each skip reason separately", async () => {
    const d = deps({
      loadBusinesses: vi.fn(async () => [
        biz({ id: "a", status: "wiped" }),
        biz({ id: "b", owner_email: "" }),
        biz({ id: "c", monthly_growth_email_sent_for: MONTH })
      ])
    });
    const result = await sweepMonthlyGrowthEmails(d);
    // The stamped row never enters the candidate set, so it is not "skipped",
    // it is simply not scanned.
    expect(result.scanned).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.skipReasons).toEqual({ wiped: 1, no_owner_email: 1 });
  });

  it("caps one pass so a large fleet cannot run past the route budget", async () => {
    const many = Array.from({ length: 205 }, (_, i) => biz({ id: `biz-${i}` }));
    const d = deps({ loadBusinesses: vi.fn(async () => many) });
    const result = await sweepMonthlyGrowthEmails(d);
    expect(result.scanned).toBe(200);
  });

  it("does not let already-reported tenants crowd out the ones still waiting", async () => {
    // listBusinesses is newest-first. Capping the raw list meant that once the
    // fleet passed the batch limit, every pass walked the same newest N, whose
    // stamps made them no-ops, and the older tenants never got a recap at all.
    const stamped = Array.from({ length: 200 }, (_, i) =>
      biz({ id: `sent-${i}`, monthly_growth_email_sent_for: MONTH })
    );
    const waiting = Array.from({ length: 3 }, (_, i) => biz({ id: `waiting-${i}` }));
    const d = deps({ loadBusinesses: vi.fn(async () => [...stamped, ...waiting]) });
    const result = await sweepMonthlyGrowthEmails(d);
    expect(result.scanned).toBe(3);
    expect(result.sent).toBe(3);
  });

  it("falls back to the app URL env and the wall clock when neither is given", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const previousUrl = process.env.NEXT_PUBLIC_APP_URL;
    const previousKey = process.env.RESEND_API_KEY;
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com/";
    process.env.RESEND_API_KEY = "re_env";
    try {
      const d = deps();
      const result = await sweepMonthlyGrowthEmails({
        client: d.client,
        loadBusinesses: d.loadBusinesses,
        loadReport: d.loadReport,
        loadPreferences: d.loadPreferences,
        sendEmail: d.sendEmail,
        resolveLocale: d.resolveLocale
      });
      expect(result.month).toBe(MONTH);
      expect(result.sent).toBe(1);
      const html = sentBody(d.sendEmail).html;
      expect(html).toContain("https://app.example.com/dashboard/analytics");
    } finally {
      process.env.NEXT_PUBLIC_APP_URL = previousUrl;
      process.env.RESEND_API_KEY = previousKey;
      vi.useRealTimers();
    }
  });

  it("falls back to localhost when no app URL is configured", async () => {
    const previousUrl = process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    try {
      const d = deps({ siteUrl: undefined });
      await sweepMonthlyGrowthEmails(d);
      const html = sentBody(d.sendEmail).html;
      expect(html).toContain("http://localhost:3000/dashboard/analytics");
    } finally {
      process.env.NEXT_PUBLIC_APP_URL = previousUrl;
    }
  });

  it("greets without a name when the business has no owner_name", async () => {
    const d = deps({ loadBusinesses: vi.fn(async () => [biz({ owner_name: null })]) });
    await sweepMonthlyGrowthEmails(d);
    const text = sentBody(d.sendEmail).text;
    expect(text).toMatch(/^Hi,/);
  });

  it("treats a missing RESEND_API_KEY env as no key rather than crashing", async () => {
    const previous = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      const d = deps();
      const result = await sweepMonthlyGrowthEmails({
        client: d.client,
        now: NOW,
        siteUrl: d.siteUrl,
        loadBusinesses: d.loadBusinesses,
        loadReport: d.loadReport,
        loadPreferences: d.loadPreferences,
        sendEmail: d.sendEmail,
        resolveLocale: d.resolveLocale
      });
      expect(result).toMatchObject({ sent: 0, skipped: 1 });
      expect(d.sendEmail).not.toHaveBeenCalled();
    } finally {
      process.env.RESEND_API_KEY = previous;
    }
  });
});
