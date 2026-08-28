import { describe, expect, it } from "vitest";
import {
  FOLLOW_UP_PENDING_BY_VAR,
  FOLLOW_UP_PENDING_DONE_VAR,
  FOLLOW_UP_PENDING_NAME_VAR,
  followUpAckText,
  followUpAmbiguityText,
  followUpAppliedText,
  followUpNoLeadText,
  followUpPendingText,
  followUpRunAmbiguityText,
  followUpCandidatesFrom,
  followUpRunCandidatesFrom,
  matchFollowUpRun,
  matchFollowUpTarget,
  meansFollowUp,
  parseFollowUpReply,
  pendingFollowUpFrom,
  withPendingFollowUp
} from "../supabase/functions/_shared/ai_flows/follow_up_reply";

/**
 * "F" marks a lead for AI follow-up. Amy's team works from their phones, so
 * the shortest thing they can type has to be the thing that works, and the
 * wordings people actually reach for have to mean the same thing.
 */

describe("meansFollowUp", () => {
  it.each(["F", "f", " f ", "F.", "needs follow up", "Needs Follow-Up", "follow up", "f/u", "FU"])(
    "reads %j as a follow-up instruction",
    (t) => expect(meansFollowUp(t)).toBe(true)
  );

  /**
   * A single letter is the cheapest thing in the world to type by accident, so
   * it only counts as the WHOLE message. A sentence that merely contains it is
   * a teammate talking, not an instruction.
   */
  it.each(["", "1", "86", "Fine", "F is for follow up", "can you follow up with them?", "2, out of town"])(
    "does not read %j as one",
    (t) => expect(meansFollowUp(t)).toBe(false)
  );
});

describe("parseFollowUpReply", () => {
  it("takes a bare instruction to mean the most recent lead", () => {
    expect(parseFollowUpReply("F")).toEqual({ name: "" });
    expect(parseFollowUpReply("needs follow up")).toEqual({ name: "" });
  });

  // People type the name on either side, so both are accepted. The claim
  // picker only allows "1, <name>" because a leading digit is unambiguous;
  // here both halves are prose.
  it("reads the name from either side of the comma", () => {
    expect(parseFollowUpReply("Daniel, F")).toEqual({ name: "Daniel" });
    expect(parseFollowUpReply("F, Daniel")).toEqual({ name: "Daniel" });
    expect(parseFollowUpReply("Daniel Villanueva, needs follow up")).toEqual({
      name: "Daniel Villanueva"
    });
  });

  it("returns null for anything that is not a follow-up instruction", () => {
    expect(parseFollowUpReply("1, 20 min")).toBeNull();
    expect(parseFollowUpReply("2, out of town")).toBeNull();
    expect(parseFollowUpReply("on my way")).toBeNull();
    expect(parseFollowUpReply("")).toBeNull();
  });

  // Naming no lead is better than guessing which half was meant.
  it("refuses when both halves are instructions, or the name half is empty", () => {
    expect(parseFollowUpReply("f, f/u")).toBeNull();
    expect(parseFollowUpReply("F,")).toBeNull();
  });

  /**
   * A stray leading comma is a typo, not a name. It is stripped before the
   * split, so ", F" reads as a bare F and takes the most recent lead, which is
   * what the teammate meant.
   */
  it("treats a leading comma as a typo, not an empty name", () => {
    expect(parseFollowUpReply(", F")).toEqual({ name: "" });
  });
});

