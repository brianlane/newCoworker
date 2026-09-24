import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/residency/read", () => ({
  countMovedRows: vi.fn()
}));
vi.mock("@/lib/admin/platform-settings", () => ({
  getAdminPlatformSetting: vi.fn(),
  upsertAdminPlatformSetting: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { countMovedRows } from "@/lib/residency/read";
import {
  getAdminPlatformSetting,
  upsertAdminPlatformSetting
} from "@/lib/admin/platform-settings";
import {
  countFleetEmailsThisMonth,
  loadMoneyGaps,
  loadSoftwareCosts,
  loadUsagePackGrants,
  priceLoadedGrants,
  utcMonthWindow,
  type MoneyGapDb
} from "@/lib/admin/money-gap-load";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const WINDOW = utcMonthWindow(NOW);

function grantDb(responses: Record<string, { data: unknown; error: { message: string } | null }>): MoneyGapDb {
  return {
    from(table: string) {
      return {
        select() {
          return {
            gte() {
              return {
                lt: async () =>
                  responses[table] ?? { data: [], error: null, count: null }
              };
            }
          };
        }
      };
    }
  } as unknown as MoneyGapDb;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_ORG_ID;
  delete process.env.CURSOR_ADMIN_API_KEY;
  delete process.env.PLATFORM_COST_ZOOM_MONTHLY_CENTS;
  delete process.env.PLATFORM_COST_CURSOR_MONTHLY_CENTS;
  delete process.env.PLATFORM_COST_RESEND_MONTHLY_CENTS;
  delete process.env.STRIPE_VOICE_BONUS_30MIN_PRICE_ID;
  delete process.env.STRIPE_VOICE_BONUS_30MIN_CENTS;
});

describe("utcMonthWindow", () => {
  it("uses UTC month boundaries", () => {
    expect(WINDOW).toEqual({
      startIso: "2026-09-01T00:00:00.000Z",
      endIso: "2026-10-01T00:00:00.000Z"
    });
  });
});

describe("loadUsagePackGrants", () => {
  it("keeps priced rows and skips a failed table and a bad row", async () => {
    const rows = await loadUsagePackGrants(
      grantDb({
        voice_bonus_grants: {
          data: [
            {
              business_id: "amy",
              stripe_checkout_session_id: "pi_1",
              voided_at: null,
              seconds_purchased: 1800
            },
            {
              business_id: "amy",
              stripe_checkout_session_id: null,
              voided_at: "2026-09-02T00:00:00Z",
              seconds_purchased: "bad"
            },
            { business_id: 4 },
            null,
            "nope"
          ],
          error: null
        },
        sms_bonus_grants: { data: "nope", error: null },
        chat_spend_credit_grants: { data: null, error: { message: "chat down" } }
      }),
      WINDOW
    );
    expect(rows).toEqual([
      {
        business_id: "amy",
        stripe_checkout_session_id: "pi_1",
        voided_at: null,
        units: 1800
      },
      {
        business_id: "amy",
        stripe_checkout_session_id: null,
        voided_at: "2026-09-02T00:00:00Z",
        units: 0
      }
    ]);
  });
});

describe("priceLoadedGrants", () => {
  it("prices a configured voice pack and ignores an unknown size", () => {
    process.env.STRIPE_VOICE_BONUS_30MIN_PRICE_ID = "price_30";
    process.env.STRIPE_VOICE_BONUS_30MIN_CENTS = "1399";
    const priced = priceLoadedGrants([
      {
        business_id: "amy",
        stripe_checkout_session_id: "pi_1",
        voided_at: null,
        units: 1800
      },
      {
        business_id: "amy",
        stripe_checkout_session_id: "pi_2",
        voided_at: null,
        units: 50
      }
    ]);
    expect(priced.totalCents).toBe(1399);
    expect(priced.byBusiness.get("amy")).toBe(1399);
  });
});

describe("countFleetEmailsThisMonth", () => {
  it("counts central supabase tenants and box tenants, and survives failures", async () => {
    const db = {
      from() {
        return {
          select() {
            return {
              gte() {
                return {
                  lt() {
                    return {
                      in: async () => ({ data: null, error: null, count: null })
                    };
                  }
                };
              }
            };
          }
        };
      }
    } as unknown as MoneyGapDb;
    vi.mocked(countMovedRows)
      .mockResolvedValueOnce(4)
      .mockRejectedValueOnce(new Error("box down"))
      .mockRejectedValueOnce("box string");
    const total = await countFleetEmailsThisMonth({
      db,
      businesses: [
        { id: "central", vps: false },
        { id: "box-a", vps: true },
        { id: "box-b", vps: true },
        { id: "box-c", vps: true }
      ],
      window: WINDOW,
      countBox: (id) => countMovedRows(id, { table: "email_log" })
    });
    expect(total).toBe(4);
  });

  it("logs a central count error and skips the in() call when nobody is central", async () => {
    const db = {
      from() {
        return {
          select() {
            return {
              gte() {
                return {
                  lt() {
                    return {
                      in: async () => ({ data: null, error: { message: "count failed" }, count: null })
                    };
                  }
                };
              }
            };
          }
        };
      }
    } as unknown as MoneyGapDb;
    const failed = await countFleetEmailsThisMonth({
      db,
      businesses: [{ id: "central", vps: false }],
      window: WINDOW,
      countBox: async () => 0
    });
    expect(failed).toBe(0);
    const none = await countFleetEmailsThisMonth({
      db,
      businesses: [],
      window: WINDOW,
      countBox: async () => 0
    });
    expect(none).toBe(0);
  });
});

describe("loadSoftwareCosts", () => {
  it("uses a fresh cache and still adds env seats", async () => {
    vi.mocked(getAdminPlatformSetting).mockResolvedValue({
      syncedAt: "2026-09-23T11:00:00.000Z",
      vercelCents: 2_003,
      zoomCents: 0,
      resendCents: 0,
      cursorCents: 0,
      resendEmails: 10
    });
    process.env.PLATFORM_COST_ZOOM_MONTHLY_CENTS = "1699";
    process.env.PLATFORM_COST_CURSOR_MONTHLY_CENTS = "2000";
    const costs = await loadSoftwareCosts(NOW, 100);
    expect(costs).toEqual({
      vercelCents: 2_003,
      zoomCents: 1_699,
      resendCents: 0,
      cursorCents: 2_000
    });
    expect(upsertAdminPlatformSetting).not.toHaveBeenCalled();
  });

  it("fetches Vercel and Cursor when the cache is stale, and writes the cache", async () => {
    vi.mocked(getAdminPlatformSetting).mockResolvedValue(null);
    process.env.VERCEL_TOKEN = "tok";
    process.env.VERCEL_ORG_ID = "team_1";
    process.env.CURSOR_ADMIN_API_KEY = "cur";
    process.env.PLATFORM_COST_RESEND_MONTHLY_CENTS = "2000";
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("vercel.com")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            '{"ServiceName":"Pro","PricingCategory":"Committed","BilledCost":0,"EffectiveCost":20}\n'
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ teamMemberSpend: [{ spendCents: 500 }] })
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const costs = await loadSoftwareCosts(NOW, 3_100);
    expect(costs.vercelCents).toBe(2_000);
    expect(costs.resendCents).toBe(2_000 + 90);
    expect(costs.cursorCents).toBe(500);
    expect(upsertAdminPlatformSetting).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("keeps the cached Vercel figure when the token or the response is missing", async () => {
    vi.mocked(getAdminPlatformSetting).mockResolvedValue({
      syncedAt: "2026-09-01T00:00:00.000Z",
      vercelCents: 900,
      zoomCents: 0,
      resendCents: 0,
      cursorCents: 0,
      resendEmails: 0
    });
    process.env.VERCEL_TOKEN = "tok";
    const missingTeam = await loadSoftwareCosts(NOW, 0);
    expect(missingTeam.vercelCents).toBe(900);

    process.env.VERCEL_ORG_ID = "team_1";
    process.env.CURSOR_ADMIN_API_KEY = "cur";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("cursor.com")) {
          return { ok: false, status: 401, json: async () => ({}), text: async () => "" };
        }
        return { ok: true, status: 200, text: async () => "\n", json: async () => ({}) };
      })
    );
    const cursorDown = await loadSoftwareCosts(new Date("2026-09-23T18:00:00.000Z"), 0);
    expect(cursorDown.cursorCents).toBe(0);
    vi.unstubAllGlobals();
  });

  it("stops the Cursor page loop when spend is not a list", async () => {
    vi.mocked(getAdminPlatformSetting).mockResolvedValue({
      syncedAt: NOW.toISOString(),
      vercelCents: 1,
      zoomCents: 0,
      resendCents: 0,
      cursorCents: 0,
      resendEmails: 0
    });
    process.env.CURSOR_ADMIN_API_KEY = "cur";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ teamMemberSpend: null }) }))
    );
    const costs = await loadSoftwareCosts(NOW, 0);
    expect(costs.cursorCents).toBe(0);
    vi.unstubAllGlobals();
  });

  it("keeps the previous Vercel figure when the fetch fails", async () => {
    vi.mocked(getAdminPlatformSetting).mockResolvedValue({
      syncedAt: "2026-09-01T00:00:00.000Z",
      vercelCents: 1_800,
      zoomCents: 0,
      resendCents: 0,
      cursorCents: 0,
      resendEmails: 0
    });
    process.env.VERCEL_TOKEN = "tok";
    process.env.VERCEL_ORG_ID = "team_1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, text: async () => "", json: async () => ({}) }))
    );
    const costs = await loadSoftwareCosts(NOW, 0);
    expect(costs.vercelCents).toBe(1_800);
    vi.unstubAllGlobals();
  });

  it("survives a cache read failure, a thrown fetch, and a cache write failure", async () => {
    vi.mocked(getAdminPlatformSetting).mockRejectedValueOnce("read string");
    vi.mocked(upsertAdminPlatformSetting).mockRejectedValueOnce(new Error("write down"));
    process.env.VERCEL_TOKEN = "tok";
    process.env.VERCEL_ORG_ID = "team_1";
    process.env.CURSOR_ADMIN_API_KEY = "cur";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        throw String(url).includes("cursor.com") ? "cursor down" : new Error("vercel down");
      })
    );
    const costs = await loadSoftwareCosts(NOW, 0);
    expect(costs.vercelCents).toBe(0);
    expect(costs.cursorCents).toBe(0);
    vi.mocked(getAdminPlatformSetting).mockRejectedValueOnce(new Error("read down"));
    vi.mocked(upsertAdminPlatformSetting).mockRejectedValueOnce("write string");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        throw String(url).includes("cursor.com") ? new Error("cursor down") : "vercel down";
      })
    );
    const again = await loadSoftwareCosts(NOW, 0);
    expect(again.cursorCents).toBe(0);
    vi.unstubAllGlobals();
  });

  it("pages through Cursor spend until a short page", async () => {
    vi.mocked(getAdminPlatformSetting).mockResolvedValue({
      syncedAt: NOW.toISOString(),
      vercelCents: 1,
      zoomCents: 0,
      resendCents: 0,
      cursorCents: 0,
      resendEmails: 0
    });
    process.env.CURSOR_ADMIN_API_KEY = "cur";
    const page = (n: number) => ({
      ok: true,
      status: 200,
      json: async () => ({
        teamMemberSpend: Array.from({ length: n }, () => ({ spendCents: 1 }))
      })
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => page(100)).mockResolvedValueOnce(page(100)).mockResolvedValueOnce(page(1))
    );
    const costs = await loadSoftwareCosts(NOW, 0);
    expect(costs.cursorCents).toBe(101);
    vi.unstubAllGlobals();
  });
});

