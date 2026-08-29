import { describe, it, expect, vi } from "vitest";
import {
  GROWTH_EMAIL_BATCH_LIMIT,
  GROWTH_EMAIL_SEND_DAY,
  claimGrowthEmail,
  isSendWindowOpen,
  preflightSkip,
  sweepMonthlyGrowthEmails
} from "@/lib/analytics/monthly-growth-sweep";
import { composeGrowthReport, type GrowthReport } from "@/lib/analytics/growth-report";
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

function reportWith(over: { leads?: number; texts?: number; calls?: number } = {}): GrowthReport {
  return composeGrowthReport({
    months: ["2026-07", "2026-08"],
    snapshots: [
      {
        snapshot_date: "2026-08-01",
        calls: over.calls ?? 3,
        sms_sent: over.texts ?? 30,
        voice_minutes: 6
      }
    ],
    leadsByMonth: new Map([
      ["2026-07", 10],
      ["2026-08", over.leads ?? 20]
    ])
  });
}

const EMPTY_REPORT = composeGrowthReport({ months: [], snapshots: [], leadsByMonth: new Map() });

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
    loadPreferences: vi.fn(async () => ({ unsubscribed_at: null }) as never),
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

  it("waits until the previous month's snapshots have settled", () => {
    expect(GROWTH_EMAIL_SEND_DAY).toBe(3);
    expect(isSendWindowOpen(new Date("2026-09-01T00:00:00Z"))).toBe(false);
    expect(isSendWindowOpen(new Date("2026-09-02T23:59:00Z"))).toBe(false);
    expect(isSendWindowOpen(new Date("2026-09-03T00:00:00Z"))).toBe(true);
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

describe("preflightSkip", () => {
  it("passes a healthy, subscribed, unsent business", () => {
    expect(preflightSkip(biz(), MONTH, false)).toBeNull();
  });

  it("skips one already sent this month", () => {
    expect(preflightSkip(biz({ monthly_growth_email_sent_for: MONTH }), MONTH, false)).toBe(
      "already_sent"
    );
  });

  it("still sends when the stamp is an older month", () => {
    expect(preflightSkip(biz({ monthly_growth_email_sent_for: "2026-07" }), MONTH, false)).toBeNull();
  });

  it("skips a wiped tenant, one with no owner email, and one unsubscribed", () => {
    expect(preflightSkip(biz({ status: "wiped" }), MONTH, false)).toBe("wiped");
    expect(preflightSkip(biz({ owner_email: "  " }), MONTH, false)).toBe("no_owner_email");
    expect(preflightSkip(biz(), MONTH, true)).toBe("unsubscribed");
  });
});

describe("claimGrowthEmail", () => {
  it("stamps the month and reports the win", async () => {
    const { client, update } = claimClient(true);
    await expect(claimGrowthEmail(client, "biz-1", MONTH)).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith({ monthly_growth_email_sent_for: MONTH });
  });

  it("reports a loss when the row was already claimed", async () => {
    const { client } = claimClient(false);
    await expect(claimGrowthEmail(client, "biz-1", MONTH)).resolves.toBe(false);
  });

  it("throws on a write error rather than silently not sending", async () => {
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
    await expect(claimGrowthEmail(client, "biz-1", MONTH)).rejects.toThrow(
      /claimGrowthEmail: denied/
    );
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
      loadPreferences: vi.fn(async () => ({ unsubscribed_at: "2026-08-01T00:00:00Z" }) as never)
    });
    const result = await sweepMonthlyGrowthEmails(d);
    expect(result.skipReasons).toEqual({ unsubscribed: 1 });
    expect(d.sendEmail).not.toHaveBeenCalled();
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
    const stale = composeGrowthReport({
      months: ["2026-07"],
      snapshots: [{ snapshot_date: "2026-07-15", calls: 3, sms_sent: 30, voice_minutes: 6 }],
      leadsByMonth: new Map([["2026-07", 20]])
    });
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
    expect(result.skipped).toBe(3);
    expect(result.skipReasons).toEqual({ wiped: 1, no_owner_email: 1, already_sent: 1 });
  });

  it("caps one pass so a large fleet cannot run past the route budget", async () => {
    const many = Array.from({ length: GROWTH_EMAIL_BATCH_LIMIT + 5 }, (_, i) =>
      biz({ id: `biz-${i}` })
    );
    const d = deps({ loadBusinesses: vi.fn(async () => many) });
    const result = await sweepMonthlyGrowthEmails(d);
    expect(result.scanned).toBe(GROWTH_EMAIL_BATCH_LIMIT);
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
