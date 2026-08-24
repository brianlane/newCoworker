import { describe, expect, it } from "vitest";
import { evaluateStepCondition } from "../../supabase/functions/_shared/ai_flows/engine";
import {
  looksLikeTimeframe,
  parseClaimWithTimeframe
} from "../../supabase/functions/_shared/ai_flows/claim_timeframe";
import {
  matchOfferByLeadName,
  unmatchedClaimText,
  leadLabelFromVars,
  type OfferCandidate
} from "../../supabase/functions/_shared/ai_flows/offer_identity";
import {
  matchLateClaimReply,
  type LateClaimCandidate
} from "../../supabase/functions/_shared/ai_flows/late_claim";

/**
 * End to end over the REAL reply-routing chain, replaying the Amy Laidlaw
 * incident of 2026-08-23/24 from the raw SMS body a teammate sent through to
 * the two things it decides: what the teammate is told, and whether the lead's
 * AI follow-up survives.
 *
 * What happened. Jason was texted a new buyer lead, Sandy Baldwin, at 08:34
 * Phoenix, and reminded at 09:07 with copy that read, literally,
 * 'Reply "1, Sandy" to claim this one'. Gabrielle claimed Sandy at 09:12. At
 * 09:17 Jason replied "1,Sandy", five minutes late.
 *
 * No live lead answered to "Sandy" any more, so the router read the word as a
 * claim ETA and claimed his only OTHER open offer instead: a Clever spoke
 * check on Isiah Perez. Jason was told nothing. The next morning Amy was
 * texted "Jason Lane confirmed they spoke with the Clever lead Isiah Perez
 * ... ETA to contact lead: Sandy", and because `claimed_agent` was now set,
 * every weekly AI call rung gated on `claimed_agent == "none"` was skipped and
 * the run completed. Isiah, a $425,000 seller, was marked handled by a
 * conversation that never happened.
 *
 * Three more replies went the same way between Aug 17 and Aug 24 (Gabrielle's
 * "1, Jennifer", "1, Michael" and "1, Nancy"), so this walks the whole chain
 * rather than any one layer: parse → live-offer name match → the timeframe
 * guard → the late-claim scan → the copy → the follow-up gate.
 *
 * Deliberately model-free. Every decision here is deterministic, and the bug
 * was never in a model: it was in reading a person's name as a duration.
 */

const JASON = "+14807039575";
const GABBY = "+14807202013";
const DAVE = "+16025245719";