describe("matchFollowUpTarget", () => {
  const cands = [
    { contactId: "c1", name: "Marla Kay W.", phone: "+14805550001" },
    { contactId: "c2", name: "Daniel Villanueva", phone: "+14805550002" },
    { contactId: "c3", name: "Daniel Hernandez", phone: "+14805550003" }
  ];

  it("takes the newest lead when no name was given", () => {
    expect(matchFollowUpTarget(cands, "")).toEqual({ kind: "one", candidate: cands[0] });
  });

  it("matches on a first name or a surname", () => {
    expect(matchFollowUpTarget(cands, "Villanueva")).toEqual({ kind: "one", candidate: cands[1] });
    expect(matchFollowUpTarget(cands, "Marla")).toEqual({ kind: "one", candidate: cands[0] });
  });

  /**
   * Tagging the wrong lead starts a three-day calling cadence at somebody who
   * never asked for one, so an ambiguous name asks instead of guessing.
   */
  it("asks when a name fits more than one lead", () => {
    const m = matchFollowUpTarget(cands, "Daniel");
    expect(m.kind).toBe("ambiguous");
    expect(m.kind === "ambiguous" && m.candidates).toHaveLength(2);
  });

  it("matches a full name exactly", () => {
    expect(matchFollowUpTarget(cands, "Daniel Villanueva")).toEqual({
      kind: "one",
      candidate: cands[1]
    });
  });

  /**
   * A lead the flow never captured a name for cannot be picked BY name. It is
   * still reachable as the newest lead with a bare "F"; it just never matches
   * a needle, rather than matching every needle.
   */
  it("skips candidates with no name on file", () => {
    const withBlank = [{ contactId: "c0", name: "", phone: "+14805550000" }, ...cands];
    expect(matchFollowUpTarget(withBlank, "Marla")).toEqual({ kind: "one", candidate: cands[0] });
    expect(matchFollowUpTarget(withBlank, "")).toEqual({
      kind: "one",
      candidate: withBlank[0]
    });
  });

  it("reports no match rather than falling back to the newest", () => {
    expect(matchFollowUpTarget(cands, "Nobody")).toEqual({ kind: "none" });
    expect(matchFollowUpTarget([], "")).toEqual({ kind: "none" });
  });
});

describe("reply copy", () => {
  // The teammate has to know WHICH lead they just started a cadence on.
  it("names the lead in the confirmation and says what happens next", () => {
    const t = followUpAckText("Daniel Villanueva");
    expect(t).toContain("Daniel Villanueva");
    expect(t).toContain("every 3 days");
    expect(t).toContain("stop the moment they reply");
    expect(followUpAckText("  ")).toContain("that lead");
  });

  it("shows the choices when a name was ambiguous", () => {
    expect(followUpAmbiguityText(["Daniel Villanueva", "Daniel Hernandez"])).toContain(
      "Daniel Villanueva, F"
    );
  });

  /**
   * The wording is the fix here, not decoration. "No recent lead here matches
   * Rhonda" reads as WE HAVE NEVER HEARD OF HER, and Amy got exactly that on a
   * HomeLight referral we had texted her about four minutes earlier: the lead
   * was real, it just had no contact row yet. The text has to say what was
   * searched (contacts on file) and what to do next, and must not deny the
   * lead exists.
   */
  it("says what was searched, not that the lead does not exist", () => {
    const t = followUpNoLeadText("Rhonda");
    expect(t).toContain('"Rhonda"');
    expect(t).toContain("contact on file");
    expect(t).toContain("dashboard");
    // The old copy's denial must not come back.
    expect(t).not.toContain("No recent lead here matches");
    expect(followUpNoLeadText("")).toBe(
      "I don't have a recent contact on file to mark for follow-up."
    );
  });

  /**
   * The case the whole in-flight path exists for: we KNOW the lead, the
   * referral site simply has not released their number yet. Saying "no lead
   * matches" there is true and useless, so this text has to promise the thing
   * that will actually happen and tell the teammate to stop worrying about it.
   */
  it("explains the withheld-details case and promises the follow-through", () => {
    const t = followUpPendingText("Rhonda J.", { claimState: "claimed" });
    expect(t).toContain("Rhonda J.");
    expect(t).toContain("hasn't released");
    expect(t).toContain("I'll text you");
    expect(t).toContain("Nothing else for you to do");
  });

  /**
   * The one thing this text must never do on an UNCLAIMED lead is say "nothing
   * else for you to do". On HomeLight the claim is what releases the contact
   * details, so standing the teammate down guarantees the details never arrive
   * and the request they just made can never fire.
   */
  it("tells an unclaimed lead's asker to claim, and never to stand down", () => {
    const t = followUpPendingText("Rhonda J.", { claimState: "unclaimed" });
    expect(t).toContain("hasn't been claimed");
    expect(t).toContain('reply "1"');
    expect(t).not.toContain("Nothing else for you to do");
  });

  /**
   * Plenty of flows track no claim at all. Asserting either way there would be
   * a guess, so this one asserts neither, and still carries the nudge.
   */
  it("asserts neither way when the flow tracks no claim", () => {
    const t = followUpPendingText("Rhonda J.", { claimState: "unknown" });
    expect(t).not.toContain("is claimed");
    expect(t).not.toContain("hasn't been claimed");
    expect(t).not.toContain("Nothing else for you to do");
    expect(t).toContain("still unclaimed");
  });

  it("confirms by name once the parked request actually fires", () => {
    const t = followUpAppliedText("Rhonda J.");
    expect(t).toContain("Rhonda J.");
    expect(t).toContain("every 3 days");
    expect(t).toContain("stop the moment they reply");
  });

  it("shows the choices when a live lead's name was ambiguous", () => {
    expect(followUpRunAmbiguityText(["Rhonda J.", "Rhonda Smith"])).toContain('"Rhonda J., F"');
  });
});

