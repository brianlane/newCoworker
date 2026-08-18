import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/db/white-glove-offers", () => ({ extendPrioritySupport: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ clearPrioritySupportNudgeStamp: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { attachIntakePrioritySupportToBusiness } from "@/lib/white-glove/intake";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { extendPrioritySupport } from "@/lib/db/white-glove-offers";
import { clearPrioritySupportNudgeStamp } from "@/lib/db/businesses";
import { logger } from "@/lib/logger";

const BIZ = "0f0f0f0f-0000-4000-8000-0000000000bb";
const DAY = 24 * 60 * 60 * 1000;

/**
 * One builder, same shape as the offers attach test: the link-and-claim UPDATE
 * terminates in .select(); the release UPDATE terminates in .in().
 */
function attachDb(opts: { claim?: unknown } = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue({ error: null }),
    select: vi.fn().mockResolvedValue(
      opts.claim ?? { data: [{ id: "intake-1" }], error: null }
    )
  };
}

describe("attachIntakePrioritySupportToBusiness", () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * Point the module's default client at the stub, which is what exercises
   * the `client ?? await createSupabaseServiceClient()` await. Injecting a
   * client instead skips that await, and v8 then reports every statement
   * after it as an unreached async continuation.
   *
   * Deliberately NOT named use*: that prefix makes eslint treat it as a
   * React Hook, and these tests call it inside loops.
   */
  function withDb(db: unknown) {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    return db;
  }

  it("opens a 30-day window when a completed questionnaire is claimed", async () => {
    const db = withDb(attachDb()) as ReturnType<typeof attachDb>;
    const n = await attachIntakePrioritySupportToBusiness(BIZ, "owner@test.com");
    expect(n).toBe(1);
    expect(extendPrioritySupport).toHaveBeenCalledTimes(1);
    const until = vi.mocked(extendPrioritySupport).mock.calls[0]![1] as Date;
    const days = (until.getTime() - Date.now()) / DAY;
    // FROM NOW, not from submission: a prospect who filled it in weeks ago
    // still gets a full month.
    expect(days).toBeGreaterThan(29.5);
    expect(days).toBeLessThan(30.5);
    // A new window must be able to warn before it lapses.
    expect(clearPrioritySupportNudgeStamp).toHaveBeenCalledWith(BIZ, db);
  });

  it("grants NOTHING when the claim matches no rows (already granted)", async () => {
    // The idempotence case: re-running the signup attach, or the Stripe-first
    // re-attach once the real email lands, must not open a second window.
    const db = withDb(attachDb({ claim: { data: [], error: null } })) as ReturnType<typeof attachDb>;
    const n = await attachIntakePrioritySupportToBusiness(BIZ, "owner@test.com");
    expect(n).toBe(0);
    expect(extendPrioritySupport).not.toHaveBeenCalled();
    expect(clearPrioritySupportNudgeStamp).not.toHaveBeenCalled();
  });

  it("claims with a compare-and-swap on the granted stamp", async () => {
    const db = withDb(attachDb()) as ReturnType<typeof attachDb>;
    await attachIntakePrioritySupportToBusiness(BIZ, "owner@test.com");
    // The `is(..., null)` guard in the WHERE clause is the whole mechanism:
    // two concurrent callers cannot both win it.
    expect(db.is).toHaveBeenCalledWith("priority_support_granted_at", null);
    expect(db.eq).toHaveBeenCalledWith("status", "completed");
  });

  it("escapes LIKE metacharacters so one prospect cannot match another", async () => {
    const db = withDb(attachDb()) as ReturnType<typeof attachDb>;
    await attachIntakePrioritySupportToBusiness(BIZ, "john_doe@test.com");
    expect(db.ilike).toHaveBeenCalledWith("recipient_email", "john\\_doe@test.com");
  });

  it("releases the claim when the grant fails, so a retry can still grant", async () => {
    // Stamping a questionnaire as granted when no window opened would lose the
    // customer a month with nothing to notice it.
    vi.mocked(extendPrioritySupport).mockRejectedValueOnce(new Error("db down"));
    const db = withDb(attachDb()) as ReturnType<typeof attachDb>;
    await expect(
      attachIntakePrioritySupportToBusiness(BIZ, "owner@test.com")
    ).rejects.toThrow(/db down/);
    expect(db.update).toHaveBeenCalledWith({ priority_support_granted_at: null });
    expect(db.in).toHaveBeenCalledWith("id", ["intake-1"]);
  });

  it("treats a null claim payload as nothing claimed", async () => {
    const db = withDb(attachDb({ claim: { data: null, error: null } })) as ReturnType<
      typeof attachDb
    >;
    expect(await attachIntakePrioritySupportToBusiness(BIZ, "owner@test.com")).toBe(0);
    expect(extendPrioritySupport).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalled();
  });

  it("uses an injected client when one is given", async () => {
    const db = attachDb();
    expect(await attachIntakePrioritySupportToBusiness(BIZ, "owner@test.com", db as never)).toBe(
      1
    );
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("keeps the window when only the nudge re-arm fails", async () => {
    // The window IS open. Releasing the claim here would let a retry re-claim
    // an already-granted questionnaire and log it as if support never opened.
    for (const thrown of [new Error("stamp down"), "stamp down"]) {
      vi.clearAllMocks();
      vi.mocked(clearPrioritySupportNudgeStamp).mockRejectedValueOnce(thrown as never);
      const db = withDb(attachDb()) as ReturnType<typeof attachDb>;
      expect(await attachIntakePrioritySupportToBusiness(BIZ, "owner@test.com")).toBe(1);
      expect(extendPrioritySupport).toHaveBeenCalledTimes(1);
      // No rollback: the only UPDATE payload is the claim, never a null release.
      expect(db.update).not.toHaveBeenCalledWith({ priority_support_granted_at: null });
      expect(logger.warn).toHaveBeenCalled();
    }
  });

  it("shouts when the claim release ALSO fails, because the month is stranded", async () => {
    // Stamped as granted with no window behind it: the compare-and-swap will
    // never match again, so nothing downstream can detect or repair it.
    for (const thrown of [new Error("db down"), "db down"]) {
      vi.clearAllMocks();
      vi.mocked(extendPrioritySupport).mockRejectedValueOnce(thrown as never);
      const db = attachDb();
      db.in.mockResolvedValueOnce({ error: { message: "release down" } } as never);
      withDb(db);
      await expect(
        attachIntakePrioritySupportToBusiness(BIZ, "owner@test.com")
      ).rejects.toThrow(/db down/);
      expect(logger.error).toHaveBeenCalledWith(
        "intake priority support: claim release FAILED, grant stranded",
        expect.objectContaining({ businessId: BIZ, intakeIds: ["intake-1"] })
      );
    }
  });

  it("is a no-op for a blank owner email", async () => {
    const db = withDb(attachDb()) as ReturnType<typeof attachDb>;
    expect(await attachIntakePrioritySupportToBusiness(BIZ, "   ")).toBe(0);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("never steals a questionnaire that belongs to another business", async () => {
    const db = withDb(attachDb()) as ReturnType<typeof attachDb>;
    await attachIntakePrioritySupportToBusiness(BIZ, "owner@test.com");
    expect(db.or).toHaveBeenCalledWith(`business_id.is.null,business_id.eq.${BIZ}`);
  });

  it("throws when the claim fails", async () => {
    const db = withDb(attachDb({ claim: { data: null, error: { message: "claim boom" } } })) as ReturnType<typeof attachDb>;
    await expect(
      attachIntakePrioritySupportToBusiness(BIZ, "o@t.com")
    ).rejects.toThrow(/claim boom/);
    expect(extendPrioritySupport).not.toHaveBeenCalled();
  });
});
