import { describe, expect, it } from "vitest";
import {
  MAX_HORIZON_MS,
  buildNextBillingDateParams,
  buildPauseCollectionParams,
  buildResumeCollectionParams,
  describeBillingDateStripeError,
  pauseStateFromStripeSubscription
} from "@/lib/billing/admin-billing-controls";

const NOW = new Date("2026-07-27T12:00:00.000Z");

describe("buildPauseCollectionParams", () => {
  it("pauses indefinitely when no resume date is given", () => {
    for (const value of [null, undefined, ""]) {
      const res = buildPauseCollectionParams(value, NOW);
      expect(res).toEqual({ ok: true, value: { pause_collection: { behavior: "void" } } });
    }
  });

  it("attaches a future resume date as unix seconds", () => {
    const res = buildPauseCollectionParams("2026-09-01T00:00:00.000Z", NOW);
    expect(res).toEqual({
      ok: true,
      value: {
        pause_collection: {
          behavior: "void",
          resumes_at: Math.floor(Date.parse("2026-09-01T00:00:00.000Z") / 1000)
        }
      }
    });
  });

  it("rejects an unparseable resume date", () => {
    expect(buildPauseCollectionParams("not-a-date", NOW)).toEqual({
      ok: false,
      reason: "invalid_date"
    });
  });

  it("rejects a resume date in the past or too close to now", () => {
    expect(buildPauseCollectionParams("2026-07-27T12:00:30.000Z", NOW)).toEqual({
      ok: false,
      reason: "date_must_be_in_the_future"
    });
  });

  it("rejects a resume date beyond the two-year horizon", () => {
    const tooFar = new Date(NOW.getTime() + MAX_HORIZON_MS + 60_000).toISOString();
    expect(buildPauseCollectionParams(tooFar, NOW)).toEqual({
      ok: false,
      reason: "date_too_far_out"
    });
  });
});

describe("buildResumeCollectionParams", () => {
  it("clears the pause with an explicit null", () => {
    expect(buildResumeCollectionParams()).toEqual({ pause_collection: null });
  });
});

describe("buildNextBillingDateParams", () => {
  it("moves the anchor with no proration", () => {
    const res = buildNextBillingDateParams("2026-08-15T00:00:00.000Z", NOW);
    expect(res).toEqual({
      ok: true,
      value: {
        trial_end: Math.floor(Date.parse("2026-08-15T00:00:00.000Z") / 1000),
        proration_behavior: "none"
      }
    });
  });

  it("refuses a past date, since Stripe cannot bill backwards", () => {
    expect(buildNextBillingDateParams("2026-07-01T00:00:00.000Z", NOW)).toEqual({
      ok: false,
      reason: "date_must_be_in_the_future"
    });
  });

  it("refuses garbage input", () => {
    expect(buildNextBillingDateParams("", NOW)).toEqual({ ok: false, reason: "invalid_date" });
  });
});

describe("pauseStateFromStripeSubscription", () => {
  it("reads a pause with an auto-resume date", () => {
    const resumesAt = Math.floor(Date.parse("2026-09-01T00:00:00.000Z") / 1000);
    expect(
      pauseStateFromStripeSubscription({
        pause_collection: { behavior: "void", resumes_at: resumesAt }
      })
    ).toEqual({
      billing_paused: true,
      billing_pause_resumes_at: "2026-09-01T00:00:00.000Z"
    });
  });

  it("reads an open-ended pause", () => {
    expect(pauseStateFromStripeSubscription({ pause_collection: { behavior: "void" } })).toEqual({
      billing_paused: true,
      billing_pause_resumes_at: null
    });
  });

  it("treats a non-numeric resumes_at as no auto-resume", () => {
    expect(
      pauseStateFromStripeSubscription({
        pause_collection: { behavior: "void", resumes_at: "soon" }
      })
    ).toEqual({ billing_paused: true, billing_pause_resumes_at: null });
  });

  it("reads anything without a pause object as not paused", () => {
    for (const input of [null, undefined, "sub_1", { pause_collection: null }, {}]) {
      expect(pauseStateFromStripeSubscription(input)).toEqual({
        billing_paused: false,
        billing_pause_resumes_at: null
      });
    }
  });
});

describe("describeBillingDateStripeError", () => {
  it("explains the schedule-managed rejection in operator language", () => {
    const msg = describeBillingDateStripeError(
      "Cannot update `trial_end` on a subscription managed by a schedule."
    );
    expect(msg).toContain("commitment schedule");
    expect(msg).toContain("Stripe dashboard");
  });

  it("passes any other Stripe message through unchanged", () => {
    expect(describeBillingDateStripeError("No such subscription: sub_x")).toBe(
      "No such subscription: sub_x"
    );
  });
});
