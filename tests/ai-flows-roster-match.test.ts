import { describe, expect, it } from "vitest";
import { matchRosterName } from "../supabase/functions/_shared/ai_flows/roster_match";

/**
 * The dynamic route_to_team pin's roster matcher (agentNameVar): the owner
 * named a teammate in plain words and the worker must resolve exactly one
 * ACTIVE roster member or refuse. Ambiguity resolves nothing, because
 * misrouting a lead is worse than handing it back to the owner.
 */

const ROSTER = ["Dave Lane", "Gabrielle Mota", "Jason Lane"];

describe("matchRosterName", () => {
  it("empty and 'none' mean un-pinned (the step routes normally)", () => {
    expect(matchRosterName("", ROSTER)).toEqual({ kind: "unpinned" });
    expect(matchRosterName("   ", ROSTER)).toEqual({ kind: "unpinned" });
    expect(matchRosterName("none", ROSTER)).toEqual({ kind: "unpinned" });
    expect(matchRosterName("None", ROSTER)).toEqual({ kind: "unpinned" });
  });

  it("tier 1: exact full name, case-insensitive", () => {
    expect(matchRosterName("gabrielle mota", ROSTER)).toEqual({
      kind: "pinned",
      name: "Gabrielle Mota"
    });
  });

  it("tier 2: exact first name", () => {
    expect(matchRosterName("Dave", ROSTER)).toEqual({ kind: "pinned", name: "Dave Lane" });
    expect(matchRosterName("jason", ROSTER)).toEqual({ kind: "pinned", name: "Jason Lane" });
  });

  it("tier 3: unique prefix resolves nicknames and partial asks", () => {
    // The Amy scenario: "I want Gabby to have this".
    expect(matchRosterName("Gabby", ROSTER)).toEqual({
      kind: "pinned",
      name: "Gabrielle Mota"
    });
    expect(matchRosterName("Gab", ROSTER)).toEqual({ kind: "pinned", name: "Gabrielle Mota" });
    expect(matchRosterName("Gabrielle M", ROSTER)).toEqual({
      kind: "pinned",
      name: "Gabrielle Mota"
    });
  });

  it("an off-roster name is unresolved, never a guess", () => {
    expect(matchRosterName("Maria", ROSTER)).toEqual({ kind: "unresolved" });
    expect(matchRosterName("Bob", ROSTER)).toEqual({ kind: "unresolved" });
  });

  it("short asks (under 3 chars) never prefix-match", () => {
    expect(matchRosterName("Ga", ROSTER)).toEqual({ kind: "unresolved" });
    expect(matchRosterName("D", ROSTER)).toEqual({ kind: "unresolved" });
  });

  it("ambiguity resolves nothing", () => {
    // Two roster rows with the SAME full name: even an exact ask is ambiguous.
    expect(matchRosterName("Dave Lane", ["Dave Lane", "Dave Lane"])).toEqual({
      kind: "unresolved"
    });
    const twins = ["Gabriela Ruiz", "Gabrielle Mota"];
    expect(matchRosterName("Gab", twins)).toEqual({ kind: "unresolved" });
    // Exact first name that two members share is ambiguous too.
    const daves = ["Dave Lane", "Dave Smith"];
    expect(matchRosterName("Dave", daves)).toEqual({ kind: "unresolved" });
    // A full-name ask still disambiguates the twins.
    expect(matchRosterName("Dave Smith", daves)).toEqual({
      kind: "pinned",
      name: "Dave Smith"
    });
  });

  it("blank roster rows are ignored; empty roster never resolves", () => {
    expect(matchRosterName("Dave", ["  ", ""])).toEqual({ kind: "unresolved" });
    expect(matchRosterName("Dave", [])).toEqual({ kind: "unresolved" });
  });
});
