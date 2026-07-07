import { describe, expect, it } from "vitest";
import {
  classifyStaleOfferReply,
  staleOfferAckText,
  type StaleOfferCandidate
} from "../supabase/functions/_shared/ai_flows/stale_offer";

const GABBY = "+14807202013";
const NEXT_AGENT = "+14807039575";
const DAVE = "+16025245719";

const NOW = Date.parse("2026-07-02T20:26:22Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function row(over: Partial<StaleOfferCandidate> & { routing?: Record<string, unknown> }): StaleOfferCandidate {
  const { routing, ...rest } = over;
  return {
    id: "run-1",
    status: "done",
    context: routing === undefined ? { routing: {} } : { routing },
    awaiting_agent_e164: null,
    updated_at: new Date(NOW - 5 * 60 * 1000).toISOString(),
    ...rest
  };
}

function classify(candidates: StaleOfferCandidate[], digit = "1", from = GABBY) {
  return classifyStaleOfferReply({ candidates, from, digit, nowMs: NOW, windowMs: DAY_MS });
}

describe("classifyStaleOfferReply", () => {
  it("returns live_with_other for a '1' on an offer live with another teammate (first-to-claim on)", () => {
    // Reaching the classifier with a "1" in this state means the sender added
    // an ETA ("1, a few hours") — the ack teaches the bare-"1" yank instead of
    // pretending the lead moved on for good.
    const r = classify([
      row({
        status: "awaiting_agent",
        routing: {
          offered: NEXT_AGENT,
          tried: [GABBY],
          offered_log: [GABBY, NEXT_AGENT],
          step_index: 11
        }
      })
    ]);
    expect(r).toEqual({ runId: "run-1", kind: "live_with_other", claimedName: "" });
  });

  it("returns moved_on instead when the flow opted out of first-to-claim", () => {
    const r = classify([
      row({
        status: "awaiting_agent",
        routing: {
          offered: NEXT_AGENT,
          tried: [GABBY],
          offered_log: [GABBY, NEXT_AGENT],
          step_index: 11,
          first_to_claim: false
        }
      })
    ]);
    expect(r).toEqual({ runId: "run-1", kind: "moved_on", claimedName: "" });
  });

  it("returns moved_on when the sender was only skipped, never texted the offer", () => {
    // In `tried` (e.g. opted out at offer time) but not in offered_log: the
    // yank would refuse them, so the ack must not teach it.
    const r = classify([
      row({
        status: "awaiting_agent",
        routing: {
          offered: NEXT_AGENT,
          tried: [GABBY],
          offered_log: [NEXT_AGENT],
          step_index: 11
        }
      })
    ]);
    expect(r).toEqual({ runId: "run-1", kind: "moved_on", claimedName: "" });
  });

  it("returns moved_on for a '2' on a live-with-other offer (passing needs no yank hint)", () => {
    const r = classify(
      [
        row({
          status: "awaiting_agent",
          routing: {
            offered: NEXT_AGENT,
            tried: [GABBY],
            offered_log: [GABBY, NEXT_AGENT],
            step_index: 11
          }
        })
      ],
      "2"
    );
    expect(r).toEqual({ runId: "run-1", kind: "moved_on", claimedName: "" });
  });

  it("returns moved_on when the run finished unclaimed (nothing live to yank)", () => {
    const r = classify([
      row({ status: "done", routing: { offered: NEXT_AGENT, tried: [GABBY] } })
    ]);
    expect(r).toEqual({ runId: "run-1", kind: "moved_on", claimedName: "" });
  });

  it("returns claimed_by_other with the claimer's name once someone else claimed", () => {
    const r = classify([
      row({
        routing: { tried: [GABBY, NEXT_AGENT], claimed_by: DAVE, claimed_name: "Dave Lane" }
      })
    ]);
    expect(r).toEqual({ runId: "run-1", kind: "claimed_by_other", claimedName: "Dave Lane" });
  });

  it("returns claimed_by_sender for a duplicate claim digit", () => {
    const r = classify([
      row({ routing: { tried: [GABBY], claimed_by: GABBY, claimed_name: "Gabrielle Mota" } })
    ]);
    expect(r).toEqual({ runId: "run-1", kind: "claimed_by_sender", claimedName: "" });
  });

  it("matches via awaiting_agent_e164 and via routing.offered history", () => {
    const viaAwaiting = classify([
      row({ awaiting_agent_e164: GABBY, routing: { claimed_by: DAVE, claimed_name: "Dave" } })
    ]);
    expect(viaAwaiting?.kind).toBe("claimed_by_other");
    const viaOffered = classify([
      row({ routing: { offered: GABBY, claimed_by: DAVE, claimed_name: "Dave" } })
    ]);
    expect(viaOffered?.kind).toBe("claimed_by_other");
  });

  it("returns null when the sender never appeared in a recent offer", () => {
    const r = classify([
      row({ routing: { offered: NEXT_AGENT, tried: [NEXT_AGENT], claimed_by: DAVE } })
    ]);
    expect(r).toBeNull();
  });

  it("returns null for a LIVE offer to the sender (the live-claim path owns it)", () => {
    for (const status of ["awaiting_agent", "queued"]) {
      const r = classify([row({ status, routing: { offered: GABBY, tried: [] } })], "1");
      expect(r).toBeNull();
    }
  });

  it("consumes a done run's digit even when offered === sender (offer finished, not live)", () => {
    const r = classify([
      row({ status: "done", routing: { offered: GABBY, claimed_by: DAVE, claimed_name: "Dave" } })
    ]);
    expect(r?.kind).toBe("claimed_by_other");
  });

  it("returns null for any digit other than the universal 1 (claim) / 2 (pass)", () => {
    const base = row({ routing: { tried: [GABBY], claimed_by: DAVE } });
    expect(classify([base], "7")).toBeNull();
    // Legacy stamped digits no longer count as offer digits — "1"/"2" only.
    const withTf = row({ routing: { tried: [GABBY], claimed_by: DAVE, tf_digit: "3" } });
    expect(classify([withTf], "3")).toBeNull();
    const withLate = row({ routing: { tried: [GABBY], claimed_by: DAVE, late_digit: "4" } });
    expect(classify([withLate], "4")).toBeNull();
  });

  it("accepts a bare pass digit (2) the same way as a claim digit", () => {
    const r = classify(
      [row({ routing: { tried: [GABBY], claimed_by: DAVE, claimed_name: "Dave Lane" } })],
      "2"
    );
    expect(r?.kind).toBe("claimed_by_other");
  });

  it("ignores runs older than the window", () => {
    const r = classify([
      row({
        routing: { tried: [GABBY], claimed_by: DAVE },
        updated_at: new Date(NOW - DAY_MS - 60 * 1000).toISOString()
      })
    ]);
    expect(r).toBeNull();
  });

  it("ignores rows without a routing object and picks the first (newest) match", () => {
    const r = classifyStaleOfferReply({
      candidates: [
        row({ id: "no-routing", context: {} }),
        row({ id: "newest-match", routing: { tried: [GABBY], claimed_by: DAVE, claimed_name: "Dave" } }),
        row({ id: "older-match", routing: { tried: [GABBY] } })
      ],
      from: GABBY,
      digit: "1",
      nowMs: NOW,
      windowMs: DAY_MS
    });
    expect(r?.runId).toBe("newest-match");
  });
});

describe("staleOfferAckText", () => {
  it("names the claimer when known and falls back when not", () => {
    expect(
      staleOfferAckText({ runId: "r", kind: "claimed_by_other", claimedName: "Dave Lane" })
    ).toContain("Dave Lane picked it up");
    expect(
      staleOfferAckText({ runId: "r", kind: "claimed_by_other", claimedName: "" })
    ).toContain("another teammate picked it up");
  });

  it("tells a duplicate claimer the lead is already theirs (and how to release)", () => {
    const t = staleOfferAckText({ runId: "r", kind: "claimed_by_sender", claimedName: "" });
    expect(t).toContain("already got this lead");
    expect(t).toContain("86");
  });

  it("explains a moved-on lead without blaming the sender", () => {
    const t = staleOfferAckText({ runId: "r", kind: "moved_on", claimedName: "" });
    expect(t).toContain("claim window has passed");
    expect(t).toContain("next one");
  });

  it("teaches the bare-1 yank for a lead live with another teammate", () => {
    const t = staleOfferAckText({ runId: "r", kind: "live_with_other", claimedName: "" });
    expect(t).toContain("with another teammate right now");
    expect(t).toContain('reply 1 (just "1", no ETA)');
  });
});