/**
 * ---------------------------------------------------------------------------
 * Leads that exist only as a live run
 * ---------------------------------------------------------------------------
 *
 * Amy, Aug 28 2026: a HomeLight referral arrived at 15:40, she claimed it at
 * 16:08, texted "F, Rhonda J." at 16:09 and "F, Rhonda" at 16:10, and the
 * contact row was not created until 16:18. Both replies said no lead matched.
 * HomeLight withholds the phone and email until the claim is confirmed on
 * their side, so for 38 minutes the lead existed only as `vars.lead_name` on a
 * live run. These pin that window.
 */
describe("followUpRunCandidatesFrom", () => {
  const run = (id: string, vars: Record<string, unknown>, revision = 1) => ({
    id,
    revision,
    context: { vars }
  });

  it("takes leads that are named but have no number yet", () => {
    const out = followUpRunCandidatesFrom([
      run("r1", { lead_name: "Rhonda J.", lead_phone: "none" })
    ]);
    expect(out).toEqual([
      {
        runId: "r1",
        revision: 1,
        leadName: "Rhonda J.",
        alreadyPending: false,
        claimState: "unknown"
      }
    ]);
  });

  /**
   * "none" is the flows' spelling of "we looked and found nothing", written as
   * a literal string by extraction steps. A plain truthiness check would read
   * `lead_phone: "none"` as "we have their number" and skip the one lead this
   * path exists to catch.
   */
  it.each(["none", "None", " unknown ", "n/a", ""])(
    "reads a lead_phone of %j as still withheld",
    (phone) => {
      expect(followUpRunCandidatesFrom([run("r1", { lead_name: "Rhonda", lead_phone: phone })]))
        .toHaveLength(1);
    }
  );

  /**
   * A run that already HAS the number has a contact row, or is one step from
   * one, so the ordinary contact match is the right path for it. Parking here
   * would make the request wait on a step that has already run.
   */
  it("skips a run that already has the lead's number", () => {
    expect(
      followUpRunCandidatesFrom([run("r1", { lead_name: "Rhonda", lead_phone: "+14803184130" })])
    ).toEqual([]);
  });

  it("skips a run that names no lead at all", () => {
    expect(followUpRunCandidatesFrom([run("r1", { price: "$379K" })])).toEqual([]);
    expect(followUpRunCandidatesFrom([{ id: "r2", revision: 1 }])).toEqual([]);
    expect(followUpRunCandidatesFrom([{ id: "r3", revision: 1, context: null }])).toEqual([]);
    // A non-string lead_name is not a name.
    expect(followUpRunCandidatesFrom([run("r4", { lead_name: 42 })])).toEqual([]);
  });

  it("falls back to the first name when only that was extracted", () => {
    expect(
      followUpRunCandidatesFrom([run("r1", { lead_name: "none", lead_first_name: "Rhonda" })])[0]!
        .leadName
    ).toBe("Rhonda");
  });

  /**
   * Claim state on POSITIVE evidence only. Guessing "claimed" from a run
   * merely sitting in `queued` would tell a teammate to stand down on a lead
   * nobody has taken, and an unclaimed offer passes through `queued` between
   * reminder rounds (Bugbot, PR #1702).
   */
  describe("claim state", () => {
    it("reads the claim reply's own stamp as claimed", () => {
      const out = followUpRunCandidatesFrom([
        {
          id: "r1",
          revision: 1,
          status: "queued",
          context: { vars: { lead_name: "Rhonda" }, routing: { claimed_by: "+16026951142" } }
        }
      ]);
      expect(out[0]!.claimState).toBe("claimed");
    });

    it("reads a named claimed_agent as claimed", () => {
      expect(
        followUpRunCandidatesFrom([
          run("r1", { lead_name: "Rhonda", claimed_agent: "Amy Laidlaw" })
        ])[0]!.claimState
      ).toBe("claimed");
    });

    /**
     * The trap Bugbot caught: the worker seeds claimed_agent="none" into EVERY
     * run of EVERY flow at context setup, so it is a default, not a fact. 363
     * of 400 recent production runs carried it with no routing at all, across
     * 18 flows with no claim concept. Reading it as "unclaimed" told nine
     * teammates in ten to reply "1" to an offer that does not exist, and a
     * bare "1" claims the most recent live offer, potentially a different
     * lead entirely.
     */
    it("does NOT read the seeded claimed_agent 'none' as unclaimed", () => {
      expect(
        followUpRunCandidatesFrom([run("r1", { lead_name: "Rhonda", claimed_agent: "none" })])[0]!
          .claimState
      ).toBe("unknown");
    });

    /**
     * `routing` is the honest tell: it exists only once a route_to_team has
     * actually offered this lead, so its presence proves there IS something to
     * claim, and no claimed_by on it proves nobody has.
     */
    it("reads an offered-but-unclaimed run as unclaimed", () => {
      expect(
        followUpRunCandidatesFrom([
          {
            id: "r1",
            revision: 1,
            status: "queued",
            context: {
              vars: { lead_name: "Rhonda", claimed_agent: "none" },
              routing: { claimed_by: null }
            }
          }
        ])[0]!.claimState
      ).toBe("unclaimed");
    });

    it("reads a parked offer as unclaimed", () => {
      expect(
        followUpRunCandidatesFrom([
          { id: "r1", revision: 1, status: "awaiting_agent", context: { vars: { lead_name: "R" } } }
        ])[0]!.claimState
      ).toBe("unclaimed");
    });

    // The trap: queued does NOT mean claimed.
    it("does not read a queued run as claimed on its own", () => {
      expect(
        followUpRunCandidatesFrom([
          { id: "r1", revision: 1, status: "queued", context: { vars: { lead_name: "R" } } }
        ])[0]!.claimState
      ).toBe("unknown");
      expect(
        followUpRunCandidatesFrom([
          { id: "r2", revision: 1, context: { vars: { lead_name: "R" }, routing: null } }
        ])[0]!.claimState
      ).toBe("unknown");
      // The shape 91% of production runs actually have: seeded sentinel, no
      // routing, ordinary status. Must stay "unknown".
      expect(
        followUpRunCandidatesFrom([
          {
            id: "r4",
            revision: 1,
            status: "queued",
            context: { vars: { lead_name: "R", claimed_agent: "none", claimed_agent_phone: "none" } }
          }
        ])[0]!.claimState
      ).toBe("unknown");
      // A non-string claimed_agent is not a claim either.
      expect(
        followUpRunCandidatesFrom([run("r3", { lead_name: "R", claimed_agent: 7 })])[0]!.claimState
      ).toBe("unknown");
    });
  });

  it("reports a request already parked on the run", () => {
    const out = followUpRunCandidatesFrom([
      run("r1", { lead_name: "Rhonda", [FOLLOW_UP_PENDING_BY_VAR]: "+16026951142" })
    ]);
    expect(out[0]!.alreadyPending).toBe(true);
  });

  // Newest-first in, newest-first out: a bare "F" means the lead we just told
  // them about.
  it("preserves the query's order", () => {
    const out = followUpRunCandidatesFrom([run("new", { lead_name: "B" }), run("old", { lead_name: "A" })]);
    expect(out.map((c) => c.runId)).toEqual(["new", "old"]);
  });
});

