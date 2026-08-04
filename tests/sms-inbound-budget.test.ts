import { describe, expect, it } from "vitest";
import {
  SMS_INBOUND_BATCH_BUDGET_MS,
  SMS_INBOUND_WORST_CASE_JOB_MS,
  smsInboundBatchHasRoom,
  smsInboundDeferredIds
} from "../supabase/functions/_shared/sms_inbound_budget";

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
