import { describe, expect, it } from "vitest";
import {
  DEAL_STATUSES,
  MAX_DEAL_COMMISSION_BPS,
  MAX_DEAL_TITLE_LENGTH,
  MAX_DEAL_VALUE_CENTS,
  applyDealStatusToList,
  canTransitionDealStatus,
  commissionValueCents,
  dealCreateSchema,
  dealPatchSchema,
  dealStatusStamps,
  formatCommissionBps,
  formatDealValue,
  type DealStatus
} from "@/lib/deals/core";

describe("dealCreateSchema", () => {
  it("accepts a full deal and normalizes title/currency", () => {
    const parsed = dealCreateSchema.parse({
      title: "  123 Main St listing  ",
      contactId: "11111111-1111-4111-8111-111111111111",
      valueCents: 45000000,
      currency: "usd",
      commissionBps: 250,
      expectedCloseDate: "2026-09-15",
      status: "under_contract"
    });
    expect(parsed.title).toBe("123 Main St listing");
    expect(parsed.currency).toBe("USD");
    expect(parsed.status).toBe("under_contract");
  });

  it("requires only the title", () => {
    expect(dealCreateSchema.parse({ title: "Roof job" })).toEqual({ title: "Roof job" });
  });

  it("rejects blank / oversized titles and unknown keys", () => {
    expect(dealCreateSchema.safeParse({ title: "   " }).success).toBe(false);
    expect(
      dealCreateSchema.safeParse({ title: "x".repeat(MAX_DEAL_TITLE_LENGTH + 1) }).success
    ).toBe(false);
    expect(dealCreateSchema.safeParse({ title: "ok", bogus: 1 }).success).toBe(false);
  });

  it("bounds value and commission and rejects malformed currency", () => {
    expect(dealCreateSchema.safeParse({ title: "ok", valueCents: -1 }).success).toBe(false);
    expect(
      dealCreateSchema.safeParse({ title: "ok", valueCents: MAX_DEAL_VALUE_CENTS + 1 }).success
    ).toBe(false);
    expect(dealCreateSchema.safeParse({ title: "ok", valueCents: 12.5 }).success).toBe(false);
    expect(
      dealCreateSchema.safeParse({ title: "ok", commissionBps: MAX_DEAL_COMMISSION_BPS + 1 })
        .success
    ).toBe(false);
    expect(dealCreateSchema.safeParse({ title: "ok", currency: "DOLLARS" }).success).toBe(false);
    // Nullable money fields accept an explicit null (clear the value).
    expect(
      dealCreateSchema.parse({ title: "ok", valueCents: null, commissionBps: null })
    ).toMatchObject({ valueCents: null, commissionBps: null });
  });

  it("rejects malformed and impossible close dates, accepts real ones", () => {
    expect(dealCreateSchema.safeParse({ title: "ok", expectedCloseDate: "9/15/26" }).success).toBe(
      false
    );
    expect(
      dealCreateSchema.safeParse({ title: "ok", expectedCloseDate: "2026-02-31" }).success
    ).toBe(false);
    expect(
      dealCreateSchema.safeParse({ title: "ok", expectedCloseDate: "2026-99-99" }).success
    ).toBe(false);
    expect(
      dealCreateSchema.parse({ title: "ok", expectedCloseDate: "2026-02-28" }).expectedCloseDate
    ).toBe("2026-02-28");
  });
});

describe("dealPatchSchema", () => {
  it("accepts any single field but rejects an empty patch", () => {
    expect(dealPatchSchema.parse({ status: "won" })).toEqual({ status: "won" });
    expect(dealPatchSchema.safeParse({}).success).toBe(false);
  });
});

describe("canTransitionDealStatus", () => {
  it("staying put is always legal", () => {
    for (const status of DEAL_STATUSES) {
      expect(canTransitionDealStatus(status, status)).toBe(true);
    }
  });

  it("open moves anywhere forward; under_contract can step back or close", () => {
    expect(canTransitionDealStatus("open", "under_contract")).toBe(true);
    expect(canTransitionDealStatus("open", "won")).toBe(true);
    expect(canTransitionDealStatus("open", "lost")).toBe(true);
    expect(canTransitionDealStatus("under_contract", "open")).toBe(true);
    expect(canTransitionDealStatus("under_contract", "won")).toBe(true);
    expect(canTransitionDealStatus("under_contract", "lost")).toBe(true);
  });

  it("terminal states reopen but never swap directly", () => {
    expect(canTransitionDealStatus("won", "open")).toBe(true);
    expect(canTransitionDealStatus("won", "under_contract")).toBe(true);
    expect(canTransitionDealStatus("lost", "open")).toBe(true);
    expect(canTransitionDealStatus("lost", "under_contract")).toBe(true);
    expect(canTransitionDealStatus("won", "lost")).toBe(false);
    expect(canTransitionDealStatus("lost", "won")).toBe(false);
  });
});