describe("matchFollowUpRun", () => {
  const cand = (runId: string, leadName: string) => ({
    runId,
    revision: 1,
    leadName,
    alreadyPending: false,
    claimState: "unknown" as const
  });

  it("takes the newest live run when no name was typed", () => {
    const m = matchFollowUpRun([cand("new", "Rhonda J."), cand("old", "Thomas L.")], "");
    expect(m).toEqual({ kind: "one", run: cand("new", "Rhonda J.") });
  });

  /**
   * The two texts Amy actually sent. Both have to reach the same run: "Rhonda
   * J." is the whole name, "Rhonda" is one word of it.
   */
  it.each(["Rhonda J.", "Rhonda", "rhonda j"])("matches %j to the live lead", (typed) => {
    const m = matchFollowUpRun([cand("r1", "Rhonda J.")], typed);
    expect(m.kind).toBe("one");
  });

  it("has nothing to say when no live run names that lead", () => {
    expect(matchFollowUpRun([cand("r1", "Thomas L.")], "Rhonda")).toEqual({ kind: "none" });
    expect(matchFollowUpRun([], "Rhonda")).toEqual({ kind: "none" });
    expect(matchFollowUpRun([], "")).toEqual({ kind: "none" });
  });

  /**
   * Asks rather than guessing, for the same reason the contact matcher does:
   * the wrong pick starts a three-day calling cadence at somebody who never
   * asked for one.
   */
  it("asks when two live leads answer to the name", () => {
    const m = matchFollowUpRun([cand("r1", "Rhonda J."), cand("r2", "Rhonda Smith")], "Rhonda");
    expect(m).toEqual({
      kind: "ambiguous",
      runs: [cand("r1", "Rhonda J."), cand("r2", "Rhonda Smith")]
    });
  });

  it("ignores a candidate whose name normalizes to nothing", () => {
    expect(matchFollowUpRun([cand("r1", "!!!")], "Rhonda")).toEqual({ kind: "none" });
  });
});

