import { describe, expect, it } from "vitest";
import {
  followUpAckText,
  followUpAmbiguityText,
  followUpNoLeadText,
  matchFollowUpTarget,
  meansFollowUp,
  parseFollowUpReply
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

  it("says plainly when nothing was tagged", () => {
    expect(followUpNoLeadText("Nobody")).toContain('"Nobody"');
    expect(followUpNoLeadText("")).toBe("No recent lead to mark for follow-up.");
  });
});
