/**
 * Pre-term contract rollover nudge: eligibility, claim-before-send, sweep.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => {
    throw new Error("default client must not be used in tests");
  })
}));
vi.mock("@/lib/stripe/client", () => ({ getStripe: vi.fn() }));

import { getStripe } from "@/lib/stripe/client";
import {
  autoRenewIsLiveInStripe,
  claimContractTermNudge,
  isContractTermNudgeCandidate,
  isContractTermNudgeDue,
  shouldRetireContractTermNudgeCandidate,
  sweepContractTermNudges,
  type ContractTermNudgeCandidate
} from "@/lib/billing/contract-term-nudge";
import type { sendOwnerEmail } from "@/lib/email/client";
import type { getBusiness } from "@/lib/db/businesses";
import type { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import type { BusinessRow } from "@/lib/db/businesses";

const BIZ = "11111111-1111-4111-8111-111111111111";
const SUB = "22222222-2222-4222-8222-222222222222";
// Wednesday Aug 12 period end; 5 business days earlier is Wednesday Aug 5.
const PERIOD_END = "2026-08-12T18:00:00.000Z";
const NOW = new Date("2026-08-05T18:00:00.000Z");
const PERIOD_START = "2025-08-12T18:00:00.000Z";
const RENEWAL_AT = "2026-08-12T18:00:00.000Z";

function candidate(overrides: Partial<ContractTermNudgeCandidate> = {}): ContractTermNudgeCandidate {
  return {
    id: SUB,
    business_id: BIZ,
    tier: "standard",
    status: "active",
    billing_period: "annual",
    cancel_at_period_end: false,
    billing_paused: false,
    contract_auto_renew: false,
    stripe_subscription_id: "sub_live_1",
    renewal_at: RENEWAL_AT,
    stripe_current_period_start: PERIOD_START,
    stripe_current_period_end: PERIOD_END,
    contract_term_nudge_sent_at: null,
    ...overrides
  };
}

type QueryResult = { data: unknown; error: { message: string } | null };

function makeDb(opts: { select?: QueryResult; update?: QueryResult }) {
  const selectResult = opts.select ?? { data: [], error: null };
  const updateResult = opts.update ?? { data: { id: SUB }, error: null };
  const updateEq = vi.fn();
  const updateIs = vi.fn();

  const chainSelect: Record<string, unknown> = {};
  for (const m of ["select", "in", "eq", "is", "gt", "lte", "order", "limit"]) {
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
          expect(patch).toMatchObject({ contract_term_nudge_sent_at: expect.any(String) });
          return updateChain;
        }
      };
    })
  };

  return { db: root as never, updateEq, updateIs };
}

const ownerBiz = {
  id: BIZ,
  owner_email: "owner@example.com"
} as BusinessRow;

describe("isContractTermNudgeDue / candidate", () => {
  it("is due inside the 5-business-day window", () => {
    expect(isContractTermNudgeDue(PERIOD_END, NOW)).toBe(true);
    expect(isContractTermNudgeDue(PERIOD_END, new Date("2026-08-04T18:00:00.000Z"))).toBe(false);
    expect(isContractTermNudgeDue(PERIOD_END, new Date("2026-08-12T18:00:00.000Z"))).toBe(false);
  });

  it("accepts active term plans with auto-renew off", () => {
    expect(isContractTermNudgeCandidate(candidate(), NOW)).toBe(true);
    expect(isContractTermNudgeCandidate(candidate({ billing_period: "biennial" }), NOW)).toBe(true);
  });

  it("rejects monthly, auto-renew on, paused, cancel-at-period-end, elapsed", () => {
    expect(isContractTermNudgeCandidate(candidate({ billing_period: "monthly" }), NOW)).toBe(false);
    expect(isContractTermNudgeCandidate(candidate({ contract_auto_renew: true }), NOW)).toBe(false);
    expect(isContractTermNudgeCandidate(candidate({ billing_paused: true }), NOW)).toBe(false);
    expect(isContractTermNudgeCandidate(candidate({ cancel_at_period_end: true }), NOW)).toBe(false);
    expect(isContractTermNudgeCandidate(candidate({ status: "canceled" }), NOW)).toBe(false);
    expect(isContractTermNudgeCandidate(candidate({ tier: "enterprise" }), NOW)).toBe(false);
    expect(
      isContractTermNudgeCandidate(candidate({ stripe_current_period_end: null }), NOW)
    ).toBe(false);
    expect(isContractTermNudgeDue("not-a-date", NOW)).toBe(false);
    expect(
      isContractTermNudgeCandidate(
        candidate({
          // Commitment elapsed: renewal in the past and period length monthly.
          renewal_at: "2025-01-01T00:00:00.000Z",
          stripe_current_period_start: "2026-07-12T18:00:00.000Z",
          stripe_current_period_end: "2026-08-12T18:00:00.000Z"
        }),
        NOW
      )
    ).toBe(false);
    expect(
      isContractTermNudgeCandidate(
        candidate({ contract_term_nudge_sent_at: "2026-08-01T00:00:00.000Z" }),
        NOW
      )
    ).toBe(false);
  });

  it("retires rows that can never send", () => {
    expect(shouldRetireContractTermNudgeCandidate(candidate({ tier: "enterprise" }), NOW)).toBe(
      true
    );
    // contract_auto_renew deliberately does NOT retire. Retiring stamps
    // contract_term_nudge_sent_at, which is permanent, and this flag is both
    // owner-toggleable and unverifiable on a row whose Stripe subscription is
    // canceled. Only conditions that can never reverse belong here.
    expect(
      shouldRetireContractTermNudgeCandidate(candidate({ contract_auto_renew: true }), NOW)
    ).toBe(false);
    expect(
      shouldRetireContractTermNudgeCandidate(candidate({ billing_period: "monthly" }), NOW)
    ).toBe(true);
    expect(
      shouldRetireContractTermNudgeCandidate(
        candidate({
          renewal_at: "2025-01-01T00:00:00.000Z",
          stripe_current_period_start: "2026-07-12T18:00:00.000Z",
          stripe_current_period_end: "2026-08-12T18:00:00.000Z"
        }),
        NOW
      )
    ).toBe(true);
    expect(shouldRetireContractTermNudgeCandidate(candidate(), NOW)).toBe(false);
  });
});

describe("claimContractTermNudge / sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("claims only when stamp is still null", async () => {
    const { db, updateEq, updateIs } = makeDb({});
    await expect(claimContractTermNudge(db, SUB, NOW)).resolves.toBe(true);
    expect(updateEq).toHaveBeenCalledWith("id", SUB);
    expect(updateIs).toHaveBeenCalledWith("contract_term_nudge_sent_at", null);
  });

  it("sends once for an eligible candidate", async () => {
    const { db } = makeDb({ select: { data: [candidate()], error: null } });
    const sendEmail = vi.fn(async () => "msg_1") as unknown as typeof sendOwnerEmail;
    const getBusinessRow = vi.fn(async () => ownerBiz) as unknown as typeof getBusiness;
    const resolveLocale = vi.fn(async () => "en") as unknown as typeof resolveOwnerUiLocaleForEmail;

    const result = await sweepContractTermNudges({
      client: db,
      sendEmail,
      getBusinessRow,
      resolveLocale,
      now: () => NOW,
      siteUrl: "https://www.newcoworker.com",
      resendApiKey: "re_test"
    });

    expect(result).toMatchObject({ scanned: 1, sent: 1, skipped: 0, errors: [] });
    expect(sendEmail).toHaveBeenCalledWith(
      "re_test",
      "owner@example.com",
      "A note about your New Coworker contract",
      expect.objectContaining({ text: expect.stringContaining("12-month") })
    );
  });

  it("skips when RESEND_API_KEY is missing", async () => {
    const { db } = makeDb({ select: { data: [candidate()], error: null } });
    const result = await sweepContractTermNudges({
      client: db,
      now: () => NOW,
      resendApiKey: null
    });
    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(0);
  });

  it("retires a loaded row that can never send", async () => {
    // The scan does not filter tier, so an enterprise term row still loads.
    // It can never be nudged, so stamp it out of the partial index.
    const row = candidate({ tier: "enterprise" });
    const { db, updateEq } = makeDb({ select: { data: [row], error: null } });
    const sendEmail = vi.fn() as unknown as typeof sendOwnerEmail;
    const result = await sweepContractTermNudges({
      client: db,
      sendEmail,
      now: () => NOW,
      resendApiKey: "re_test"
    });
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(updateEq).toHaveBeenCalledWith("id", SUB);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips an auto-renew-on row whose Stripe subscription is still live", async () => {
    const row = candidate({ contract_auto_renew: true });
    const { db } = makeDb({ select: { data: [row], error: null } });
    const sendEmail = vi.fn() as unknown as typeof sendOwnerEmail;
    const result = await sweepContractTermNudges({
      client: db,
      sendEmail,
      autoRenewIsLive: async () => true,
      now: () => NOW,
      resendApiKey: "re_test"
    });
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("still nudges an auto-renew-on row whose Stripe subscription is canceled", async () => {
    // Amy Laidlaw Real Estate: a failed-but-charged Hostinger order left the
    // biennial contract running on a CANCELED Stripe subscription, with
    // contract_auto_renew stuck true. Nothing can renew, so the owner must
    // still get the one warning before the term lapses.
    const row = candidate({ contract_auto_renew: true });
    const { db } = makeDb({ select: { data: [row], error: null } });
    const sendEmail = vi.fn(async () => "msg_1") as unknown as typeof sendOwnerEmail;
    const getBusinessRow = vi.fn(async () =>
      ({ id: BIZ, owner_email: "owner@example.com" }) as unknown as BusinessRow
    );
    const result = await sweepContractTermNudges({
      client: db,
      sendEmail,
      getBusinessRow,
      autoRenewIsLive: async () => false,
      resolveLocale: (async () => "en") as unknown as typeof resolveOwnerUiLocaleForEmail,
      now: () => NOW,
      resendApiKey: "re_test"
    });
    expect(result.sent).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("leaves the row unstamped when the Stripe liveness probe throws", async () => {
    // A Stripe outage must not burn the single nudge: record the error and
    // let the next daily pass retry.
    const row = candidate({ contract_auto_renew: true });
    const { db, updateEq } = makeDb({ select: { data: [row], error: null } });
    const sendEmail = vi.fn() as unknown as typeof sendOwnerEmail;
    const result = await sweepContractTermNudges({
      client: db,
      sendEmail,
      autoRenewIsLive: async () => {
        throw new Error("stripe down");
      },
      now: () => NOW,
      resendApiKey: "re_test"
    });
    expect(result.sent).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("stripe down");
    // Nothing was stamped: the claim update never ran.
    expect(updateEq).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips when owner email is missing or claim loses the race", async () => {
    const { db } = makeDb({
      select: { data: [candidate()], error: null },
      update: { data: null, error: null }
    });
    const sendEmail = vi.fn() as unknown as typeof sendOwnerEmail;
    const getBusinessRow = vi.fn(async () =>
      ({ id: BIZ, owner_email: null }) as unknown as BusinessRow
    );
    const result = await sweepContractTermNudges({
      client: db,
      sendEmail,
      getBusinessRow,
      now: () => NOW,
      resendApiKey: "re_test"
    });
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();

    const { db: db2 } = makeDb({
      select: { data: [candidate()], error: null },
      update: { data: null, error: null }
    });
    const getBusinessRow2 = vi.fn(async () => ownerBiz) as unknown as typeof getBusiness;
    const result2 = await sweepContractTermNudges({
      client: db2,
      sendEmail,
      getBusinessRow: getBusinessRow2,
      resolveLocale: vi.fn(async () => "en") as unknown as typeof resolveOwnerUiLocaleForEmail,
      now: () => NOW,
      resendApiKey: "re_test"
    });
    expect(result2.skipped).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("counts a send even when Resend returns no message id, and records row errors", async () => {
    const { db } = makeDb({ select: { data: [candidate()], error: null } });
    const sendEmail = vi.fn(async () => null) as unknown as typeof sendOwnerEmail;
    const getBusinessRow = vi.fn(async () => ownerBiz) as unknown as typeof getBusiness;
    const resolveLocale = vi.fn(async () => "en") as unknown as typeof resolveOwnerUiLocaleForEmail;
    const result = await sweepContractTermNudges({
      client: db,
      sendEmail,
      getBusinessRow,
      resolveLocale,
      now: () => NOW,
      resendApiKey: "re_test",
      siteUrl: "https://www.newcoworker.com/"
    });
    expect(result.sent).toBe(1);

    const { db: dbFail } = makeDb({ select: { data: [candidate()], error: null } });
    const boom = vi.fn(async () => {
      throw "boom";
    }) as unknown as typeof getBusiness;
    const resultFail = await sweepContractTermNudges({
      client: dbFail,
      sendEmail,
      getBusinessRow: boom,
      resolveLocale,
      now: () => NOW,
      resendApiKey: "re_test"
    });
    expect(resultFail.errors).toEqual([{ subscriptionId: SUB, message: "boom" }]);
  });

  it("throws when the candidate scan fails", async () => {
    const { db } = makeDb({ select: { data: null, error: { message: "scan fail" } } });
    await expect(
      sweepContractTermNudges({
        client: db,
        now: () => NOW,
        resendApiKey: "re_test"
      })
    ).rejects.toThrow(/loadContractTermNudgeCandidates/);
  });

  it("treats a null select payload as an empty candidate list", async () => {
    const { db } = makeDb({ select: { data: null, error: null } });
    const result = await sweepContractTermNudges({
      client: db,
      now: () => NOW,
      resendApiKey: "re_test"
    });
    expect(result).toMatchObject({ scanned: 0, sent: 0, skipped: 0 });
  });

  it("uses Date.now when the now dep is omitted", async () => {
    const { db } = makeDb({ select: { data: [], error: null } });
    const result = await sweepContractTermNudges({
      client: db,
      resendApiKey: "re_test",
      sendEmail: vi.fn() as unknown as typeof sendOwnerEmail,
      resolveLocale: vi.fn(async () => "en") as unknown as typeof resolveOwnerUiLocaleForEmail,
      getBusinessRow: vi.fn(async () => ownerBiz) as unknown as typeof getBusiness
    });
    expect(result.scanned).toBe(0);
  });

  it("throws when claim update fails", async () => {
    const { db } = makeDb({ update: { data: null, error: { message: "claim fail" } } });
    await expect(claimContractTermNudge(db, SUB, NOW)).rejects.toThrow(/claimContractTermNudge/);
  });

  it("skips cancel-at-period-end without retiring, and uses env/now defaults", async () => {
    const row = candidate({ cancel_at_period_end: true });
    const { db } = makeDb({ select: { data: [row], error: null } });
    const sendEmail = vi.fn() as unknown as typeof sendOwnerEmail;
    const result = await sweepContractTermNudges({
      client: db,
      sendEmail,
      now: () => NOW,
      resendApiKey: "re_test"
    });
    expect(result.skipped).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();

    const prevApp = process.env.NEXT_PUBLIC_APP_URL;
    const prevKey = process.env.RESEND_API_KEY;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.RESEND_API_KEY;
    try {
      const { db: db2 } = makeDb({ select: { data: [candidate()], error: null } });
      const skipped = await sweepContractTermNudges({
        client: db2,
        sendEmail,
        resolveLocale: vi.fn(async () => "en") as unknown as typeof resolveOwnerUiLocaleForEmail,
        getBusinessRow: vi.fn(async () => ownerBiz) as unknown as typeof getBusiness,
        now: () => NOW
      });
      expect(skipped.skipped).toBe(1);
      expect(skipped.sent).toBe(0);
    } finally {
      if (prevApp === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = prevApp;
      if (prevKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevKey;
    }
  });

  it("records Error.message when a row throws an Error", async () => {
    const { db } = makeDb({ select: { data: [candidate()], error: null } });
    const boom = vi.fn(async () => {
      throw new Error("row boom");
    }) as unknown as typeof getBusiness;
    const result = await sweepContractTermNudges({
      client: db,
      sendEmail: vi.fn() as unknown as typeof sendOwnerEmail,
      getBusinessRow: boom,
      now: () => NOW,
      resendApiKey: "re_test"
    });
    expect(result.errors).toEqual([{ subscriptionId: SUB, message: "row boom" }]);
  });
});

describe("autoRenewIsLiveInStripe", () => {
  beforeEach(() => {
    vi.mocked(getStripe).mockReset();
  });

  it("is false without a subscription id, without calling Stripe", async () => {
    expect(await autoRenewIsLiveInStripe(null)).toBe(false);
    expect(getStripe).not.toHaveBeenCalled();
  });

  it("is true for a subscription Stripe still reports as live", async () => {
    const retrieve = vi.fn(async () => ({ status: "active" }));
    vi.mocked(getStripe).mockReturnValue({
      subscriptions: { retrieve }
    } as unknown as ReturnType<typeof getStripe>);
    expect(await autoRenewIsLiveInStripe("sub_live")).toBe(true);
    expect(retrieve).toHaveBeenCalledWith("sub_live");
  });

  it("is false for a canceled subscription", async () => {
    vi.mocked(getStripe).mockReturnValue({
      subscriptions: { retrieve: vi.fn(async () => ({ status: "canceled" })) }
    } as unknown as ReturnType<typeof getStripe>);
    expect(await autoRenewIsLiveInStripe("sub_dead")).toBe(false);
  });

  it("is false when Stripe no longer has the subscription", async () => {
    vi.mocked(getStripe).mockReturnValue({
      subscriptions: {
        retrieve: vi.fn(async () => {
          throw new Error("No such subscription: sub_gone");
        })
      }
    } as unknown as ReturnType<typeof getStripe>);
    expect(await autoRenewIsLiveInStripe("sub_gone")).toBe(false);
  });

  it("rethrows a transport error rather than guessing", async () => {
    vi.mocked(getStripe).mockReturnValue({
      subscriptions: {
        retrieve: vi.fn(async () => {
          throw new Error("connection reset");
        })
      }
    } as unknown as ReturnType<typeof getStripe>);
    await expect(autoRenewIsLiveInStripe("sub_x")).rejects.toThrow("connection reset");
  });

  it("rethrows a non-Error rejection", async () => {
    vi.mocked(getStripe).mockReturnValue({
      subscriptions: {
        retrieve: vi.fn(async () => {
          throw "boom";
        })
      }
    } as unknown as ReturnType<typeof getStripe>);
    await expect(autoRenewIsLiveInStripe("sub_y")).rejects.toBe("boom");
  });
});