describe("withPendingFollowUp / pendingFollowUpFrom", () => {
  it("parks the request in vars without disturbing the rest of the context", () => {
    const next = withPendingFollowUp(
      { vars: { lead_name: "Rhonda J.", price: "$379K" }, routing: { claimed_by: "+1602" } },
      { requestedBy: "+16026951142", leadName: "Rhonda J." }
    );
    expect(next.routing).toEqual({ claimed_by: "+1602" });
    expect((next.vars as Record<string, unknown>).price).toBe("$379K");
    expect((next.vars as Record<string, unknown>)[FOLLOW_UP_PENDING_BY_VAR]).toBe("+16026951142");
    expect(pendingFollowUpFrom(next.vars as Record<string, unknown>)).toEqual({
      requestedBy: "+16026951142",
      leadName: "Rhonda J."
    });
  });

  it("copes with a run that has no context or no vars yet", () => {
    expect(withPendingFollowUp(null, { requestedBy: "+1602", leadName: "R" }).vars).toEqual({
      [FOLLOW_UP_PENDING_BY_VAR]: "+1602",
      [FOLLOW_UP_PENDING_NAME_VAR]: "R"
    });
    expect(withPendingFollowUp({ vars: "not-an-object" }, { requestedBy: "+1602", leadName: "R" }).vars)
      .toEqual({
        [FOLLOW_UP_PENDING_BY_VAR]: "+1602",
        [FOLLOW_UP_PENDING_NAME_VAR]: "R"
      });
  });

  it("reads nothing pending when none was parked", () => {
    expect(pendingFollowUpFrom({})).toBeNull();
    expect(pendingFollowUpFrom(null)).toBeNull();
    expect(pendingFollowUpFrom({ [FOLLOW_UP_PENDING_BY_VAR]: "  " })).toBeNull();
  });

  /**
   * The done-marker is the only thing standing between a retried or re-claimed
   * upsert_customer step and a SECOND tag_changed event, which would mean two
   * calling cadences dialing one person.
   */
  it("stops reporting the request once it has been applied", () => {
    const vars = {
      [FOLLOW_UP_PENDING_BY_VAR]: "+16026951142",
      [FOLLOW_UP_PENDING_NAME_VAR]: "Rhonda J.",
      [FOLLOW_UP_PENDING_DONE_VAR]: true
    };
    expect(pendingFollowUpFrom(vars)).toBeNull();
  });

  it("still reports the request when the name was never captured", () => {
    expect(pendingFollowUpFrom({ [FOLLOW_UP_PENDING_BY_VAR]: "+1602" })).toEqual({
      requestedBy: "+1602",
      leadName: ""
    });
  });
});


