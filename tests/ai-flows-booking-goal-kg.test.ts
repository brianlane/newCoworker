/**
 * Booking-goal fire → knowledge-graph booking ingest (PR 3 hook): one
 * ingest per ORIGINAL identity, identity-less entries skipped, and the
 * goal fan-out result unchanged by the graph work.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { fireBookingGoalsForIdentities } from "@/lib/ai-flows/booking-goal-fire";

const BIZ = "11111111-1111-4111-8111-111111111111";

/** Minimal contacts stub for contactNumbersFor's union query. */
function stubDb() {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "or"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  return chain as never;
}

describe("fireBookingGoalsForIdentities — KG booking ingest", () => {
  it("ingests once per original identity (kg-source: booking) and skips identity-less entries", async () => {
    const ingestBookingEvent = vi.fn(async () => ({ ran: true }));
    const applyGoal = vi.fn(async () => ({ jumpedRuns: 1 }));
    const findByEmails = vi.fn(async () => new Map());

    const result = await fireBookingGoalsForIdentities(
      stubDb(),
      BIZ,
      [
        { phone: "+14805551234", email: "buyer@x.co" },
        { phone: null, email: "other@x.co" },
        { phone: null, email: null }
      ],
      { applyGoal: applyGoal as never, findByEmails: findByEmails as never, ingestBookingEvent }
    );

    expect(result.goalsFired).toBeGreaterThan(0);
    expect(ingestBookingEvent).toHaveBeenCalledTimes(2);
    expect(ingestBookingEvent).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        phoneE164: "+14805551234",
        email: "buyer@x.co",
        detail: expect.stringMatching(/^appointment booked \(\d{4}-\d{2}-\d{2}\)$/)
      })
    );
    expect(ingestBookingEvent).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ phoneE164: null, email: "other@x.co" })
    );
  });
});
