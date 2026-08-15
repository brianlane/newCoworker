import { describe, expect, it } from "vitest";
import {
  selectBroadcastTeam,
  type BroadcastMemberRow
} from "../supabase/functions/_shared/team_broadcast";

/**
 * Who hears about a lead nobody owns.
 *
 * The rule exists because of one lead (Amy Laidlaw, Aug 14-15 2026): a Clever
 * seller asked for a call, then said the next day that nobody had contacted
 * him. Both alerts had gone to the business owner alone, because the contact
 * had no owner. Amy's rule: an unowned lead goes to the teammates who cover
 * that lead type BEFORE it falls to her.
 *
 * Every case here is about the same property: this function must never
 * return an empty list when somebody eligible exists, because an empty list
 * is a lead nobody is told about.
 */

const DAVE = "+16025245719";
const GABBY = "+14807202013";
const JASON = "+14807039575";

const row = (over: Partial<BroadcastMemberRow> = {}): BroadcastMemberRow => ({
  id: "m1",
  name: "Dave Lane",
  phone_e164: DAVE,
  team_broadcast_enabled: null,
  tags: ["buyer", "seller", "both"],
  ...over
});

const gabby = row({ id: "m2", name: "Gabrielle Mota", phone_e164: GABBY });
const jason = row({ id: "m3", name: "Jason Lane", phone_e164: JASON, tags: ["buyer"] });
/** Amy's own row: kept out of team traffic, which is what makes her the backstop. */
const amy = row({
  id: "m4",
  name: "Amy Laidlaw",
  phone_e164: "+16026951142",
  team_broadcast_enabled: false,
  tags: []
});

describe("selectBroadcastTeam: eligibility", () => {
  it("returns everyone with a phone when no tag narrows it", () => {
    expect(selectBroadcastTeam([row(), gabby]).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("excludes only an EXPLICIT team_broadcast_enabled false", () => {
    const out = selectBroadcastTeam([row(), amy]);
    expect(out.map((m) => m.name)).toEqual(["Dave Lane"]);
  });

  it("treats an unset broadcast flag as available", () => {
    // An unset column means available, matching how the roster's other
    // availability flags are read. A row defaulting to excluded would drop
    // teammates silently as the schema grows.
    for (const flag of [null, undefined, true]) {
      const out = selectBroadcastTeam([row({ team_broadcast_enabled: flag })]);
      expect(out).toHaveLength(1);
    }
  });

  it("drops rows with no usable phone", () => {
    for (const phone of [null, undefined, "", "   "]) {
      expect(selectBroadcastTeam([row({ phone_e164: phone })])).toEqual([]);
    }
  });

  it("trims the phone and normalizes a blank name to null", () => {
    const [m] = selectBroadcastTeam([row({ phone_e164: `  ${DAVE} `, name: "  " })]);
    expect(m.phone).toBe(DAVE);
    expect(m.name).toBeNull();
  });

  it("normalizes a null name to null", () => {
    expect(selectBroadcastTeam([row({ name: null })])[0].name).toBeNull();
  });

  it("returns an empty list only when nobody is eligible at all", () => {
    expect(selectBroadcastTeam([])).toEqual([]);
    expect(selectBroadcastTeam([amy])).toEqual([]);
  });
});

describe("selectBroadcastTeam: the lead-type filter", () => {
  it("keeps only the teammates carrying the tag", () => {
    const out = selectBroadcastTeam([row(), gabby, jason], "seller");
    expect(out.map((m) => m.name)).toEqual(["Dave Lane", "Gabrielle Mota"]);
  });

  it("widens a buyer alert to everyone who covers buyers", () => {
    const out = selectBroadcastTeam([row(), gabby, jason], "buyer");
    expect(out.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("matches tags case- and whitespace-insensitively", () => {
    for (const tag of ["Seller", "  SELLER  "]) {
      expect(selectBroadcastTeam([row({ tags: ["  SeLLer " ] })], tag)).toHaveLength(1);
    }
  });

  it("FAILS SAFE: a tag nobody carries alerts every eligible member", () => {
    // Tags are free text with nothing validating them. A typo must cost
    // noise, never a lead: the alternative is an alert that reaches no one.
    const out = selectBroadcastTeam([row(), gabby], "sellr");
    expect(out.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("treats an empty or whitespace tag as no filter", () => {
    for (const tag of [undefined, null, "", "   "]) {
      expect(selectBroadcastTeam([row(), jason], tag)).toHaveLength(2);
    }
  });

  it("ignores blank entries inside a roster row's tags", () => {
    const out = selectBroadcastTeam([row({ tags: ["", "   ", "seller"] })], "seller");
    expect(out).toHaveLength(1);
  });

  it("treats a null tags column as carrying no tags", () => {
    // Fails safe rather than empty: nobody matches, so everyone is alerted.
    const out = selectBroadcastTeam([row({ tags: null })], "seller");
    expect(out).toHaveLength(1);
  });
});
