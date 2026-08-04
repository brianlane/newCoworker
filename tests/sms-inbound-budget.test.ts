import { describe, expect, it } from "vitest";
import {
  SMS_INBOUND_BATCH_BUDGET_MS,
  SMS_INBOUND_JOB_TAIL_RESERVE_MS,
  SMS_INBOUND_MIN_MODEL_BUDGET_MS,
  SMS_INBOUND_WORST_CASE_JOB_MS,
  smsInboundBatchHasRoom,
  smsInboundDeferredIds,
  smsInboundModelBudgetMs
} from "../supabase/functions/_shared/sms_inbound_budget";

/** Mirrors the worker's own constants, which the Edge runtime cannot export. */
const OWNER_SMS_TURN_TIMEOUT_MS = 75_000;
const ROWBOAT_RETRY_BUDGET_MS = 80_000;
const ROWBOAT_CHAT_TIMEOUT_MS = 60_000;

/**
 * The numbers here are the whole point of the module, so they are asserted
 * directly: the batch budget plus one worst-case job has to land inside the
 * 150s Supabase request ceiling with a reserve, or the worker gets killed
 * mid-job again and leaves claims blocking their contacts' queues.
 */
const EDGE_REQUEST_CEILING_MS = 150_000;

describe("sms inbound batch budget sizing", () => {
  it("leaves a reserve against the Edge request ceiling in the worst case", () => {
    const worstCase = SMS_INBOUND_BATCH_BUDGET_MS + SMS_INBOUND_WORST_CASE_JOB_MS;
    expect(worstCase).toBeLessThan(EDGE_REQUEST_CEILING_MS);
    expect(EDGE_REQUEST_CEILING_MS - worstCase).toBeGreaterThanOrEqual(10_000);
  });

  it("is covered by the job's pg_cron timeout of 150000", () => {
    expect(SMS_INBOUND_BATCH_BUDGET_MS + SMS_INBOUND_WORST_CASE_JOB_MS).toBeLessThanOrEqual(
      150_000
    );
  });

  /**
   * The regression Bugbot caught on this PR. An owner turn can burn its full
   * timeout and return null, and the caller then falls through to the Rowboat
   * staff path. With a fresh ROWBOAT_RETRY_BUDGET_MS that was 75 + 80 + 10 =
   * 165s for one job, past the 150s ceiling before any batching.
   */
  it("keeps an owner turn plus its Rowboat fallback inside one job's budget", () => {
    const afterOwnerTurn = smsInboundModelBudgetMs(
      OWNER_SMS_TURN_TIMEOUT_MS,
      ROWBOAT_RETRY_BUDGET_MS
    );
    const worstOwnerJob =
      OWNER_SMS_TURN_TIMEOUT_MS + afterOwnerTurn + SMS_INBOUND_JOB_TAIL_RESERVE_MS;
    expect(worstOwnerJob).toBeLessThanOrEqual(SMS_INBOUND_WORST_CASE_JOB_MS);
    expect(SMS_INBOUND_BATCH_BUDGET_MS + worstOwnerJob).toBeLessThan(EDGE_REQUEST_CEILING_MS);
  });

  /**
   * The follow-on Bugbot caught after the first attempt at the fix above.
   * callSmsRowboatWithStatelessFallback derives only the RETRY's timeout from
   * budgetMs; the first /chat attempt runs on timeoutMs exactly as passed. So
   * clamping budgetMs alone left a 60s first attempt on top of a 75s owner
   * turn. The worker clamps both, which is what this models.
   */
  it("clamps the first Rowboat attempt too, not just the retry", () => {
    const budget = smsInboundModelBudgetMs(OWNER_SMS_TURN_TIMEOUT_MS, ROWBOAT_RETRY_BUDGET_MS);
    const firstAttemptMs = Math.min(ROWBOAT_CHAT_TIMEOUT_MS, budget);
    expect(firstAttemptMs).toBeLessThanOrEqual(budget);

    const worstOwnerJob =
      OWNER_SMS_TURN_TIMEOUT_MS + firstAttemptMs + SMS_INBOUND_JOB_TAIL_RESERVE_MS;
    expect(SMS_INBOUND_BATCH_BUDGET_MS + worstOwnerJob).toBeLessThan(EDGE_REQUEST_CEILING_MS);
  });

  it("leaves a fresh customer job's first attempt at the full chat timeout", () => {
    const budget = smsInboundModelBudgetMs(0, ROWBOAT_RETRY_BUDGET_MS);
    expect(Math.min(ROWBOAT_CHAT_TIMEOUT_MS, budget)).toBe(ROWBOAT_CHAT_TIMEOUT_MS);
  });
});