describe("loadMoneyGaps", () => {
  it("returns zeros when the client throws", async () => {
    vi.mocked(createSupabaseServiceClient).mockRejectedValueOnce(new Error("no db"));
    const gaps = await loadMoneyGaps(NOW);
    expect(gaps.usagePacks.totalCents).toBe(0);
    vi.mocked(createSupabaseServiceClient).mockRejectedValueOnce("no db string");
    const again = await loadMoneyGaps(NOW);
    expect(again.software.vercelCents).toBe(0);
  });

  it("prices grants and counts mail for both residency modes", async () => {
    process.env.STRIPE_VOICE_BONUS_30MIN_PRICE_ID = "price_30";
    process.env.STRIPE_VOICE_BONUS_30MIN_CENTS = "1399";
    vi.mocked(getAdminPlatformSetting).mockResolvedValue(null);
    vi.mocked(countMovedRows).mockResolvedValue(3);
    const db = {
      from(table: string) {
        return {
          select() {
            return {
              gte() {
                return {
                  lt: async () => {
                    if (table === "businesses") {
                      return {
                        data: [
                          { id: "amy", data_residency_mode: "supabase" },
                          { id: "box", data_residency_mode: "vps" },
                          { id: 3 },
                          null
                        ],
                        error: null,
                        count: null
                      };
                    }
                    if (table === "voice_bonus_grants") {
                      return {
                        data: [
                          {
                            business_id: "amy",
                            stripe_checkout_session_id: "pi_1",
                            voided_at: null,
                            seconds_purchased: 1800
                          }
                        ],
                        error: null,
                        count: null
                      };
                    }
                    return { data: [], error: null, count: null };
                  },
                  ltIn: undefined
                };
              }
            };
          }
        };
      }
    };
    // email count uses .lt().in(); grant and business reads await .lt().
    const realFrom = db.from.bind(db);
    db.from = (table: string) => {
      const built = realFrom(table);
      const select = built.select.bind(built);
      built.select = () => {
        const queried = select();
        const gte = queried.gte.bind(queried);
        queried.gte = () => {
          const ranged = gte();
          const lt = ranged.lt.bind(ranged);
          ranged.lt = () => {
            const result = lt();
            return Object.assign(result, {
              in: async () => ({ data: null, error: null, count: 7 })
            });
          };
          return ranged;
        };
        return queried;
      };
      return built;
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const gaps = await loadMoneyGaps(NOW);
    expect(gaps.usagePacks.totalCents).toBe(1399);
    expect(gaps.usagePacks.byBusiness.get("amy")).toBe(1399);
    expect(countMovedRows).toHaveBeenCalled();
  });

  it("returns zero emails when the business list fails", async () => {
    vi.mocked(getAdminPlatformSetting).mockResolvedValue(null);
    const db = {
      from(table: string) {
        return {
          select() {
            return {
              gte() {
                return {
                  lt: async () =>
                    table === "businesses"
                      ? businessesReply
                      : { data: [], error: null, count: null }
                };
              }
            };
          }
        };
      }
    } as unknown as MoneyGapDb;
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    let businessesReply: { data: unknown; error: { message: string } | null; count: null } = {
      data: null,
      error: { message: "businesses down" },
      count: null
    };
    const gaps = await loadMoneyGaps(NOW);
    expect(gaps.usagePacks.totalCents).toBe(0);
    businessesReply = { data: "nope", error: null, count: null };
    const again = await loadMoneyGaps(NOW);
    expect(again.software.resendCents).toBe(0);
  });
});