describe("dealStatusStamps", () => {
  const NOW = "2026-08-20T12:00:00.000Z";

  it("winning stamps won_at, losing stamps lost_at", () => {
    expect(dealStatusStamps("won", NOW)).toEqual({ won_at: NOW, lost_at: null });
    expect(dealStatusStamps("lost", NOW)).toEqual({ won_at: null, lost_at: NOW });
  });

  it("reopening clears both stamps", () => {
    for (const status of ["open", "under_contract"] as DealStatus[]) {
      expect(dealStatusStamps(status, NOW)).toEqual({ won_at: null, lost_at: null });
    }
  });
});

describe("formatDealValue", () => {
  it("formats whole dollars without cents and fractional values with them", () => {
    expect(formatDealValue(1250000, "USD")).toBe("$12,500");
    expect(formatDealValue(123456, "USD")).toBe("$1,234.56");
  });

  it("null in, null out (an unsized deal shows nothing, not $0)", () => {
    expect(formatDealValue(null, "USD")).toBeNull();
  });

  it("falls back to a plain amount when the currency code cannot format", () => {
    expect(formatDealValue(150000, "no")).toBe("1500 no");
    expect(formatDealValue(150050, "no")).toBe("1500.50 no");
  });
});

describe("formatCommissionBps", () => {
  it("renders percent with trailing zeros trimmed", () => {
    expect(formatCommissionBps(250)).toBe("2.5%");
    expect(formatCommissionBps(300)).toBe("3%");
    expect(formatCommissionBps(333)).toBe("3.33%");
    expect(formatCommissionBps(0)).toBe("0%");
  });
});

describe("commissionValueCents", () => {
  it("rounds to the cent and passes null through", () => {
    expect(commissionValueCents(45000000, 250)).toBe(1125000);
    expect(commissionValueCents(333333, 250)).toBe(8333);
    expect(commissionValueCents(null, 250)).toBeNull();
    expect(commissionValueCents(45000000, null)).toBeNull();
  });
});

describe("applyDealStatusToList", () => {
  const board = (): { id: string; status: DealStatus; title: string }[] => [
    { id: "a", status: "open", title: "A" },
    { id: "b", status: "open", title: "B" }
  ];

  it("moves only the named deal and leaves the others by reference", () => {
    const before = board();
    const after = applyDealStatusToList(before, "a", "won");
    expect(after?.map((d) => [d.id, d.status])).toEqual([
      ["a", "won"],
      ["b", "open"]
    ]);
    // The untouched card keeps its identity, so React skips re-rendering it.
    expect(after?.[1]).toBe(before[1]);
  });

  it("a failed drag's rollback cannot undo another deal's finished move", () => {
    // The Bugbot case: drag A, drag B, B's PATCH lands first, then A's fails.
    // Rolling A back must not restore a snapshot that still shows B as open.
    let list: ReturnType<typeof board> | null = board();
    list = applyDealStatusToList(list, "a", "won"); // optimistic A
    list = applyDealStatusToList(list, "b", "lost"); // optimistic B
    list = applyDealStatusToList(list, "a", "open"); // A's rollback
    expect(list?.map((d) => [d.id, d.status])).toEqual([
      ["a", "open"],
      ["b", "lost"]
    ]);
  });

  it("returns the same list when the deal is missing or already there", () => {
    const before = board();
    expect(applyDealStatusToList(before, "zz", "won")).toBe(before);
    expect(applyDealStatusToList(before, "a", "open")).toBe(before);
  });

  it("passes a null list through, so a late rollback cannot resurrect a board", () => {
    expect(applyDealStatusToList(null, "a", "won")).toBeNull();
  });
});
