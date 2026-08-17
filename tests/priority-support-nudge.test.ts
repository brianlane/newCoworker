import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import {
  PRIORITY_SUPPORT_NUDGE_BATCH_LIMIT,
  PRIORITY_SUPPORT_NUDGE_BUSINESS_DAYS,
  PRIORITY_SUPPORT_NUDGE_SCAN_DAYS,
  isPrioritySupportNudgeDue,
  isPrioritySupportNudgeCandidate,
  claimPrioritySupportNudge,
  sweepPrioritySupportNudges,
  type PrioritySupportNudgeCandidate
} from "@/lib/billing/priority-support-nudge";

// Monday, so the 5-business-day lookback lands on the previous Monday and the
// weekend arithmetic is actually exercised.
const NOW = new Date("2026-08-17T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function candidate(
  overrides: Partial<PrioritySupportNudgeCandidate> = {}
): PrioritySupportNudgeCandidate {
  return {
    id: "biz-1",
    owner_email: "owner@test.com",
    tier: "standard",
    timezone: "America/New_York",
    priority_support_until: new Date(NOW.getTime() + 3 * DAY).toISOString(),
    priority_support_nudge_sent_at: null,
    ...overrides
  };
}

/**
 * Chainable Supabase stub. `select(...)` resolves to the candidate list on the
 * businesses table and to renewing ids on the subscriptions table; the update
 * chain resolves through `maybeSingle`.
 */
function mockDb(opts: {
  rows?: PrioritySupportNudgeCandidate[];
  claim?: { data: unknown; error: unknown };
  selectError?: string;
} = {}) {
  const rows = opts.rows ?? [];
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    from: vi.fn(self),
    select: vi.fn(self),
    update: vi.fn(self),
    eq: vi.fn(self),
    is: vi.fn(self),
    gt: vi.fn(self),
    lte: vi.fn(self),
    order: vi.fn(self),
    limit: vi.fn().mockResolvedValue(
      opts.selectError
        ? { data: null, error: { message: opts.selectError } }
        : { data: rows, error: null }
    ),
    maybeSingle: vi
      .fn()
      .mockResolvedValue(opts.claim ?? { data: { id: "biz-1" }, error: null })
  });
  return chain;
}

describe("priority support nudge constants", () => {
  it("scans wider than the lead time so weekends cannot skip a tenant", () => {
    expect(PRIORITY_SUPPORT_NUDGE_SCAN_DAYS).toBeGreaterThan(
      PRIORITY_SUPPORT_NUDGE_BUSINESS_DAYS
    );
    expect(PRIORITY_SUPPORT_NUDGE_BATCH_LIMIT).toBe(200);
  });
});

describe("isPrioritySupportNudgeDue", () => {
  it("is due inside the lead window", () => {
    expect(
      isPrioritySupportNudgeDue(new Date(NOW.getTime() + 3 * DAY).toISOString(), NOW)
    ).toBe(true);
  });

  it("is not due yet when the end is far out", () => {
    expect(
      isPrioritySupportNudgeDue(new Date(NOW.getTime() + 30 * DAY).toISOString(), NOW)
    ).toBe(false);
  });

  it("is not due once the window has already closed", () => {
    expect(isPrioritySupportNudgeDue(NOW.toISOString(), NOW)).toBe(false);
    expect(
      isPrioritySupportNudgeDue(new Date(NOW.getTime() - DAY).toISOString(), NOW)
    ).toBe(false);
  });

  it("is not due for an unparseable date", () => {
    expect(isPrioritySupportNudgeDue("garbage", NOW)).toBe(false);
  });
});

describe("isPrioritySupportNudgeCandidate", () => {
  const none = new Set<string>();

  it("accepts a lapsing non-enterprise tenant", () => {
    expect(isPrioritySupportNudgeCandidate(candidate(), NOW, none)).toBe(true);
  });

  it("skips enterprise, whose window is permanent and cannot lapse", () => {
    expect(isPrioritySupportNudgeCandidate(candidate({ tier: "enterprise" }), NOW, none)).toBe(
      false
    );
  });

  it("skips a tenant with no coverage", () => {
    expect(
      isPrioritySupportNudgeCandidate(candidate({ priority_support_until: null }), NOW, none)
    ).toBe(false);
  });

  it("skips a tenant already warned", () => {
    expect(
      isPrioritySupportNudgeCandidate(
        candidate({ priority_support_nudge_sent_at: "2026-08-10T00:00:00Z" }),
        NOW,
        none
      )
    ).toBe(false);
  });

  it("skips a RENEWING subscription: its window moves forward every invoice", () => {
    expect(isPrioritySupportNudgeCandidate(candidate(), NOW, new Set(["biz-1"]))).toBe(false);
  });

  it("skips a tenant outside the lead window", () => {
    expect(
      isPrioritySupportNudgeCandidate(
        candidate({ priority_support_until: new Date(NOW.getTime() + 40 * DAY).toISOString() }),
        NOW,
        none
      )
    ).toBe(false);
  });
});