/**
 * The lookup that feeds the matcher. Bugbot found the first version selecting
 * columns this table does not have (`name`, `is_staff` instead of
 * `display_name`, `type`): PostgREST rejected the select, the error was
 * swallowed, and every F reply answered "no recent lead" while tagging nobody.
 * These pin the shape as well as the rules.
 */
describe("followUpCandidatesFrom", () => {
  const SENDER = "+16025551111";
  const rows = [
    { id: "c1", display_name: "Michelle Rodahl", customer_e164: "+15053606293", tags: ["Contacted"], type: "customer" },
    { id: "me", display_name: "Dave Lane", customer_e164: SENDER, type: "customer" },
    { id: "nophone", display_name: "No Number", customer_e164: "", type: "customer" },
    { id: "c2", display_name: "Danny Wallin", customer_e164: "+15208409790", type: "owner" }
  ];

  /**
   * Shape only. Who counts as STAFF is decided by staffNumberCheck, because
   * owner numbers are usually derived (business phone, forward cell, the
   * coworker's DID) and the owner's contact row is very often typed
   * "customer", so an owner-typed row is passed THROUGH here for that check
   * to reject, rather than being the whole test (Bugbot, PR #1304).
   */
  it("drops only rows with no number and the sender's own row", () => {
    const out = followUpCandidatesFrom(rows, { senderE164: SENDER });
    expect(out.map((c) => c.contactId)).toEqual(["c1", "c2"]);
  });

  it("carries type through so the staff check can use it", () => {
    const out = followUpCandidatesFrom(rows, { senderE164: SENDER });
    expect(out.find((c) => c.contactId === "c2")!.type).toBe("owner");
  });

  // Newest-first in, newest-first out: a bare "F" means the most recent lead.
  it("preserves the query's order", () => {
    expect(followUpCandidatesFrom(rows, { senderE164: SENDER })[0]!.name).toBe("Michelle Rodahl");
  });

  it("reads display_name and defaults tags to an array", () => {
    const out = followUpCandidatesFrom([{ id: "x", display_name: "A B", customer_e164: "+15551234567" }], {
      senderE164: SENDER
    });
    expect(out[0]).toEqual({ contactId: "x", name: "A B", phone: "+15551234567", type: "", tags: [] });
  });

  /**
   * These columns are nullable, and a null is not an empty string. A row with
   * no number cannot be called; a row with no name is still a real lead and
   * stays reachable as the newest one.
   */
  it("handles null phone and null name", () => {
    const out = followUpCandidatesFrom(
      [
        { id: "nullphone", display_name: "Ghost", customer_e164: null },
        { id: "nullname", display_name: null, customer_e164: "+15559998888", tags: null }
      ],
      { senderE164: SENDER }
    );
    expect(out).toEqual([
      { contactId: "nullname", name: "", phone: "+15559998888", type: "", tags: [] }
    ]);
  });
});