const NOW = Date.parse("2026-08-23T16:17:20Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** A parked run row, the shape both candidate scans actually read. */
function run(over: {
  id: string;
  status?: string;
  routing: Record<string, unknown>;
  vars: Record<string, unknown>;
  minutesAgo?: number;
}): LateClaimCandidate {
  return {
    id: over.id,
    status: over.status ?? "awaiting_agent",
    context: { routing: over.routing, vars: over.vars },
    awaiting_agent_e164: null,
    current_step: 4,
    updated_at: new Date(NOW - (over.minutesAgo ?? 5) * 60_000).toISOString(),
    revision: 7
  };
}

/** Isiah Perez: Jason's live Clever spoke check, run 8ae269b2. */
const ISIAH = run({
  id: "isiah",
  routing: { offered: JASON, offered_name: "Jason Lane", offered_log: [JASON], step_index: 4 },
  vars: {
    lead_name: "Isiah Perez",
    lead_phone: "+16232622189",
    price: "$425,000",
    claimed_agent: "none"
  },
  minutesAgo: 1093
});

/** Sandy Baldwin: the lead Jason meant, claimed by Gabrielle five minutes earlier. */
const SANDY = run({
  id: "sandy",
  status: "done",
  routing: {
    tried: [JASON, DAVE, GABBY],
    offered_log: [JASON, DAVE, GABBY],
    claimed_by: GABBY,
    claimed_name: "Gabrielle Mota",
    step_index: 16
  },
  vars: { lead_name: "Sandy Baldwin", lead_phone: "+13202931236", price: "$825K" },
  minutesAgo: 5
});

/**
 * The webhook's live-offer leg: does the comma'd text name one of the leads
 * this teammate is holding right now? Mirrors the entrypoint's own ordering,
 * name match first, timeframe reading only when nothing fits.
 */
function liveLegClaims(candidates: OfferCandidate[], typed: string): boolean {
  const match = matchOfferByLeadName(candidates, typed);
  if (match.kind === "one") return true;
  if (match.kind === "ambiguous") return false;
  // The guard this whole change turns on: an unmatched NAME must not be
  // stamped as an ETA and claim whatever was touched most recently.
  return looksLikeTimeframe(typed);
}

describe("a teammate names a lead that was already taken", () => {
  const body = "1,Sandy";

  it("parses as a claim carrying the lead's name, not an ETA", () => {
    expect(parseClaimWithTimeframe(body)).toEqual({ digit: "1", timeframe: "Sandy" });
    expect(looksLikeTimeframe("Sandy")).toBe(false);
  });

  it("refuses to claim the unrelated lead the reply would have taken", () => {
    const typed = parseClaimWithTimeframe(body)!.timeframe;
    // Jason's only live offer is Isiah. Recency alone would have handed it over.
    const live: OfferCandidate[] = [
      { runId: ISIAH.id, leadLabel: "Isiah Perez", leadPhone: "+16232622189" }
    ];
    expect(liveLegClaims(live, typed)).toBe(false);
  });

  it("tells Jason who took Sandy, and what he still has", () => {
    const typed = parseClaimWithTimeframe(body)!.timeframe;
    const resolved = matchLateClaimReply({
      candidates: [SANDY, ISIAH],
      from: JASON,
      digit: "1",
      timeframe: typed,
      nowMs: NOW,
      windowMs: DAY_MS
    });
    expect(resolved.outcome).toBe("unmatched");
    if (resolved.outcome !== "unmatched") return;

    const text = unmatchedClaimText(
      resolved.query,
      resolved.labels,
      resolved.claimedElsewhere
    );
    // Lexical facts, asserted lexically: the sender must learn who has Sandy
    // and that Isiah is still open.
    expect(text).toMatch(/Sandy Baldwin was already claimed by Gabrielle Mota/);
    expect(text).toMatch(/Isiah Perez/);
    // And it must never read as a confirmation, which is the whole failure.
    expect(text).not.toMatch(/is yours|confirmed|you've got/i);
  });

  it("leaves Isiah's AI follow-up ladder armed", () => {
    // The real gate on every weekly call rung in the live Clever spoke check.
    const gate = { var: "claimed_agent", equals: "none" } as const;
    const vars = ISIAH.context!.vars as Record<string, unknown>;
    expect(evaluateStepCondition(gate, { vars })).toBe(true);

    // What the bug produced instead: claimed_agent set to a teammate who never
    // spoke to anyone, which closed the same gate and cancelled the ladder.
    expect(evaluateStepCondition(gate, { vars: { claimed_agent: "Jason Lane" } })).toBe(false);
  });
});

describe("a teammate names a lead they really do hold", () => {
  /**
   * Gabrielle's "1, Nancy" of 2026-08-24. Nancy was live with her, but the
   * HomeLight Referral flow stores the lead's name in `lead_first_name`, which
   * was not a name var the matcher knew, so the lead had no label, could not
   * be named, and her correctly typed reply claimed Linda Elenes instead.
   */
  const NANCY = run({
    id: "nancy",
    routing: { offered_all: [GABBY, DAVE], offered_log: [GABBY, DAVE], step_index: 9 },
    vars: { lead_first_name: "Nancy", lead_type: "seller", lead_address: "85205, AZ" }
  });
  const LINDA = run({
    id: "linda",
    routing: { offered_all: [GABBY], offered_log: [GABBY], step_index: 4 },
    vars: { lead_name: "Linda Elenes", lead_phone: "+19098450027" },
    minutesAgo: 1
  });

  it("labels a first-name-only lead so it can be named at all", () => {
    expect(leadLabelFromVars(NANCY.context!.vars as Record<string, unknown>)).toBe("Nancy");
  });

  it("claims Nancy, not the more recently touched Linda", () => {
    const resolved = matchLateClaimReply({
      candidates: [LINDA, NANCY],
      from: GABBY,
      digit: "1",
      timeframe: "Nancy",
      nowMs: NOW,
      windowMs: DAY_MS
    });
    expect(resolved.outcome).toBe("match");
    if (resolved.outcome !== "match") return;
    expect(resolved.match.row.id).toBe(NANCY.id);
    // A name, so it must not ride along to the owner as "ETA: Nancy".
    expect(resolved.match.namedLabel).toBe("Nancy");
  });
});

describe("an ordinary claim still works exactly as it did", () => {
  it("stamps a real ETA and claims the live offer", () => {
    for (const body of ["1, 20 min", "1, 2 hours", "1, tonight", "1, on my way"]) {
      const parsed = parseClaimWithTimeframe(body)!;
      const live: OfferCandidate[] = [{ runId: ISIAH.id, leadLabel: "Isiah Perez" }];
      expect(liveLegClaims(live, parsed.timeframe), body).toBe(true);
    }
  });

  it("claims on a bare 1 with a single offer", () => {
    expect(parseClaimWithTimeframe("1")).toBeNull();
    const resolved = matchLateClaimReply({
      candidates: [ISIAH],
      from: JASON,
      digit: "1",
      timeframe: "",
      nowMs: NOW,
      windowMs: DAY_MS
    });
    expect(resolved.outcome).toBe("match");
    if (resolved.outcome !== "match") return;
    expect(resolved.match.row.id).toBe(ISIAH.id);
  });
});