describe("claimPrioritySupportNudge", () => {
  it("returns true when this caller won the stamp", async () => {
    const db = mockDb();
    expect(await claimPrioritySupportNudge(db as never, "biz-1", NOW)).toBe(true);
    expect(db.update).toHaveBeenCalledWith({
      priority_support_nudge_sent_at: NOW.toISOString()
    });
    // The `is null` guard in the WHERE clause is what makes it a race winner.
    expect(db.is).toHaveBeenCalledWith("priority_support_nudge_sent_at", null);
  });

  it("returns false when another pass already stamped it", async () => {
    const db = mockDb({ claim: { data: null, error: null } });
    expect(await claimPrioritySupportNudge(db as never, "biz-1", NOW)).toBe(false);
  });

  it("throws on a write error", async () => {
    const db = mockDb({ claim: { data: null, error: { message: "nope" } } });
    await expect(claimPrioritySupportNudge(db as never, "biz-1", NOW)).rejects.toThrow(/nope/);
  });
});

describe("sweepPrioritySupportNudges", () => {
  beforeEach(() => vi.clearAllMocks());

  const baseDeps = {
    now: () => NOW,
    siteUrl: "https://app.test/",
    resendApiKey: "re_test",
    resolveLocale: vi.fn().mockResolvedValue("en"),
    listRenewingBusinessIds: vi.fn().mockResolvedValue(new Set<string>())
  };

  it("sends one email and stamps BEFORE sending", async () => {
    const order: string[] = [];
    const db = mockDb({ rows: [candidate()] });
    (db.maybeSingle as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("claim");
      return { data: { id: "biz-1" }, error: null };
    });
    const sendEmail = vi.fn().mockImplementation(async () => {
      order.push("send");
      return "msg-1";
    });

    const res = await sweepPrioritySupportNudges({
      ...baseDeps,
      client: db as never,
      sendEmail: sendEmail as never
    });

    expect(res).toEqual({ scanned: 1, sent: 1, skipped: 0, errors: [] });
    // Prefer a missed nudge over a duplicate: the stamp must be claimed first.
    expect(order).toEqual(["claim", "send"]);
    expect(sendEmail).toHaveBeenCalledWith(
      "re_test",
      "owner@test.com",
      expect.stringContaining("priority support"),
      expect.objectContaining({ text: expect.any(String), html: expect.any(String) })
    );
  });

  it("sends nothing and skips everything when Resend is not configured", async () => {
    const db = mockDb({ rows: [candidate()] });
    const sendEmail = vi.fn();
    const res = await sweepPrioritySupportNudges({
      ...baseDeps,
      resendApiKey: null,
      client: db as never,
      sendEmail: sendEmail as never
    });
    expect(res).toEqual({ scanned: 1, sent: 0, skipped: 1, errors: [] });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips a renewing tenant without emailing", async () => {
    const db = mockDb({ rows: [candidate()] });
    const sendEmail = vi.fn();
    const res = await sweepPrioritySupportNudges({
      ...baseDeps,
      listRenewingBusinessIds: vi.fn().mockResolvedValue(new Set(["biz-1"])),
      client: db as never,
      sendEmail: sendEmail as never
    });
    expect(res.sent).toBe(0);
    expect(res.skipped).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips a tenant with a blank or missing owner email", async () => {
    for (const owner_email of ["  ", null]) {
      const db = mockDb({ rows: [candidate({ owner_email })] });
      const sendEmail = vi.fn();
      const res = await sweepPrioritySupportNudges({
        ...baseDeps,
        client: db as never,
        sendEmail: sendEmail as never
      });
      expect(res.skipped).toBe(1);
      expect(sendEmail).not.toHaveBeenCalled();
    }
  });

  it("records a non-Error rejection as a string", async () => {
    const db = mockDb({ rows: [candidate()] });
    const res = await sweepPrioritySupportNudges({
      ...baseDeps,
      client: db as never,
      sendEmail: vi.fn().mockRejectedValue("resend exploded") as never
    });
    expect(res.errors).toEqual([{ businessId: "biz-1", message: "resend exploded" }]);
  });

  it("falls back to the real clock and the configured site url", async () => {
    // Exercises the production defaults for `now` and `siteUrl` rather than
    // the injected ones every other case here uses.
    const previous = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://configured.test/";
    try {
      const db = mockDb({
        rows: [
          candidate({ priority_support_until: new Date(Date.now() + 2 * DAY).toISOString() })
        ]
      });
      const sendEmail = vi.fn().mockResolvedValue("msg-1");
      const res = await sweepPrioritySupportNudges({
        resendApiKey: "re_test",
        resolveLocale: vi.fn().mockResolvedValue("en"),
        listRenewingBusinessIds: vi.fn().mockResolvedValue(new Set<string>()),
        client: db as never,
        sendEmail: sendEmail as never
      });
      expect(res.sent).toBe(1);
      // Trailing slash stripped, so the link never doubles up.
      expect(sendEmail.mock.calls[0]?.[3]?.text).toContain(
        "https://configured.test/dashboard/billing"
      );
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = previous;
    }
  });

  it("skips when another pass won the claim race", async () => {
    const db = mockDb({ rows: [candidate()], claim: { data: null, error: null } });
    const sendEmail = vi.fn();
    const res = await sweepPrioritySupportNudges({
      ...baseDeps,
      client: db as never,
      sendEmail: sendEmail as never
    });
    expect(res.skipped).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("records a row error without aborting the pass", async () => {
    const db = mockDb({ rows: [candidate(), candidate({ id: "biz-2" })] });
    const sendEmail = vi
      .fn()
      .mockRejectedValueOnce(new Error("resend 500"))
      .mockResolvedValueOnce("msg-2");
    const res = await sweepPrioritySupportNudges({
      ...baseDeps,
      client: db as never,
      sendEmail: sendEmail as never
    });
    expect(res.sent).toBe(1);
    expect(res.errors).toEqual([{ businessId: "biz-1", message: "resend 500" }]);
  });

  it("logs but does not fail when the send returns no message id", async () => {
    const db = mockDb({ rows: [candidate()] });
    const res = await sweepPrioritySupportNudges({
      ...baseDeps,
      client: db as never,
      sendEmail: vi.fn().mockResolvedValue(null) as never
    });
    expect(res.sent).toBe(1);
    expect(res.errors).toEqual([]);
  });

  it("skips a row whose coverage date is unparseable", async () => {
    // The candidate gate lets a bad date through only if it also passed the
    // due check, so force the pathological combination directly.
    const db = mockDb({ rows: [candidate({ priority_support_until: "not-a-date" })] });
    const sendEmail = vi.fn();
    const res = await sweepPrioritySupportNudges({
      ...baseDeps,
      client: db as never,
      sendEmail: sendEmail as never
    });
    expect(res.skipped).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not look up renewing ids when nothing is in the window", async () => {
    const listRenewingBusinessIds = vi.fn();
    const res = await sweepPrioritySupportNudges({
      ...baseDeps,
      listRenewingBusinessIds,
      client: mockDb({ rows: [] }) as never,
      sendEmail: vi.fn() as never
    });
    expect(res).toEqual({ scanned: 0, sent: 0, skipped: 0, errors: [] });
    expect(listRenewingBusinessIds).not.toHaveBeenCalled();
  });

  it("omits the timezone when the tenant has none", async () => {
    const db = mockDb({ rows: [candidate({ timezone: null })] });
    const res = await sweepPrioritySupportNudges({
      ...baseDeps,
      client: db as never,
      sendEmail: vi.fn().mockResolvedValue("msg-1") as never
    });
    expect(res.sent).toBe(1);
  });

  it("reads renewing ids from the mirror table when the loader is not injected", async () => {
    // Exercises the real loadRenewingBusinessIds: a tenant whose add-on is
    // still renewing is not about to lapse, so it must not be emailed.
    const seen: string[] = [];
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      from: vi.fn((table: string) => {
        seen.push(table);
        return chain;
      }),
      select: vi.fn(self),
      update: vi.fn(self),
      eq: vi.fn(self),
      is: vi.fn(self),
      gt: vi.fn(self),
      lte: vi.fn(self),
      order: vi.fn(self),
      limit: vi.fn(async () =>
        seen[seen.length - 1] === "priority_support_subscriptions"
          ? { data: [{ business_id: "biz-1" }], error: null }
          : { data: [candidate()], error: null }
      ),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: "biz-1" }, error: null })
    });

    const sendEmail = vi.fn();
    const res = await sweepPrioritySupportNudges({
      now: () => NOW,
      siteUrl: "https://app.test",
      resendApiKey: "re_test",
      resolveLocale: vi.fn().mockResolvedValue("en"),
      client: chain as never,
      sendEmail: sendEmail as never
    });

    expect(seen).toContain("priority_support_subscriptions");
    expect(res.skipped).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("throws when the renewing-ids read fails", async () => {
    const seen: string[] = [];
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      from: vi.fn((table: string) => {
        seen.push(table);
        return chain;
      }),
      select: vi.fn(self),
      eq: vi.fn(self),
      is: vi.fn(self),
      gt: vi.fn(self),
      lte: vi.fn(self),
      order: vi.fn(self),
      limit: vi.fn(async () =>
        seen[seen.length - 1] === "priority_support_subscriptions"
          ? { data: null, error: { message: "mirror down" } }
          : { data: [candidate()], error: null }
      )
    });

    await expect(
      sweepPrioritySupportNudges({
        now: () => NOW,
        siteUrl: "https://app.test",
        resendApiKey: "re_test",
        resolveLocale: vi.fn().mockResolvedValue("en"),
        client: chain as never,
        sendEmail: vi.fn() as never
      })
    ).rejects.toThrow(/mirror down/);
  });

  it("treats a null data payload as an empty result set, not a crash", async () => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      from: vi.fn(self),
      select: vi.fn(self),
      eq: vi.fn(self),
      is: vi.fn(self),
      gt: vi.fn(self),
      lte: vi.fn(self),
      order: vi.fn(self),
      limit: vi.fn().mockResolvedValue({ data: null, error: null })
    });
    const res = await sweepPrioritySupportNudges({
      ...baseDeps,
      client: chain as never,
      sendEmail: vi.fn() as never
    });
    expect(res).toEqual({ scanned: 0, sent: 0, skipped: 0, errors: [] });
  });

  it("treats a null renewing payload as nobody renewing", async () => {
    const seen: string[] = [];
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      from: vi.fn((table: string) => {
        seen.push(table);
        return chain;
      }),
      select: vi.fn(self),
      update: vi.fn(self),
      eq: vi.fn(self),
      is: vi.fn(self),
      gt: vi.fn(self),
      lte: vi.fn(self),
      order: vi.fn(self),
      limit: vi.fn(async () =>
        seen[seen.length - 1] === "priority_support_subscriptions"
          ? { data: null, error: null }
          : { data: [candidate()], error: null }
      ),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: "biz-1" }, error: null })
    });
    const res = await sweepPrioritySupportNudges({
      now: () => NOW,
      siteUrl: "https://app.test",
      resendApiKey: "re_test",
      resolveLocale: vi.fn().mockResolvedValue("en"),
      client: chain as never,
      sendEmail: vi.fn().mockResolvedValue("msg-1") as never
    });
    expect(res.sent).toBe(1);
  });

  it("falls back to a localhost site url when the app url is unset", async () => {
    const previous = process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    try {
      const db = mockDb({ rows: [candidate()] });
      const sendEmail = vi.fn().mockResolvedValue("msg-1");
      await sweepPrioritySupportNudges({
        now: () => NOW,
        resendApiKey: "re_test",
        resolveLocale: vi.fn().mockResolvedValue("en"),
        listRenewingBusinessIds: vi.fn().mockResolvedValue(new Set<string>()),
        client: db as never,
        sendEmail: sendEmail as never
      });
      expect(sendEmail.mock.calls[0]?.[3]?.text).toContain("http://localhost:3000/dashboard/billing");
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = previous;
    }
  });

  it("reads the Resend key from the environment when none is injected", async () => {
    const previous = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "re_from_env";
    try {
      const db = mockDb({ rows: [candidate()] });
      const sendEmail = vi.fn().mockResolvedValue("msg-1");
      const res = await sweepPrioritySupportNudges({
        now: () => NOW,
        siteUrl: "https://app.test",
        resolveLocale: vi.fn().mockResolvedValue("en"),
        listRenewingBusinessIds: vi.fn().mockResolvedValue(new Set<string>()),
        client: db as never,
        sendEmail: sendEmail as never
      });
      expect(res.sent).toBe(1);
      expect(sendEmail.mock.calls[0]?.[0]).toBe("re_from_env");
    } finally {
      if (previous === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = previous;
    }
  });

  it("skips every send when neither an injected nor an env Resend key exists", async () => {
    const previous = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      const db = mockDb({ rows: [candidate()] });
      const sendEmail = vi.fn();
      const res = await sweepPrioritySupportNudges({
        now: () => NOW,
        siteUrl: "https://app.test",
        resolveLocale: vi.fn().mockResolvedValue("en"),
        listRenewingBusinessIds: vi.fn().mockResolvedValue(new Set<string>()),
        client: db as never,
        sendEmail: sendEmail as never
      });
      expect(res).toEqual({ scanned: 1, sent: 0, skipped: 1, errors: [] });
      expect(sendEmail).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = previous;
    }
  });

  it("throws when the candidate scan itself fails", async () => {
    await expect(
      sweepPrioritySupportNudges({
        ...baseDeps,
        client: mockDb({ selectError: "scan down" }) as never,
        sendEmail: vi.fn() as never
      })
    ).rejects.toThrow(/scan down/);
  });
});
