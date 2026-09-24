import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  loadMoneyGaps,
  loadUsagePackGrants,
  priceLoadedGrants,
  utcMonthWindow,
  type MoneyGapDb
} from "@/lib/admin/money-gap-load";
import { monthlySoftwareCosts } from "@/lib/admin/software-costs";

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
                lt: async () => responses[table] ?? { data: [], error: null, count: null }
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
  delete process.env.STRIPE_VOICE_BONUS_30MIN_PRICE_ID;
  delete process.env.STRIPE_VOICE_BONUS_30MIN_CENTS;
  delete process.env.STRIPE_SMS_BONUS_500_PRICE_ID;
  delete process.env.STRIPE_SMS_BONUS_500_CENTS;
  delete process.env.STRIPE_CHAT_CREDIT_5USD_PRICE_ID;
  delete process.env.STRIPE_CHAT_CREDIT_5USD_CENTS;
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
    process.env.STRIPE_SMS_BONUS_500_PRICE_ID = "price_sms";
    process.env.STRIPE_SMS_BONUS_500_CENTS = "1000";
    process.env.STRIPE_CHAT_CREDIT_5USD_PRICE_ID = "price_chat";
    process.env.STRIPE_CHAT_CREDIT_5USD_CENTS = "500";
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

describe("loadMoneyGaps", () => {
  it("keeps the monthly receipts when the grant read throws", async () => {
    vi.mocked(createSupabaseServiceClient).mockRejectedValueOnce(new Error("no db"));
    const gaps = await loadMoneyGaps(NOW);
    expect(gaps.usagePacks.totalCents).toBe(0);
    expect(gaps.software).toEqual(monthlySoftwareCosts());

    vi.mocked(createSupabaseServiceClient).mockRejectedValueOnce("no db string");
    const again = await loadMoneyGaps(NOW);
    expect(again.software.cursorCents).toBe(20_000);
  });

  it("prices grants and still attaches the four receipts", async () => {
    process.env.STRIPE_VOICE_BONUS_30MIN_PRICE_ID = "price_30";
    process.env.STRIPE_VOICE_BONUS_30MIN_CENTS = "1399";
    process.env.STRIPE_SMS_BONUS_500_PRICE_ID = "price_sms";
    process.env.STRIPE_CHAT_CREDIT_5USD_PRICE_ID = "price_chat";
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      grantDb({
        voice_bonus_grants: {
          data: [
            {
              business_id: "amy",
              stripe_checkout_session_id: "pi_1",
              voided_at: null,
              seconds_purchased: 1800
            }
          ],
          error: null
        }
      }) as never
    );
    const gaps = await loadMoneyGaps(NOW);
    expect(gaps.usagePacks.totalCents).toBe(1399);
    expect(gaps.usagePacks.byBusiness.get("amy")).toBe(1399);
    expect(gaps.software).toEqual({
      vercelCents: 2_166,
      resendCents: 2_000,
      zoomCents: 1_699,
      cursorCents: 20_000
    });
  });
});
