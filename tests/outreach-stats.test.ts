/**
 * Prospecting funnel (src/lib/outreach/stats.ts).
 *
 * This is the honedtech regression in test form: drafted is not sent, a reply
 * does not un-send a prospect, and the reply rate is a share of sends. A
 * dashboard that reports "contacted: 15" beside an empty sent folder is the
 * failure this file exists to prevent.
 */
import { describe, expect, it } from "vitest";

import { summarizeFunnel } from "@/lib/outreach/stats";

describe("summarizeFunnel", () => {
  it("counts drafted and sent as different events", () => {
    const { total } = summarizeFunnel([
      { status: "discovered", vertical: "hvac" },
      { status: "drafted", vertical: "hvac" },
      { status: "queued", vertical: "hvac" }
    ]);
    expect(total).toMatchObject({ discovered: 3, drafted: 2, pending: 2, sent: 0, replyRate: 0 });
  });

  it("keeps a prospect counted as sent after they reply, book, or unsubscribe", () => {
    const { total } = summarizeFunnel([
      { status: "sent", vertical: "hvac" },
      { status: "replied", vertical: "hvac" },
      { status: "booked", vertical: "hvac" },
      { status: "unsubscribed", vertical: "hvac" }
    ]);
    expect(total.sent).toBe(4);
    expect(total.drafted).toBe(4);
    // A booking is a reply too, so the reply rate is 2 of 4.
    expect(total.replied).toBe(2);
    expect(total.booked).toBe(1);
    expect(total.unsubscribed).toBe(1);
    expect(total.replyRate).toBe(0.5);
    // None of these are waiting on the owner any more.
    expect(total.pending).toBe(0);
  });

  it("counts a skipped draft as drafted but never as sent or pending", () => {
    const { total } = summarizeFunnel([
      { status: "skipped", vertical: "law" },
      { status: "failed", vertical: "law" }
    ]);
    expect(total).toMatchObject({
      discovered: 2,
      drafted: 1,
      pending: 0,
      sent: 0,
      skipped: 1,
      failed: 1,
      replyRate: 0
    });
  });

  it("breaks the funnel down per vertical, busiest by sends first", () => {
    const { byVertical } = summarizeFunnel([
      { status: "sent", vertical: "hvac" },
      { status: "replied", vertical: "hvac" },
      { status: "sent", vertical: "law" },
      { status: "discovered", vertical: "roofing" }
    ]);
    expect(byVertical.map((v) => v.vertical)).toEqual(["hvac", "law", "roofing"]);
    expect(byVertical[0]).toMatchObject({ sent: 2, replied: 1, replyRate: 0.5 });
    expect(byVertical[2]).toMatchObject({ discovered: 1, sent: 0, replyRate: 0 });
  });

  it("groups rows discovered before verticals were recorded, and orders ties by volume", () => {
    const { byVertical } = summarizeFunnel([
      { status: "discovered", vertical: "  " },
      { status: "discovered", vertical: "" },
      { status: "drafted", vertical: "hvac" }
    ]);
    expect(byVertical.map((v) => v.vertical)).toEqual(["(unknown)", "hvac"]);
    expect(byVertical[0].discovered).toBe(2);
  });

  it("has an empty funnel for a business that has discovered nobody", () => {
    const { total, byVertical } = summarizeFunnel([]);
    expect(byVertical).toEqual([]);
    expect(total).toEqual({
      discovered: 0,
      drafted: 0,
      open: 0,
      pending: 0,
      sent: 0,
      replied: 0,
      booked: 0,
      unsubscribed: 0,
      skipped: 0,
      failed: 0,
      replyRate: 0
    });
  });
});

describe("open, and the trades worth listing", () => {
  it("counts exactly what a per-trade Skip would catch", () => {
    // Kept in lockstep with CANCELLABLE_STATUSES in db.ts. A row that offers to
    // skip a count it cannot actually skip is worse than no count: it is how
    // the confirm came to say "skips 0 waiting drafts" over 63 prospects.
    const { total } = summarizeFunnel([
      { status: "discovered", vertical: "hvac" },
      { status: "drafted", vertical: "hvac" },
      // Already in flight, already gone, or already retired: none cancellable.
      { status: "queued", vertical: "hvac" },
      { status: "sent", vertical: "hvac" },
      { status: "skipped", vertical: "hvac" },
      { status: "failed", vertical: "hvac" }
    ]);
    expect(total.open).toBe(2);
    // `pending` is a different question (the owner's read queue) and still
    // counts `queued`, so the two must not be swapped for each other.
    expect(total.pending).toBe(2);
  });

  it("drops a trade with nothing sent and nothing left, and keeps one with a send", () => {
    // The dental case: every prospect skipped, none ever sent. The row answered
    // "which trades reply" with silence and could not be acted on either, but it
    // kept rendering "63 drafted" beside a live Skip button, so a skip that
    // worked looked like it had done nothing.
    const { byVertical } = summarizeFunnel([
      { status: "skipped", vertical: "dental office" },
      { status: "skipped", vertical: "dental office" },
      { status: "skipped", vertical: "law firm" },
      // One send is reply evidence, however old, so the trade stays listed.
      { status: "sent", vertical: "law firm" },
      { status: "drafted", vertical: "plumber" }
    ]);
    expect(byVertical.map((v) => v.vertical)).toEqual(["law firm", "plumber"]);
    // Dropped from the table, still counted in the whole-business funnel: the
    // prospects exist, and hiding a row must not quietly change the numbers.
    expect(summarizeFunnel([{ status: "skipped", vertical: "dental office" }]).total.skipped).toBe(
      1
    );
  });
});