describe("smsInboundModelBudgetMs", () => {
  it("leaves a fresh customer job with the full budget it has today", () => {
    expect(smsInboundModelBudgetMs(0, ROWBOAT_RETRY_BUDGET_MS)).toBe(ROWBOAT_RETRY_BUDGET_MS);
    expect(smsInboundModelBudgetMs(500, ROWBOAT_RETRY_BUDGET_MS)).toBe(ROWBOAT_RETRY_BUDGET_MS);
  });

  it("shrinks the budget once the job has already spent time", () => {
    expect(smsInboundModelBudgetMs(50_000, ROWBOAT_RETRY_BUDGET_MS)).toBe(
      SMS_INBOUND_WORST_CASE_JOB_MS - SMS_INBOUND_JOB_TAIL_RESERVE_MS - 50_000
    );
  });

  it("never returns less than the floor, even past the whole budget", () => {
    expect(smsInboundModelBudgetMs(SMS_INBOUND_WORST_CASE_JOB_MS, ROWBOAT_RETRY_BUDGET_MS)).toBe(
      SMS_INBOUND_MIN_MODEL_BUDGET_MS
    );
    expect(smsInboundModelBudgetMs(10_000_000, ROWBOAT_RETRY_BUDGET_MS)).toBe(
      SMS_INBOUND_MIN_MODEL_BUDGET_MS
    );
  });

  it("never returns more than the caller asked for", () => {
    expect(smsInboundModelBudgetMs(0, 1_000)).toBe(1_000);
  });
});

describe("smsInboundBatchHasRoom", () => {
  it("always runs the first job, however long the claim took", () => {
    expect(smsInboundBatchHasRoom(0, 0)).toBe(true);
    expect(smsInboundBatchHasRoom(0, SMS_INBOUND_BATCH_BUDGET_MS * 10)).toBe(true);
  });

  it("keeps going while the budget is unspent", () => {
    expect(smsInboundBatchHasRoom(1, 0)).toBe(true);
    expect(smsInboundBatchHasRoom(3, SMS_INBOUND_BATCH_BUDGET_MS - 1)).toBe(true);
  });

  it("stops starting jobs once the budget is spent", () => {
    expect(smsInboundBatchHasRoom(1, SMS_INBOUND_BATCH_BUDGET_MS)).toBe(false);
    expect(smsInboundBatchHasRoom(7, SMS_INBOUND_BATCH_BUDGET_MS + 1)).toBe(false);
  });

  it("honours an explicit budget override", () => {
    expect(smsInboundBatchHasRoom(1, 5_000, 10_000)).toBe(true);
    expect(smsInboundBatchHasRoom(1, 10_000, 10_000)).toBe(false);
  });
});

describe("smsInboundDeferredIds", () => {
  const claimed = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("returns the untouched tail of the batch", () => {
    expect(smsInboundDeferredIds(claimed, 1)).toEqual(["b", "c"]);
    expect(smsInboundDeferredIds(claimed, 2)).toEqual(["c"]);
  });

  it("returns nothing when the whole batch ran", () => {
    expect(smsInboundDeferredIds(claimed, 3)).toEqual([]);
    expect(smsInboundDeferredIds(claimed, 99)).toEqual([]);
  });

  it("returns nothing for an empty claim", () => {
    expect(smsInboundDeferredIds([], 0)).toEqual([]);
  });

  it("treats a negative index as the start of the batch", () => {
    expect(smsInboundDeferredIds(claimed, -1)).toEqual(["a", "b", "c"]);
  });
});
