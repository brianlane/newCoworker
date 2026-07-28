import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  DISMISSIBLE_CARDS,
  dismissCard,
  isDismissibleCardKey,
  listDismissedCardKeys
} from "@/lib/dashboard/dismissed-cards";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

const USER = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DISMISSIBLE_CARDS catalog", () => {
  it("has unique keys and covers the three AiFlows starter cards", () => {
    expect(new Set(DISMISSIBLE_CARDS).size).toBe(DISMISSIBLE_CARDS.length);
    expect([...DISMISSIBLE_CARDS]).toEqual([
      "aiflows.review_request",
      "aiflows.document_receipt",
      "aiflows.new_lead_intake"
    ]);
  });

  it("recognizes catalog keys and rejects anything else", () => {
    expect(isDismissibleCardKey("aiflows.new_lead_intake")).toBe(true);
    expect(isDismissibleCardKey("aiflows.retired_card")).toBe(false);
  });
});

describe("listDismissedCardKeys", () => {
  function readDb(result: { data: unknown; error: { message: string } | null }) {
    return {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue(result)
    };
  }

  it("returns the user's dismissed keys", async () => {
    const db = readDb({
      data: [{ card_key: "aiflows.review_request" }],
      error: null
    });
    expect(await listDismissedCardKeys(USER, db as never)).toEqual(["aiflows.review_request"]);
    expect(db.from).toHaveBeenCalledWith("user_dismissed_cards");
    expect(db.eq).toHaveBeenCalledWith("user_id", USER);
  });

  it("drops keys that are no longer in the catalog", async () => {
    const db = readDb({
      data: [{ card_key: "aiflows.retired_card" }, { card_key: "aiflows.document_receipt" }],
      error: null
    });
    expect(await listDismissedCardKeys(USER, db as never)).toEqual(["aiflows.document_receipt"]);
  });

  it("shows every card (warn-logged) when the read fails", async () => {
    const db = readDb({ data: null, error: { message: "rls" } });
    expect(await listDismissedCardKeys(USER, db as never)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "listDismissedCardKeys failed; showing every card",
      expect.objectContaining({ userId: USER })
    );
  });

  it("handles a null payload and a non-Error throw, falling back to the service client", async () => {
    const db = readDb({ data: null, error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listDismissedCardKeys(USER)).toEqual([]);
    expect(createSupabaseServiceClient).toHaveBeenCalled();

    vi.mocked(createSupabaseServiceClient).mockRejectedValueOnce("raw failure" as never);
    expect(await listDismissedCardKeys(USER)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "listDismissedCardKeys failed; showing every card",
      expect.objectContaining({ error: "raw failure" })
    );
  });
});

describe("dismissCard", () => {
  function upsertDb(error: { message: string } | null = null) {
    return {
      from: vi.fn().mockReturnThis(),
      upsert: vi.fn().mockResolvedValue({ error })
    };
  }

  it("upserts the row so re-dismissing is a no-op", async () => {
    const db = upsertDb();
    await dismissCard(USER, "aiflows.new_lead_intake", db as never);
    expect(db.from).toHaveBeenCalledWith("user_dismissed_cards");
    expect(db.upsert).toHaveBeenCalledWith(
      { user_id: USER, card_key: "aiflows.new_lead_intake" },
      { onConflict: "user_id,card_key" }
    );
  });

  it("rejects a key that is not in the catalog", async () => {
    await expect(dismissCard(USER, "aiflows.made_up", upsertDb() as never)).rejects.toThrow(
      'dismissCard: unknown card key "aiflows.made_up"'
    );
  });

  it("throws on a write error", async () => {
    const db = upsertDb({ message: "boom" });
    await expect(
      dismissCard(USER, "aiflows.new_lead_intake", db as never)
    ).rejects.toThrow("dismissCard: boom");
  });

  it("falls back to the service client", async () => {
    const db = upsertDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await dismissCard(USER, "aiflows.document_receipt");
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

