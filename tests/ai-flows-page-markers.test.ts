import { describe, it, expect } from "vitest";
import { classifyPageMarkers } from "../supabase/functions/_shared/ai_flows/page_markers.ts";

/**
 * The rule that decides what a browse step does when the page says it is done.
 *
 * Both browse_extract and browse_action route through this, which is the point:
 * before it existed the same substring check was written out twice with two
 * subtly different sets of page sources, and there was no place for the
 * precedence rule to live.
 */
describe("classifyPageMarkers", () => {
  const ACCEPTED = "<h1>You just accepted your 204th Clever Referral</h1>";
  const CLAIMED = "<p>This referral has already been claimed by another agent.</p>";

  it("returns none when no markers are configured", () => {
    expect(classifyPageMarkers([ACCEPTED], {})).toBe("none");
  });

  it("returns none when a configured marker is absent from the page", () => {
    expect(classifyPageMarkers([ACCEPTED], { skipWhenText: "already been claimed" })).toBe("none");
  });

  it("ends the run on a skipWhenText match", () => {
    expect(classifyPageMarkers([CLAIMED], { skipWhenText: "already been claimed" })).toBe("end_run");
  });

  it("continues the run on a continueWhenText match", () => {
    // The Aug 4 2026 Clever incident: the accept succeeded, so the QT email and
    // the teammate hand-off still need to happen.
    expect(classifyPageMarkers([ACCEPTED], { continueWhenText: "you just accepted your" })).toBe(
      "continue_run"
    );
  });

  it("lets skipWhenText win when both markers match", () => {
    // Doing too little costs a lead a human can still pick up. Doing too much
    // means texting a stranger's lead on their behalf.
    expect(
      classifyPageMarkers([`${CLAIMED}${ACCEPTED}`], {
        skipWhenText: "already been claimed",
        continueWhenText: "you just accepted your"
      })
    ).toBe("end_run");
  });

  it("still fires continueWhenText when only it matches and both are set", () => {
    expect(
      classifyPageMarkers([ACCEPTED], {
        skipWhenText: "already been claimed",
        continueWhenText: "you just accepted your"
      })
    ).toBe("continue_run");
  });

  it("matches case-insensitively in both directions", () => {
    expect(classifyPageMarkers(["ALREADY BEEN CLAIMED"], { skipWhenText: "already been claimed" })).toBe(
      "end_run"
    );
    expect(classifyPageMarkers(["already been claimed"], { skipWhenText: "ALREADY BEEN CLAIMED" })).toBe(
      "end_run"
    );
  });

  it("matches across any of the sources the caller holds", () => {
    // browse_extract passes visible text AND raw HTML: a marker that only
    // survives in the markup still counts.
    expect(
      classifyPageMarkers(["visible text with no marker", CLAIMED], {
        skipWhenText: "already been claimed"
      })
    ).toBe("end_run");
  });

  it("ignores null and undefined sources", () => {
    // browse_action passes readPageSource(...), which is null when the render
    // service returned no page source with the failure.
    expect(classifyPageMarkers([null, undefined], { skipWhenText: "already been claimed" })).toBe(
      "none"
    );
    expect(classifyPageMarkers([null, CLAIMED], { skipWhenText: "already been claimed" })).toBe(
      "end_run"
    );
  });

  it("never fires on a blank or whitespace-only marker", () => {
    // "".includes() is true for every string, so a blank marker would end or
    // short-circuit every run the step touches. The schema rejects empties, so
    // this guards hand-built planner input.
    expect(classifyPageMarkers([ACCEPTED], { skipWhenText: "" })).toBe("none");
    expect(classifyPageMarkers([ACCEPTED], { skipWhenText: "   " })).toBe("none");
    expect(classifyPageMarkers([ACCEPTED], { continueWhenText: "  " })).toBe("none");
  });

  it("trims a padded marker rather than failing to match", () => {
    expect(classifyPageMarkers([CLAIMED], { skipWhenText: "  already been claimed  " })).toBe(
      "end_run"
    );
  });

  it("returns none for an empty source list", () => {
    expect(classifyPageMarkers([], { skipWhenText: "already been claimed" })).toBe("none");
  });
});
