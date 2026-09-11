import { describe, expect, it } from "vitest";
import {
  broadcastTagMatched,
  filterRosterByLeadTag,
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

  it("a both-type lead reaches Dave and Gabby, not Jason", () => {
    const out = selectBroadcastTeam([row(), gabby, jason], "both");
    expect(out.map((m) => m.name)).toEqual(["Dave Lane", "Gabrielle Mota"]);
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

/**
 * "Everyone got the alert" and "the tag matched nobody so everyone got the
 * alert" produce an identical send log and mean very different things. The
 * second says the roster's tags need fixing.
 */
describe("broadcastTagMatched", () => {
  it("reports a genuine match", () => {
    expect(broadcastTagMatched([row(), jason], "seller")).toBe(true);
  });

  it("reports the fail-safe widening as a MISS", () => {
    expect(broadcastTagMatched([row(), jason], "sellr")).toBe(false);
  });

  it("is true when EVERY eligible member carries the tag", () => {
    // The audience size is unchanged here, so a size comparison would call
    // this a miss. It is not one: the tag matched, it just narrowed nothing.
    expect(broadcastTagMatched([row(), gabby], "seller")).toBe(true);
  });

  it("ignores rows that are not broadcast-eligible", () => {
    const tagged = row({ id: "m9", team_broadcast_enabled: false, tags: ["seller"] });
    expect(broadcastTagMatched([tagged, jason], "seller")).toBe(false);
    const noPhone = row({ id: "m8", phone_e164: "  ", tags: ["seller"] });
    expect(broadcastTagMatched([noPhone, jason], "seller")).toBe(false);
  });

  it("is false without a tag to match", () => {
    for (const tag of [undefined, null, "", "   "]) {
      expect(broadcastTagMatched([row()], tag)).toBe(false);
    }
  });

  it("matches case- and whitespace-insensitively, and skips a null tags column", () => {
    expect(broadcastTagMatched([row({ tags: [" SeLLer "] })], "SELLER")).toBe(true);
    expect(broadcastTagMatched([row({ tags: null })], "seller")).toBe(false);
  });
});

/**
 * Rotation's tag filter. Same fail-safe as the alert selector, but it does
 * NOT read team_broadcast_enabled: rotation's opt-out is routing_enabled,
 * already applied before this runs.
 */
describe("filterRosterByLeadTag", () => {
  const dave = row();
  const gabbyRow = gabby;
  const jasonBuyer = jason;
  const amyOffBroadcast = amy;

  it("a seller rotation drops Jason and keeps Dave and Gabby", () => {
    const out = filterRosterByLeadTag([jasonBuyer, dave, gabbyRow], "seller");
    expect(out.map((m) => m.name)).toEqual(["Dave Lane", "Gabrielle Mota"]);
  });

  it("a buyer rotation keeps Jason", () => {
    const out = filterRosterByLeadTag([jasonBuyer, dave, gabbyRow], "buyer");
    expect(out.map((m) => m.id)).toEqual(["m3", "m1", "m2"]);
  });

  it("preserves input order (least-recently-offered first)", () => {
    // Jason is first in this list, so a buyer rotation still offers him first.
    const out = filterRosterByLeadTag([jasonBuyer, dave], "buyer");
    expect(out.map((m) => m.id)).toEqual(["m3", "m1"]);
  });

  it("FAILS SAFE: a tag nobody carries leaves the whole roster", () => {
    const out = filterRosterByLeadTag([jasonBuyer, dave], "sellr");
    expect(out.map((m) => m.id)).toEqual(["m3", "m1"]);
  });

  it("does not fail-safe onto whoever is left when the tag matches people who are merely absent", () => {
    // Same order unowned alerts use: tag against the FULL roster, then keep
    // the available slice. Dave covers sellers and is out; Jason is in and
    // buyer-only. Empty remainder, not Jason.
    const out = filterRosterByLeadTag([jasonBuyer], "seller", [jasonBuyer, dave]);
    expect(out).toEqual([]);
  });

  it("keeps the available tagged slice when matchAgainst confirms the tag", () => {
    const out = filterRosterByLeadTag([jasonBuyer, dave], "seller", [
      jasonBuyer,
      dave,
      gabbyRow
    ]);
    expect(out.map((m) => m.id)).toEqual(["m1"]);
  });

  it("a typo still fail-safes when the full roster also has no such tag", () => {
    const out = filterRosterByLeadTag([jasonBuyer], "sellr", [jasonBuyer, dave]);
    expect(out.map((m) => m.id)).toEqual(["m3"]);
  });

  it("treats an empty or whitespace tag as no filter", () => {
    for (const tag of [undefined, null, "", "   "]) {
      expect(filterRosterByLeadTag([jasonBuyer, dave], tag)).toHaveLength(2);
    }
  });

  it("does NOT drop a teammate whose team broadcasts are off", () => {
    // selectBroadcastTeam would exclude Amy here. Rotation must not: her
    // in-line switch is routing_enabled, not team_broadcast_enabled.
    const out = filterRosterByLeadTag(
      [amyOffBroadcast, dave],
      undefined
    );
    expect(out.map((m) => m.id)).toEqual(["m4", "m1"]);
  });

  it("keeps a team-broadcast-off teammate who carries the tag", () => {
    const taggedAmy = row({
      id: "m4",
      name: "Amy Laidlaw",
      team_broadcast_enabled: false,
      tags: ["seller"]
    });
    const out = filterRosterByLeadTag([taggedAmy, jasonBuyer], "seller");
    expect(out.map((m) => m.id)).toEqual(["m4"]);
  });

  it("matches tags case- and whitespace-insensitively", () => {
    for (const tag of ["Seller", "  SELLER  "]) {
      expect(filterRosterByLeadTag([row({ tags: ["  SeLLer "] })], tag)).toHaveLength(1);
    }
  });

  it("treats a null tags column as carrying no tags, then fails safe", () => {
    const out = filterRosterByLeadTag([row({ tags: null })], "seller");
    expect(out).toHaveLength(1);
  });

  it("drops an available row with no tags when the full roster confirms the tag", () => {
    // anyoneHasTag is true because Dave covers sellers; the available slice
    // is Jason plus an untagged row, so the filter must walk `tags ?? []`
    // and return empty rather than fail-safe.
    const untagged = row({ id: "m9", name: "No Tags", tags: null });
    const out = filterRosterByLeadTag([untagged, jasonBuyer], "seller", [
      dave,
      untagged,
      jasonBuyer
    ]);
    expect(out).toEqual([]);
  });
});