/**
 * The Rhonda J. regression, replayed from the real run.
 *
 * These vars are copied from ai_flow_run bafe79fc (Amy Laidlaw Real Estate,
 * HomeLight Referral, Aug 28 2026) as they stood at 16:09 UTC, the minute both
 * of her "F" texts arrived. The run was `queued`, parked on wait_hl_call, and
 * the contacts table had no Rhonda for another nine minutes.
 *
 * Every wording she actually typed has to reach this run. If this test ever
 * goes red, the withheld-details window is answering "no lead matches" again.
 */
describe("Rhonda J. (Amy Laidlaw, Aug 28 2026)", () => {
  const liveRun = {
    id: "bafe79fc-86ae-49de-8804-728c8d849276",
    revision: 7,
    context: {
      vars: {
        city: "85205",
        price: "$379K",
        lead_name: "Rhonda J.",
        lead_type: "seller",
        lead_email: "none",
        lead_phone: "none",
        claim_state: "NOT CONFIRMED, claim by hand now.",
        lead_address: "85205, AZ",
        claimed_agent: "Amy Laidlaw",
        contact_release: "withheld",
        lead_first_name: "Rhonda",
        __resume_step_id: "wait_hl_call"
      }
    }
  };

  it.each(["F, Rhonda J.", "F, Rhonda", "Rhonda, F", "rhonda j, needs follow up"])(
    "resolves %j to the live run instead of denying the lead",
    (text) => {
      const parsed = parseFollowUpReply(text)!;
      expect(parsed).not.toBeNull();
      // The contacts table had nothing: this is what actually happened.
      expect(matchFollowUpTarget([], parsed.name)).toEqual({ kind: "none" });
      // The live run did know her.
      const match = matchFollowUpRun(followUpRunCandidatesFrom([liveRun]), parsed.name);
      expect(match).toEqual({
        kind: "one",
        run: {
          runId: "bafe79fc-86ae-49de-8804-728c8d849276",
          revision: 7,
          leadName: "Rhonda J.",
          alreadyPending: false,
          // Amy had already claimed it, so the ack may say "nothing else to do".
          claimState: "claimed"
        }
      });
    }
  );

  /**
   * Amy texted twice, 22 seconds apart. The second must confirm, not park a
   * second request: two parked requests would be two tag writes and two
   * calling cadences dialing one seller.
   */
  it("treats the second identical text as already noted", () => {
    const parked = withPendingFollowUp(liveRun.context, {
      requestedBy: "+16026951142",
      leadName: "Rhonda J."
    });
    const again = followUpRunCandidatesFrom([{ ...liveRun, context: parked as typeof liveRun.context }]);
    expect(again[0]!.alreadyPending).toBe(true);
  });

  /**
   * Once HomeLight released the details at 16:18, the run filed the contact.
   * At that point the run no longer qualifies as "pending", the ordinary
   * contact path owns it, and the parked request fires from the worker.
   */
  it("stops qualifying once the lead's number lands", () => {
    const released = {
      ...liveRun,
      context: { vars: { ...liveRun.context.vars, lead_phone: "+14803184130" } }
    };
    expect(followUpRunCandidatesFrom([released])).toEqual([]);
    expect(
      matchFollowUpTarget(
        [{ contactId: "1efff5ec", name: "Rhonda J.", phone: "+14803184130" }],
        "Rhonda"
      )
    ).toEqual({
      kind: "one",
      candidate: { contactId: "1efff5ec", name: "Rhonda J.", phone: "+14803184130" }
    });
  });
});
