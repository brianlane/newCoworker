import { describe, expect, it } from "vitest";
import {
  matchLateClaimReply,
  type LateClaimCandidate
} from "../supabase/functions/_shared/ai_flows/late_claim";

const JASON = "+15550001111";
const GABBY = "+15550002222";
const DAVE = "+15550003333";

const NOW = Date.parse("2026-07-06T20:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

let nextId = 0;
function row(
  over: Partial<LateClaimCandidate> & { routing?: Record<string, unknown> }
): LateClaimCandidate {
  const { routing, ...rest } = over;
  nextId += 1;
  return {
    id: `run-${nextId}`,
    status: "awaiting_agent",
    context: { routing: routing ?? {} },
    awaiting_agent_e164: null,
    current_step: 5,
    updated_at: new Date(NOW - 5 * 60 * 1000).toISOString(),
    revision: 7,
    ...rest
  };
}

function match(
  candidates: LateClaimCandidate[],
  opts: { from?: string; digit?: string; timeframe?: string } = {}
) {
  return matchLateClaimReply({
    candidates,
    from: opts.from ?? JASON,
    digit: opts.digit ?? "1",
    timeframe: opts.timeframe ?? "",
    nowMs: NOW,
    windowMs: DAY_MS
  });
}

/** A live offer to GABBY that JASON (in offered_log + tried) could yank. */
function yankableRow(extraRouting: Record<string, unknown> = {}): LateClaimCandidate {
  return row({
    routing: {
      offered: GABBY,
      tried: [JASON],
      offered_log: [JASON, GABBY],
      step_index: 5,
      ...extraRouting
    }
  });
}

describe("matchLateClaimReply — buckets", () => {
  it("live: the sender's own active offer matches (bare or with ETA)", () => {
    const live = row({ routing: { offered: JASON, step_index: 5 } });
    expect(match([live])).toEqual({ kind: "live", row: live, stepIndex: 5 });
    expect(match([live], { timeframe: "20 min" })).toEqual({
      kind: "live",
      row: live,
      stepIndex: 5
    });
  });

  it("late: a lapsed offer whose post-route steps ran (done or advanced) matches anyone ever offered", () => {
    const done = row({ status: "done", routing: { tried: [JASON], step_index: 5 } });
    expect(match([done])?.kind).toBe("late");
    const advanced = row({
      status: "awaiting_approval",
      current_step: 9,
      routing: { tried: [JASON], step_index: 5 }
    });
    expect(match([advanced])?.kind).toBe("late");
    // An ETA is fine on a true late claim — there's no live countdown to protect.
    expect(match([done], { timeframe: "2 hours" })?.kind).toBe("late");
  });

  it("yank: bare '1' takes over an offer live with another teammate", () => {
    const r = yankableRow();
    expect(match([r])).toEqual({ kind: "yank", row: r, stepIndex: 5 });
  });

  it("mine: a lead already claimed by the sender re-acks without a step_index", () => {
    const mine = row({ status: "done", routing: { claimed_by: JASON } });
    expect(match([mine])).toEqual({ kind: "mine", row: mine, stepIndex: -1 });
  });
});

describe("matchLateClaimReply — precedence (live → late → yank → mine)", () => {
  it("prefers the sender's own live offer over everything else", () => {
    const mine = row({ status: "done", routing: { claimed_by: JASON } });
    const late = row({ status: "done", routing: { tried: [JASON], step_index: 5 } });
    const yank = yankableRow();
    const live = row({ routing: { offered: JASON, step_index: 5 } });
    const r = match([mine, late, yank, live]);
    expect(r?.kind).toBe("live");
    expect(r?.row.id).toBe(live.id);
  });

  it("prefers a true late claim over a yank and a re-ack", () => {
    const mine = row({ status: "done", routing: { claimed_by: JASON } });
    const yank = yankableRow();
    const late = row({ status: "done", routing: { tried: [JASON], step_index: 5 } });
    expect(match([mine, yank, late])?.kind).toBe("late");
  });

  it("prefers a yank over the idempotent re-ack", () => {
    const mine = row({ status: "done", routing: { claimed_by: JASON } });
    const yank = yankableRow();
    expect(match([mine, yank])?.kind).toBe("yank");
  });

  it("within a bucket the newest candidate wins (candidates are newest-first)", () => {
    const newer = row({ status: "done", routing: { tried: [JASON], step_index: 5 } });
    const older = row({ status: "done", routing: { tried: [JASON], step_index: 5 } });
    expect(match([newer, older])?.row.id).toBe(newer.id);
  });
});

describe("matchLateClaimReply — eligibility rules", () => {
  it("only digit '1' ever matches", () => {
    const live = row({ routing: { offered: JASON, step_index: 5 } });
    expect(match([live], { digit: "2" })).toBeNull();
    expect(match([live], { digit: "4" })).toBeNull();
  });

  it("a run claimed by someone else never matches", () => {
    const claimed = row({
      status: "done",
      routing: { tried: [JASON], claimed_by: DAVE, step_index: 5 }
    });
    expect(match([claimed])).toBeNull();
  });

  it("a fresh claim requires the worker's step_index rewind stamp", () => {
    const noStamp = row({ status: "done", routing: { tried: [JASON] } });
    expect(match([noStamp])).toBeNull();
  });

  it("ignores candidates outside the window and without routing", () => {
    const stale = row({
      status: "done",
      routing: { tried: [JASON], step_index: 5 },
      updated_at: new Date(NOW - DAY_MS - 60_000).toISOString()
    });
    const noRouting = row({ context: {} });
    expect(match([stale, noRouting])).toBeNull();
  });

  it("requires the sender to have been offered the lead (offered / awaiting / tried)", () => {
    const stranger = row({ status: "done", routing: { tried: [GABBY], step_index: 5 } });
    expect(match([stranger])).toBeNull();
    const viaAwaiting = row({
      status: "done",
      awaiting_agent_e164: JASON,
      routing: { step_index: 5 }
    });
    expect(match([viaAwaiting])?.kind).toBe("late");
  });
});

describe("matchLateClaimReply — scan mechanics", () => {
  it("stops scanning once all four buckets are filled and keeps the newest of each", () => {
    // Duplicates of already-filled buckets appear BEFORE the last bucket fills
    // (so they're actually scanned and ignored); the trailing row after all
    // four are filled exercises the early break.
    const live = row({ routing: { offered: JASON, step_index: 5 } });
    const live2 = row({ routing: { offered: JASON, step_index: 6 } });
    const mine = row({ status: "done", routing: { claimed_by: JASON } });
    const mine2 = row({ status: "done", routing: { claimed_by: JASON } });
    const late = row({ status: "done", routing: { tried: [JASON], step_index: 5 } });
    const late2 = row({ status: "done", routing: { tried: [JASON], step_index: 6 } });
    const yank = yankableRow();
    const afterBreak = row({ routing: { offered: JASON, step_index: 9 } });
    const r = match([live, live2, mine, mine2, late, late2, yank, afterBreak]);
    expect(r).toEqual({ kind: "live", row: live, stepIndex: 5 });
  });

  it("defaults a null current_step to the route step (no post-route inference)", () => {
    const r = row({ current_step: null, routing: { offered: JASON, step_index: 5 } });
    expect(match([r])?.kind).toBe("live");
  });

  it("treats a missing offered_log as empty (no yank rights)", () => {
    const noLog = row({ routing: { offered: GABBY, tried: [JASON], step_index: 5 } });
    expect(match([noLog])).toBeNull();
  });
});

describe("matchLateClaimReply — first-to-claim yank rules", () => {
  it("refuses a yank with an ETA ('1, a few hours' must not preempt the countdown)", () => {
    expect(match([yankableRow()], { timeframe: "a few hours" })).toBeNull();
  });

  it("refuses a yank for a sender who was only skipped (in tried, not offered_log)", () => {
    const skippedOnly = row({
      routing: { offered: GABBY, tried: [JASON], offered_log: [GABBY], step_index: 5 }
    });
    expect(match([skippedOnly])).toBeNull();
  });

  it("refuses a yank when the flow opted out of first-to-claim", () => {
    expect(match([yankableRow({ first_to_claim: false })])).toBeNull();
  });

  it("never lets the currently offered teammate 'yank' their own offer (it's a live claim)", () => {
    const r = yankableRow();
    expect(match([r], { from: GABBY })?.kind).toBe("live");
  });
});
