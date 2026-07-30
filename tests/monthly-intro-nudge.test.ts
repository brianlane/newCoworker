/**
 * Month-to-month first-month intro nudge: eligibility, claim-before-send, sweep.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => {
    throw new Error("default client must not be used in tests");
  })
}));

import {
  claimMonthlyIntroNudge,
  isFirstBillingCycle,
  isMonthlyIntroNudgeCandidate,
  isMonthlyIntroNudgeDue,
  sweepMonthlyIntroNudges,
  type MonthlyIntroNudgeCandidate
} from "@/lib/billing/monthly-intro-nudge";
import { subtractBusinessDays } from "@/lib/datetime/business-days";
import type { sendOwnerEmail } from "@/lib/email/client";
import type { getBusiness } from "@/lib/db/businesses";
import type { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import type { BusinessRow } from "@/lib/db/businesses";

const BIZ = "11111111-1111-4111-8111-111111111111";
const SUB = "22222222-2222-4222-8222-222222222222";
// Wednesday Aug 12 period end; 5 business days earlier is Wednesday Aug 5
// at the same UTC time (window opens then).
const PERIOD_END = "2026-08-12T18:00:00.000Z";
const NOW = new Date("2026-08-05T18:00:00.000Z");
const PERIOD_START = "2026-07-12T18:00:00.000Z";
const CREATED = "2026-07-12T18:05:00.000Z";

function candidate(overrides: Partial<MonthlyIntroNudgeCandidate> = {}): MonthlyIntroNudgeCandidate {
  return {
    id: SUB,
    business_id: BIZ,
    tier: "standard",
    status: "active",
    billing_period: "monthly",
    cancel_at_period_end: false,
    billing_paused: false,
    stripe_current_period_start: PERIOD_START,
    stripe_current_period_end: PERIOD_END,
    created_at: CREATED,
    monthly_intro_nudge_sent_at: null,
    ...overrides
  };
}

type QueryResult = { data: unknown; error: { message: string } | null };

function makeDb(opts: {
  select?: QueryResult;
  update?: QueryResult;
}) {
  const selectResult = opts.select ?? { data: [], error: null };
  const updateResult = opts.update ?? { data: { id: SUB }, error: null };
  const updateEq = vi.fn();
  const updateIs = vi.fn();

  const chainSelect: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "gt", "lte", "order", "limit"]) {
    chainSelect[m] = vi.fn(() => chainSelect);
  }
  chainSelect.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(selectResult).then(resolve, reject);

  const updateChain = {
    eq: (...args: unknown[]) => {
      updateEq(...args);
      return updateChain;
    },
    is: (...args: unknown[]) => {
      updateIs(...args);
      return updateChain;
    },
    select: () => updateChain,
    maybeSingle: vi.fn(async () => updateResult)
  };

  const root = {
    from: vi.fn((table: string) => {
      expect(table).toBe("subscriptions");
      return {
        select: () => chainSelect,
        update: (patch: unknown) => {
          expect(patch).toMatchObject({ monthly_intro_nudge_sent_at: expect.any(String) });
          return updateChain;
        }
      };
    })
  };

  return { db: root as never, updateEq, updateIs };
}

const ownerBiz = {
  id: BIZ,
  owner_email: "owner@example.com",
  name: "Acme",
  tier: "standard" as const,
  status: "online" as const,
  hostinger_vps_id: null,
  created_at: CREATED
} satisfies Pick<
  BusinessRow,
  "id" | "owner_email" | "name" | "tier" | "status" | "hostinger_vps_id" | "created_at"
>;

describe("isFirstBillingCycle", () => {
  it("accepts created_at within a day of period_start", () => {
    expect(isFirstBillingCycle(CREATED, PERIOD_START, NOW.getTime())).toBe(true);
  });

  it("rejects a renewed period (created long before period_start)", () => {
    expect(
      isFirstBillingCycle("2026-01-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", NOW.getTime())
    ).toBe(false);
  });

  it("rejects missing or unparseable timestamps", () => {
    expect(isFirstBillingCycle(CREATED, null)).toBe(false);
    expect(isFirstBillingCycle("nope", PERIOD_START)).toBe(false);
    expect(isFirstBillingCycle(CREATED, "nope")).toBe(false);
  });

  it("rejects a period_start more than a day in the future", () => {
    const futureStart = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(isFirstBillingCycle(futureStart, futureStart, NOW.getTime())).toBe(false);
  });
});

describe("isMonthlyIntroNudgeDue", () => {
  it("is due inside the 5-business-day window", () => {
    expect(isMonthlyIntroNudgeDue(PERIOD_END, NOW)).toBe(true);
    const windowStart = subtractBusinessDays(new Date(PERIOD_END), 5);
    expect(windowStart.toISOString()).toBe(NOW.toISOString());
  });

  it("is not due before the window or after period end", () => {
    expect(isMonthlyIntroNudgeDue(PERIOD_END, new Date("2026-08-05T17:59:59.000Z"))).toBe(false);
    expect(isMonthlyIntroNudgeDue(PERIOD_END, new Date(PERIOD_END))).toBe(false);
    expect(isMonthlyIntroNudgeDue("not-a-date", NOW)).toBe(false);
  });
});

describe("isMonthlyIntroNudgeCandidate", () => {
  it("accepts an active first-cycle monthly starter/standard in the window", () => {
    expect(isMonthlyIntroNudgeCandidate(candidate(), NOW)).toBe(true);
    expect(isMonthlyIntroNudgeCandidate(candidate({ tier: "starter" }), NOW)).toBe(true);
  });

  it("rejects enterprise, annual, paused, canceling, already-sent, and non-first-cycle", () => {
    expect(isMonthlyIntroNudgeCandidate(candidate({ tier: "enterprise" }), NOW)).toBe(false);
    expect(isMonthlyIntroNudgeCandidate(candidate({ billing_period: "annual" }), NOW)).toBe(false);
    expect(isMonthlyIntroNudgeCandidate(candidate({ status: "canceled" }), NOW)).toBe(false);
    expect(isMonthlyIntroNudgeCandidate(candidate({ cancel_at_period_end: true }), NOW)).toBe(
      false
    );
    expect(isMonthlyIntroNudgeCandidate(candidate({ billing_paused: true }), NOW)).toBe(false);
    expect(
      isMonthlyIntroNudgeCandidate(
        candidate({ monthly_intro_nudge_sent_at: "2026-08-01T00:00:00.000Z" }),
        NOW
      )
    ).toBe(false);
    expect(
      isMonthlyIntroNudgeCandidate(candidate({ stripe_current_period_end: null }), NOW)
    ).toBe(false);
    expect(
      isMonthlyIntroNudgeCandidate(
        candidate({
          created_at: "2026-01-01T00:00:00.000Z",
          stripe_current_period_start: PERIOD_START
        }),
        NOW
      )
    ).toBe(false);
  });
});

describe("claimMonthlyIntroNudge", () => {
  it("returns true when the conditional update matches a row", async () => {
    const { db, updateEq, updateIs } = makeDb({
      update: { data: { id: SUB }, error: null }
    });
    await expect(claimMonthlyIntroNudge(db, SUB, NOW)).resolves.toBe(true);
    expect(updateEq).toHaveBeenCalledWith("id", SUB);
    expect(updateIs).toHaveBeenCalledWith("monthly_intro_nudge_sent_at", null);
  });

  it("returns false when another tick already claimed", async () => {
    const { db } = makeDb({ update: { data: null, error: null } });
    await expect(claimMonthlyIntroNudge(db, SUB, NOW)).resolves.toBe(false);
  });

  it("throws when the update errors", async () => {
    const { db } = makeDb({ update: { data: null, error: { message: "boom" } } });
    await expect(claimMonthlyIntroNudge(db, SUB, NOW)).rejects.toThrow(/claimMonthlyIntroNudge/);
  });
});

describe("sweepMonthlyIntroNudges", () => {
  const sendEmail = vi.fn<typeof sendOwnerEmail>();
  const resolveLocale = vi.fn<typeof resolveOwnerUiLocaleForEmail>();
  const getBusinessRow = vi.fn<typeof getBusiness>();

  beforeEach(() => {
    vi.clearAllMocks();
    sendEmail.mockResolvedValue("msg_1");
    resolveLocale.mockResolvedValue("en");
    getBusinessRow.mockResolvedValue(ownerBiz as BusinessRow);
  });

  it("throws when the candidate scan fails", async () => {
    const { db } = makeDb({ select: { data: null, error: { message: "scan fail" } } });
    await expect(
      sweepMonthlyIntroNudges({
        client: db,
        now: () => NOW,
        sendEmail,
        resolveLocale,
        getBusinessRow,
        resendApiKey: "re_test"
      })
    ).rejects.toThrow(/loadMonthlyIntroNudgeCandidates/);
  });

  it("treats a null select payload as an empty candidate list", async () => {
    const { db } = makeDb({ select: { data: null, error: null } });
    const result = await sweepMonthlyIntroNudges({
      client: db,
      now: () => NOW,
      sendEmail,
      resolveLocale,
      getBusinessRow,
      resendApiKey: "re_test"
    });
    expect(result).toMatchObject({ scanned: 0, sent: 0, skipped: 0 });
  });

  it("uses Date.now and env fallbacks when optional deps are omitted", async () => {
    const prevApp = process.env.NEXT_PUBLIC_APP_URL;
    const prevKey = process.env.RESEND_API_KEY;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.RESEND_API_KEY;
    try {
      const { db } = makeDb({ select: { data: [], error: null } });
      const result = await sweepMonthlyIntroNudges({
        client: db,
        sendEmail,
        resolveLocale,
        getBusinessRow
      });
      expect(result.scanned).toBe(0);
    } finally {
      if (prevApp === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = prevApp;
      if (prevKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevKey;
    }
  });

  it("reads RESEND_API_KEY from the environment when resendApiKey is omitted", async () => {
    const prevKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "re_from_env";
    try {
      const { db } = makeDb({
        select: { data: [candidate()], error: null },
        update: { data: { id: SUB }, error: null }
      });
      const result = await sweepMonthlyIntroNudges({
        client: db,
        now: () => NOW,
        sendEmail,
        resolveLocale,
        getBusinessRow,
        siteUrl: "https://www.newcoworker.com"
      });
      expect(result.sent).toBe(1);
      expect(sendEmail.mock.calls[0]![0]).toBe("re_from_env");
    } finally {
      if (prevKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevKey;
    }
  });

  it("skips all rows when RESEND_API_KEY is missing", async () => {
    const { db } = makeDb({ select: { data: [candidate()], error: null } });
    const result = await sweepMonthlyIntroNudges({
      client: db,
      now: () => NOW,
      sendEmail,
      resolveLocale,
      getBusinessRow,
      resendApiKey: null
    });
    expect(result).toMatchObject({ scanned: 1, sent: 0, skipped: 1 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("claims then sends for an eligible candidate", async () => {
    const { db } = makeDb({
      select: { data: [candidate()], error: null },
      update: { data: { id: SUB }, error: null }
    });
    const result = await sweepMonthlyIntroNudges({
      client: db,
      now: () => NOW,
      sendEmail,
      resolveLocale,
      getBusinessRow,
      resendApiKey: "re_test",
      siteUrl: "https://www.newcoworker.com"
    });
    expect(result).toMatchObject({ scanned: 1, sent: 1, skipped: 0, errors: [] });
    expect(sendEmail).toHaveBeenCalledOnce();
    const call = sendEmail.mock.calls[0]!;
    expect(call[1]).toBe("owner@example.com");
    expect(call[2]).toMatch(/next New Coworker invoice/i);
    const opts = call[3] as { text: string; html: string };
    expect(opts.text).toMatch(/\$195\/mo/);
    expect(opts.text).toMatch(/\$279\/mo/);
    expect(opts.html).toContain("/dashboard/billing");
  });

  it("skips when the row is in the scan but not eligible", async () => {
    const { db } = makeDb({
      select: { data: [candidate({ billing_paused: true })], error: null }
    });
    const result = await sweepMonthlyIntroNudges({
      client: db,
      now: () => NOW,
      sendEmail,
      resolveLocale,
      getBusinessRow,
      resendApiKey: "re_test"
    });
    expect(result).toMatchObject({ scanned: 1, sent: 0, skipped: 1 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips without claiming when the business has no owner email", async () => {
    getBusinessRow.mockResolvedValue({ ...ownerBiz, owner_email: "  " } as BusinessRow);
    const { db } = makeDb({
      select: { data: [candidate()], error: null },
      update: { data: { id: SUB }, error: null }
    });
    const result = await sweepMonthlyIntroNudges({
      client: db,
      now: () => NOW,
      sendEmail,
      resolveLocale,
      getBusinessRow,
      resendApiKey: "re_test"
    });
    expect(result).toMatchObject({ scanned: 1, sent: 0, skipped: 1 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips when the claim loses the race", async () => {
    const { db } = makeDb({
      select: { data: [candidate()], error: null },
      update: { data: null, error: null }
    });
    const result = await sweepMonthlyIntroNudges({
      client: db,
      now: () => NOW,
      sendEmail,
      resolveLocale,
      getBusinessRow,
      resendApiKey: "re_test"
    });
    expect(result).toMatchObject({ scanned: 1, sent: 0, skipped: 1 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("records a row error and continues", async () => {
    getBusinessRow.mockRejectedValue(new Error("biz boom"));
    const { db } = makeDb({
      select: { data: [candidate()], error: null }
    });
    const result = await sweepMonthlyIntroNudges({
      client: db,
      now: () => NOW,
      sendEmail,
      resolveLocale,
      getBusinessRow,
      resendApiKey: "re_test"
    });
    expect(result.sent).toBe(0);
    expect(result.errors).toEqual([{ subscriptionId: SUB, message: "biz boom" }]);
  });

  it("still counts a send when Resend returns no message id", async () => {
    sendEmail.mockResolvedValue(null);
    const { db } = makeDb({
      select: { data: [candidate({ tier: "starter" })], error: null },
      update: { data: { id: SUB }, error: null }
    });
    const result = await sweepMonthlyIntroNudges({
      client: db,
      now: () => NOW,
      sendEmail,
      resolveLocale,
      getBusinessRow,
      resendApiKey: "re_test"
    });
    expect(result.sent).toBe(1);
    const opts = sendEmail.mock.calls[0]![3] as { text: string };
    expect(opts.text).toContain("$15.99/mo");
  });

  it("skips when getBusiness returns null", async () => {
    getBusinessRow.mockResolvedValue(null);
    const { db } = makeDb({
      select: { data: [candidate()], error: null }
    });
    const result = await sweepMonthlyIntroNudges({
      client: db,
      now: () => NOW,
      sendEmail,
      resolveLocale,
      getBusinessRow,
      resendApiKey: "re_test"
    });
    expect(result).toMatchObject({ scanned: 1, skipped: 1, sent: 0 });
  });

  it("coerces a non-Error throw into a string error message", async () => {
    getBusinessRow.mockRejectedValue("plain-fail");
    const { db } = makeDb({
      select: { data: [candidate()], error: null }
    });
    const result = await sweepMonthlyIntroNudges({
      client: db,
      now: () => NOW,
      sendEmail,
      resolveLocale,
      getBusinessRow,
      resendApiKey: "re_test"
    });
    expect(result.errors[0]?.message).toBe("plain-fail");
  });
});
