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
  over: Partial<LateClaimCandidate> & {
    routing?: Record<string, unknown>;
    /** Flow vars, where the lead name a named claim matches against lives. */
    vars?: Record<string, unknown>;
  }
): LateClaimCandidate {
  const { routing, vars, ...rest } = over;
  nextId += 1;
  return {
    id: `run-${nextId}`,
    status: "awaiting_agent",
    context: { routing: routing ?? {}, ...(vars ? { vars } : {}) },
    awaiting_agent_e164: null,
    current_step: 5,
    updated_at: new Date(NOW - 5 * 60 * 1000).toISOString(),
    revision: 7,
    ...rest
  };
}

/** A lapsed offer (post-route steps ran) for `lead`, claimable by `who`. */
function lapsed(lead: { name: string; phone?: string }, who = JASON): LateClaimCandidate {
  return row({
    status: "done",
    routing: { tried: [who], offered_log: [who], step_index: 5 },
    vars: { lead_name: lead.name, ...(lead.phone ? { lead_phone: lead.phone } : {}) }
  });
}

function resolve(
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

/** The matched run alone, for the precedence/eligibility assertions. */
function match(
  candidates: LateClaimCandidate[],
  opts: { from?: string; digit?: string; timeframe?: string } = {}
) {
  const r = resolve(candidates, opts);
  return r.outcome === "match" ? r.match : null;
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

describe("matchLateClaimReply, buckets", () => {
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
    // An ETA is fine on a true late claim, there's no live countdown to protect.
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

describe("matchLateClaimReply, owner_ack (finished keep-for-owner park)", () => {
  const AMY = "+16026951142";

  function finishedPark(over: Record<string, unknown> = {}): LateClaimCandidate {
    return row({
      status: "done",
      updated_at: new Date(NOW - 5 * 60 * 1000).toISOString(),
      routing: {
        owner_direct: true,
        owner_direct_done: true,
        owner_direct_e164: AMY,
        ...over
      },
      vars: { lead_name: "Robert Braid", lead_phone: "+14169378424" }
    });
  }

  it("the owner's 1 after the park finished is an ack, even with no step_index", () => {
    const park = finishedPark();
    expect(match([park], { from: AMY })).toEqual({
      kind: "owner_ack",
      row: park,
      stepIndex: -1
    });
  });

  it("beats an unrelated lapsed offer (Jason Ellis trap)", () => {
    const jason = lapsed({ name: "Jason Ellis", phone: "+15413719818" }, AMY);
    const park = finishedPark();
    const r = match([jason, park], { from: AMY });
    expect(r?.kind).toBe("owner_ack");
    expect(r?.row.id).toBe(park.id);
  });

  it("a still-open live offer still claims ahead of a finished park", () => {
    const live = row({ routing: { offered: AMY, step_index: 5 } });
    const park = finishedPark();
    expect(match([park, live], { from: AMY })?.kind).toBe("live");
  });

  it("naming a different lead still claims that lead", () => {
    const jason = lapsed({ name: "Jason Ellis", phone: "+15413719818" }, AMY);
    const park = finishedPark();
    const r = resolve([park, jason], { from: AMY, timeframe: "Jason Ellis" });
    expect(r.outcome).toBe("match");
    if (r.outcome !== "match") return;
    expect(r.match.kind).toBe("late");
    expect(r.match.row.id).toBe(jason.id);
  });

  it("naming the keep-for-owner lead is still an ack", () => {
    const jason = lapsed({ name: "Jason Ellis", phone: "+15413719818" }, AMY);
    const park = finishedPark();
    const r = resolve([jason, park], { from: AMY, timeframe: "Robert Braid" });
    expect(r.outcome).toBe("match");
    if (r.outcome !== "match") return;
    expect(r.match.kind).toBe("owner_ack");
  });

  it("within the owner_ack bucket the newest park wins", () => {
    const newer = finishedPark();
    const older = finishedPark();
    expect(match([newer, older], { from: AMY })?.row.id).toBe(newer.id);
  });

  it("a teammate's 1 never matches (owner_direct_e164 is the owner's number)", () => {
    expect(match([finishedPark()], { from: JASON })).toBeNull();
  });

  it("ignores a park older than the one-hour window", () => {
    const stale = finishedPark();
    stale.updated_at = new Date(NOW - 61 * 60 * 1000).toISOString();
    const jason = lapsed({ name: "Jason Ellis" }, AMY);
    expect(match([stale, jason], { from: AMY })?.kind).toBe("late");
  });

  it("does not match a park that is not yet done", () => {
    // Live owner-direct parks are claimed through the live path (offered =
    // the owner, step_index still set). Without those, this is not owner_ack.
    const livePark = row({
      status: "awaiting_agent",
      routing: { owner_direct: true, owner_direct_e164: AMY, offered: AMY, step_index: 16 }
    });
    expect(match([livePark], { from: AMY })?.kind).toBe("live");
  });
});

describe("matchLateClaimReply, precedence (live → owner_ack → late → yank → mine)", () => {
  it("prefers the sender's own live offer over everything else", () => {
    const mine = row({ status: "done", routing: { claimed_by: JASON } });
    const late = row({ status: "done", routing: { tried: [JASON], step_index: 5 } });
    const yank = yankableRow();
    const live = row({ routing: { offered: JASON, step_index: 5 } });
    const park = row({
      status: "done",
      routing: { owner_direct: true, owner_direct_done: true, owner_direct_e164: JASON }
    });
    const r = match([mine, late, yank, park, live]);
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

  it("prefers a finished owner-direct ack over a late claim", () => {
    const late = row({ status: "done", routing: { tried: [JASON], step_index: 5 } });
    const park = row({
      status: "done",
      routing: {
        owner_direct: true,
        owner_direct_done: true,
        owner_direct_e164: JASON
      }
    });
    expect(match([late, park])?.kind).toBe("owner_ack");
  });

  it("within a bucket the newest candidate wins (candidates are newest-first)", () => {
    const newer = row({ status: "done", routing: { tried: [JASON], step_index: 5 } });
    const older = row({ status: "done", routing: { tried: [JASON], step_index: 5 } });
    expect(match([newer, older])?.row.id).toBe(newer.id);
  });
});

describe("matchLateClaimReply, eligibility rules", () => {
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

describe("matchLateClaimReply, scan mechanics", () => {
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

describe("matchLateClaimReply, first-to-claim yank rules", () => {
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

describe("matchLateClaimReply, a NAMED claim after the offer lapsed", () => {
  /**
   * The Amy Laidlaw incident of 2026-08-17. Dave was offered Aurora Anthony at
   * 10:43 and the run completed unclaimed at 10:54. A different lead's run
   * (Jennifer Kline) then woke from a sleep step at 12:25, which made it the
   * most recently TOUCHED routed run. At 13:49 Dave replied "1, Aurora
   * Anthony" and was given Jennifer Kline, whose owner notice then read
   * "ETA to contact lead: Aurora Anthony".
   */
  it("takes the lead the sender NAMED, not the most recently touched run", () => {
    const jennifer = lapsed({ name: "Jennifer Kline", phone: "+16025711370" }, DAVE);
    const aurora = row({
      status: "done",
      routing: { tried: [DAVE], offered_log: [DAVE], step_index: 5 },
      vars: { lead_name: "Aurora Anthony", lead_phone: "+16029200022" },
      // Older than Jennifer's, so recency alone would lose.
      updated_at: new Date(NOW - 3 * 60 * 60 * 1000).toISOString()
    });
    const r = resolve([jennifer, aurora], { from: DAVE, timeframe: "Aurora Anthony" });
    expect(r.outcome).toBe("match");
    if (r.outcome !== "match") return;
    expect(r.match.row.id).toBe(aurora.id);
    expect(r.match.kind).toBe("late");
    // The text was a name, so the caller must not stamp it as an ETA.
    expect(r.match.namedLabel).toBe("Aurora Anthony");
    // Two leads were in play, so confirm which one they got.
    expect(r.ackLabel).toBe("Aurora Anthony");
  });

  it("matches a first name or a surname, folding accents", () => {
    const a = lapsed({ name: "Aurora Anthony", phone: "+16029200022" });
    const b = lapsed({ name: "Jennifer Kline", phone: "+16025711370" });
    expect(match([a, b], { timeframe: "aurora" })?.row.id).toBe(a.id);
    expect(match([a, b], { timeframe: "Kline" })?.row.id).toBe(b.id);
    const munoz = lapsed({ name: "Sofía Muñoz", phone: "+16025550101" });
    expect(match([munoz, b], { timeframe: "Munoz" })?.row.id).toBe(munoz.id);
  });

  it("asks when the text names two DIFFERENT leads", () => {
    const one = lapsed({ name: "Daniel Villanueva", phone: "+16025550111" });
    const two = lapsed({ name: "Daniela Reyes", phone: "+16025550222" });
    const r = resolve([one, two], { timeframe: "dani" });
    expect(r.outcome).toBe("ambiguous");
    if (r.outcome !== "ambiguous") return;
    expect(r.labels).toEqual(["Daniel Villanueva", "Daniela Reyes"]);
  });

  it("disambiguates two same-named leads by phone rather than repeating itself", () => {
    const one = lapsed({ name: "Daniel Villanueva", phone: "+16025550111" });
    const two = lapsed({ name: "Daniel Villanueva", phone: "+16025552222" });
    const r = resolve([one, two], { timeframe: "Daniel Villanueva" });
    expect(r.outcome).toBe("ambiguous");
    if (r.outcome !== "ambiguous") return;
    expect(r.labels).toEqual(["Daniel Villanueva (...0111)", "Daniel Villanueva (...2222)"]);
  });

  it("collapses several runs about the SAME lead instead of asking an unanswerable question", () => {
    // Amy's networks chain flows per lead, so one lead owns two or three
    // routed runs. The better bucket wins; nothing is asked.
    const filing = lapsed({ name: "Aurora Anthony", phone: "+16029200022" });
    const live = row({
      routing: { offered: JASON, offered_log: [JASON], step_index: 5 },
      vars: { lead_name: "Aurora Anthony", lead_phone: "+16029200022" }
    });
    const r = resolve([filing, live], { timeframe: "Aurora" });
    expect(r.outcome).toBe("match");
    if (r.outcome !== "match") return;
    expect(r.match.row.id).toBe(live.id);
    expect(r.match.kind).toBe("live");
    // One lead was in play, so no confirmation text.
    expect(r.ackLabel).toBeUndefined();
  });

  it("leaves an ETA reply exactly as it was: no name, no namedLabel", () => {
    const named = lapsed({ name: "Aurora Anthony", phone: "+16029200022" });
    const r = resolve([named], { timeframe: "20 min" });
    expect(r.outcome).toBe("match");
    if (r.outcome !== "match") return;
    expect(r.match.row.id).toBe(named.id);
    expect(r.match.namedLabel).toBeUndefined();
    expect(r.ackLabel).toBeUndefined();
  });

  it("never CLAIMS a lead the sender cannot have, and says who took it", () => {
    // Claimed by someone else, and a lead this sender was never offered.
    const taken = row({
      status: "done",
      routing: { tried: [JASON], claimed_by: DAVE, claimed_name: "Dave Lane", step_index: 5 },
      vars: { lead_name: "Aurora Anthony" }
    });
    const strangers = row({
      status: "done",
      routing: { tried: [GABBY], offered_log: [GABBY], step_index: 5 },
      vars: { lead_name: "Aurora Anthony" }
    });
    const r = resolve([taken, strangers], { timeframe: "Aurora" });
    // Not a match: nothing is claimed. Not "none" either, because we know
    // exactly what happened and can say it.
    expect(r.outcome).toBe("unmatched");
    if (r.outcome !== "unmatched") return;
    expect(r.labels).toEqual([]);
    expect(r.claimedElsewhere).toEqual({ label: "Aurora Anthony", claimedName: "Dave Lane" });
  });

  it("re-acks by name when the sender already holds that lead", () => {
    const mine = row({
      status: "done",
      routing: { claimed_by: JASON },
      vars: { lead_name: "Aurora Anthony" }
    });
    const other = lapsed({ name: "Jennifer Kline", phone: "+16025711370" });
    const r = resolve([other, mine], { timeframe: "Aurora" });
    expect(r.outcome).toBe("match");
    if (r.outcome !== "match") return;
    expect(r.match).toEqual({
      kind: "mine",
      row: mine,
      stepIndex: -1,
      namedLabel: "Aurora Anthony"
    });
  });

  it("lets a NAMED reply yank, because a name is not an ETA", () => {
    // The bare-"1"-only rule exists to stop "1, a few hours" from preempting
    // another teammate's countdown. Naming the lead says the opposite.
    const r = row({
      routing: { offered: GABBY, tried: [JASON], offered_log: [JASON, GABBY], step_index: 5 },
      vars: { lead_name: "Aurora Anthony" }
    });
    expect(match([r], { timeframe: "a few hours" })).toBeNull();
    const named = resolve([r], { timeframe: "Aurora" });
    expect(named.outcome).toBe("match");
    if (named.outcome !== "match") return;
    expect(named.match.kind).toBe("yank");
    expect(named.match.namedLabel).toBe("Aurora Anthony");
  });

  it("still refuses a named yank when the flow opted out of first-to-claim", () => {
    const r = row({
      routing: {
        offered: GABBY,
        tried: [JASON],
        offered_log: [JASON, GABBY],
        step_index: 5,
        first_to_claim: false
      },
      vars: { lead_name: "Aurora Anthony" }
    });
    expect(resolve([r], { timeframe: "Aurora" }).outcome).toBe("none");
  });

  it("ignores a name on any digit other than 1", () => {
    const named = lapsed({ name: "Aurora Anthony" });
    expect(resolve([named], { digit: "2", timeframe: "Aurora" }).outcome).toBe("none");
  });

  it("collapses one lead's runs even when only some of them captured a phone", () => {
    // The flows in a chain do not all capture a phone (the no-phone guard path
    // leaves lead_phone empty or "none"), so keying on name+phone would split
    // one lead across two entries and ask "Aurora Anthony (...0022) or Aurora
    // Anthony?", the exact question this collapse exists to prevent.
    const withPhone = row({
      status: "done",
      routing: { tried: [JASON], offered_log: [JASON], step_index: 5 },
      vars: { lead_name: "Aurora Anthony", lead_phone: "+16029200022" }
    });
    const withoutPhone = row({
      status: "done",
      routing: { tried: [JASON], offered_log: [JASON], step_index: 5 },
      vars: { lead_name: "Aurora Anthony", lead_phone: "none" },
      updated_at: new Date(NOW - 60 * 60 * 1000).toISOString()
    });
    const r = resolve([withPhone, withoutPhone], { timeframe: "Aurora" });
    expect(r.outcome).toBe("match");
    if (r.outcome !== "match") return;
    expect(r.match.row.id).toBe(withPhone.id);
    // One lead in play once collapsed, so no confirmation text.
    expect(r.ackLabel).toBeUndefined();
  });

  it("splits a name across two real people, and keeps an unphoned run as its own answer", () => {
    // Two distinct phones under one name means these are different people, so
    // the phone splits them; a run with no phone could be either, and guessing
    // is the failure being avoided.
    const first = lapsed({ name: "Daniel Villanueva", phone: "+16025550111" });
    // A second run about that same Daniel: it collapses into his one entry.
    const firstAgain = lapsed({ name: "Daniel Villanueva", phone: "+16025550111" });
    const second = lapsed({ name: "Daniel Villanueva", phone: "+16025552222" });
    const unphoned = lapsed({ name: "Daniel Villanueva" });
    const r = resolve([first, firstAgain, second, unphoned], { timeframe: "Daniel" });
    expect(r.outcome).toBe("ambiguous");
    if (r.outcome !== "ambiguous") return;
    expect(r.labels).toEqual([
      "Daniel Villanueva (...0111)",
      "Daniel Villanueva (...2222)",
      "Daniel Villanueva"
    ]);
  });

  it("merges two same-named leads with no phone rather than asking an impossible question", () => {
    // Nothing to disambiguate with: "Thomas L. or Thomas L.?" cannot be
    // answered, so the best bucket wins and the ack names what was taken.
    const older = row({
      status: "done",
      routing: { tried: [JASON], offered_log: [JASON], step_index: 5 },
      vars: { lead_name: "Thomas L.", lead_phone: "none" },
      updated_at: new Date(NOW - 60 * 60 * 1000).toISOString()
    });
    const newer = row({
      status: "done",
      routing: { tried: [JASON], offered_log: [JASON], step_index: 5 },
      vars: { lead_name: "Thomas L.", lead_phone: "none" }
    });
    const r = resolve([newer, older], { timeframe: "Thomas" });
    expect(r.outcome).toBe("match");
    if (r.outcome !== "match") return;
    expect(r.match.row.id).toBe(newer.id);
    expect(r.match.namedLabel).toBe("Thomas L.");
  });

  it("does not merge two unnamed runs into one lead", () => {
    // Both have no lead name, so neither can answer to a name; the reply
    // falls through to precedence and keeps the newest.
    const newer = row({ status: "done", routing: { tried: [JASON], step_index: 5 } });
    const older = row({
      status: "done",
      routing: { tried: [JASON], step_index: 5 },
      updated_at: new Date(NOW - 60 * 60 * 1000).toISOString()
    });
    expect(match([newer, older], { timeframe: "Aurora" })?.row.id).toBe(newer.id);
  });
});

describe("matchLateClaimReply, a name that matches NOTHING", () => {
  /**
   * The Amy Laidlaw incident of 2026-08-23/24, and the reason this outcome
   * exists at all. Jason was offered Sandy Baldwin at 08:34 and reminded at
   * 09:07 with copy that said, literally, 'Reply "1, Sandy" to claim this
   * one'. Gabrielle claimed Sandy at 09:12. At 09:17 Jason replied "1,Sandy".
   *
   * The old code found no live "Sandy", read the word as an ETA, and claimed
   * his only other open offer: a Clever spoke check on Isiah Perez, a lead he
   * had never spoken to. Amy was texted "Jason Lane confirmed they spoke with
   * the Clever lead Isiah Perez ... ETA to contact lead: Sandy", the weekly
   * AI call ladder was cancelled as handled, and Jason was told nothing.
   */
  it("does not claim a different lead when the named one was taken first", () => {
    const sandy = row({
      status: "done",
      routing: {
        tried: [JASON],
        offered_log: [JASON, GABBY],
        claimed_by: GABBY,
        claimed_name: "Gabrielle Mota",
        step_index: 5
      },
      vars: { lead_name: "Sandy Baldwin", lead_phone: "+13202931236" }
    });
    const isiah = row({
      routing: { offered: JASON, offered_log: [JASON], step_index: 5 },
      vars: { lead_name: "Isiah Perez", lead_phone: "+16232622189" }
    });
    const r = resolve([sandy, isiah], { timeframe: "Sandy" });
    expect(r.outcome).toBe("unmatched");
    if (r.outcome !== "unmatched") return;
    expect(r.query).toBe("Sandy");
    // Isiah is still his to take, so the ask-back can offer it by name.
    expect(r.labels).toEqual(["Isiah Perez"]);
    expect(r.claimedElsewhere).toEqual({
      label: "Sandy Baldwin",
      claimedName: "Gabrielle Mota"
    });
  });

  it("still stamps a real ETA that happens to match no lead", () => {
    const isiah = row({
      routing: { offered: JASON, offered_log: [JASON], step_index: 5 },
      vars: { lead_name: "Isiah Perez" }
    });
    for (const eta of ["20 min", "2 hours", "tonight", "tomorrow morning", "asap", "on my way"]) {
      const r = resolve([isiah], { timeframe: eta });
      expect(r.outcome, eta).toBe("match");
      if (r.outcome !== "match") continue;
      expect(r.match.namedLabel, eta).toBeUndefined();
    }
  });

  it("falls through to the stale-offer ack when there is nothing to say", () => {
    // No claimable lead, and no recently claimed lead answering to the name:
    // the stale-offer classifier downstream is the better answer.
    const strangers = row({
      status: "done",
      routing: { tried: [GABBY], offered_log: [GABBY], step_index: 5 },
      vars: { lead_name: "Jennifer Kline" }
    });
    expect(resolve([strangers], { timeframe: "Sandy" }).outcome).toBe("none");
  });

  it("lists a nameless lead alongside a named one it could not match", () => {
    const isiah = row({
      routing: { offered: JASON, offered_log: [JASON], step_index: 5 },
      vars: { lead_name: "Isiah Perez" }
    });
    const unnamed = row({
      status: "done",
      routing: { tried: [JASON], offered_log: [JASON], step_index: 5 },
      vars: { lead_phone: "+16232622189" }
    });
    const r = resolve([isiah, unnamed], { timeframe: "Sandy" });
    expect(r.outcome).toBe("unmatched");
    if (r.outcome !== "unmatched") return;
    expect(r.labels).toEqual(["Isiah Perez", "lead 2 (no name on file)"]);
  });

  it("keeps precedence when NO candidate has a name to have mismatched", () => {
    // Nothing on file to compare against, so "1, Aurora" tells us nothing we
    // can act on and the old behavior is as good as any. Refusing here would
    // strand the teammate: they cannot name a lead that has no name.
    const newer = row({ status: "done", routing: { tried: [JASON], step_index: 5 } });
    const older = row({
      status: "done",
      routing: { tried: [JASON], step_index: 5 },
      updated_at: new Date(NOW - 60 * 60 * 1000).toISOString()
    });
    expect(match([newer, older], { timeframe: "Aurora" })?.row.id).toBe(newer.id);
  });

  it("stays generic when the name fits two leads other people took", () => {
    const one = row({
      status: "done",
      routing: { tried: [JASON], claimed_by: GABBY, claimed_name: "Gabrielle Mota", step_index: 5 },
      vars: { lead_name: "Sandy Baldwin", lead_phone: "+16025550111" }
    });
    const two = row({
      status: "done",
      routing: { tried: [JASON], claimed_by: DAVE, claimed_name: "Dave Lane", step_index: 5 },
      vars: { lead_name: "Sandy Cruz", lead_phone: "+16025550222" }
    });
    const live = row({
      routing: { offered: JASON, offered_log: [JASON], step_index: 5 },
      vars: { lead_name: "Isiah Perez" }
    });
    const r = resolve([one, two, live], { timeframe: "Sandy" });
    expect(r.outcome).toBe("unmatched");
    if (r.outcome !== "unmatched") return;
    expect(r.claimedElsewhere).toBeUndefined();
  });

  it("ignores a claim older than the window when explaining", () => {
    const stale = row({
      status: "done",
      routing: { tried: [JASON], claimed_by: GABBY, claimed_name: "Gabrielle Mota", step_index: 5 },
      vars: { lead_name: "Sandy Baldwin" },
      updated_at: new Date(NOW - 3 * DAY_MS).toISOString()
    });
    const live = row({
      routing: { offered: JASON, offered_log: [JASON], step_index: 5 },
      vars: { lead_name: "Isiah Perez" }
    });
    const r = resolve([stale, live], { timeframe: "Sandy" });
    expect(r.outcome).toBe("unmatched");
    if (r.outcome !== "unmatched") return;
    expect(r.claimedElsewhere).toBeUndefined();
  });

  it("does not offer back a lead the SENDER already holds", () => {
    // Their own claimed lead is not something to "take", so it is neither an
    // explanation nor an ask-back option. With nothing else in play the reply
    // keeps its old meaning: the idempotent "it is already yours" re-ack.
    // Nothing is newly claimed either way, which is the property that matters.
    const mine = row({
      status: "done",
      routing: { claimed_by: JASON, claimed_name: "Jason Lane", step_index: 5 },
      vars: { lead_name: "Sandy Baldwin" }
    });
    const r = resolve([mine], { timeframe: "Nancy" });
    expect(r.outcome).toBe("match");
    if (r.outcome !== "match") return;
    expect(r.match.kind).toBe("mine");
  });

  it("explains even when the claimer has no roster name recorded", () => {
    const taken = row({
      status: "done",
      // No claimed_name: the older claim path did not always record one.
      routing: { tried: [JASON], claimed_by: DAVE, step_index: 5 },
      vars: { lead_name: "Sandy Baldwin" }
    });
    const nameless = row({
      status: "done",
      // No vars at all, so no label to match: must not throw or match.
      routing: { tried: [JASON], claimed_by: GABBY, step_index: 5 }
    });
    const isiah = row({
      routing: { offered: JASON, offered_log: [JASON], step_index: 5 },
      vars: { lead_name: "Isiah Perez" }
    });
    const r = resolve([taken, nameless, isiah], { timeframe: "Sandy" });
    expect(r.outcome).toBe("unmatched");
    if (r.outcome !== "unmatched") return;
    expect(r.claimedElsewhere).toEqual({ label: "Sandy Baldwin", claimedName: "" });
  });

  it("still explains when the taken lead owns SEVERAL routed runs", () => {
    // Amy's networks chain flows per lead (the filing run, the reply-reaction
    // run, the follow-up run), so one lead routinely carries two or three
    // routed runs. Uncollapsed they read as two leads fitting the name, and
    // the explanation goes silent exactly when it is most useful.
    const filing = row({
      status: "done",
      routing: {
        tried: [JASON],
        claimed_by: GABBY,
        claimed_name: "Gabrielle Mota",
        step_index: 5
      },
      vars: { lead_name: "Sandy Baldwin", lead_phone: "+13202931236" }
    });
    const followUp = row({
      status: "done",
      routing: {
        tried: [JASON],
        claimed_by: GABBY,
        claimed_name: "Gabrielle Mota",
        step_index: 9
      },
      vars: { lead_name: "Sandy Baldwin", lead_phone: "+13202931236" },
      updated_at: new Date(NOW - 30 * 60 * 1000).toISOString()
    });
    const isiah = row({
      routing: { offered: JASON, offered_log: [JASON], step_index: 5 },
      vars: { lead_name: "Isiah Perez" }
    });
    const r = resolve([filing, followUp, isiah], { timeframe: "Sandy" });
    expect(r.outcome).toBe("unmatched");
    if (r.outcome !== "unmatched") return;
    expect(r.claimedElsewhere).toEqual({
      label: "Sandy Baldwin",
      claimedName: "Gabrielle Mota"
    });
  });

  it("skips a candidate row carrying no routing at all", () => {
    const noRouting = row({ status: "done", vars: { lead_name: "Sandy Baldwin" } });
    (noRouting.context as Record<string, unknown>).routing = null;
    const live = row({
      routing: { offered: JASON, offered_log: [JASON], step_index: 5 },
      vars: { lead_name: "Isiah Perez" }
    });
    const r = resolve([noRouting, live], { timeframe: "Sandy" });
    expect(r.outcome).toBe("unmatched");
    if (r.outcome !== "unmatched") return;
    expect(r.claimedElsewhere).toBeUndefined();
  });
});
