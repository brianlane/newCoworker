import { describe, it, expect } from "vitest";
import {
  applyForceWhenText,
  classifyBrowseActionFailure,
  classifyPageMarkers,
  isMissingControlError,
  MISSING_CONTROL_ERROR_NEEDLE
} from "../supabase/functions/_shared/ai_flows/page_markers.ts";

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

describe("isMissingControlError", () => {
  it("matches the render-service needle case-insensitively, including wrapped errors", () => {
    expect(MISSING_CONTROL_ERROR_NEEDLE).toBe("no matching control on the page");
    expect(isMissingControlError('click_text "Call me again": no matching control on the page')).toBe(
      true
    );
    expect(isMissingControlError("NO MATCHING CONTROL ON THE PAGE | consoleErrors(7)")).toBe(true);
    expect(isMissingControlError("Timeout 10000ms exceeded")).toBe(false);
  });
});

describe("classifyBrowseActionFailure", () => {
  const MISS = 'click_text "Call me again": no matching control on the page';
  const OVERLAY = "<p>This referral has already been claimed by another agent.</p>";
  const CALLING = "We're calling you at (602) 805-3377";

  it("returns none when the flag is off, even on a missing-control error", () => {
    expect(classifyBrowseActionFailure([OVERLAY], MISS, {})).toBe("none");
    expect(
      classifyBrowseActionFailure([OVERLAY], MISS, { continueWhenMissingControl: false })
    ).toBe("none");
  });

  it("continues on a missing-control error when the flag is on", () => {
    expect(
      classifyBrowseActionFailure([OVERLAY], MISS, { continueWhenMissingControl: true })
    ).toBe("missing_control_continue");
  });

  it("still matches the needle inside the worker's condensed error plus 404 diagnostics", () => {
    const wrapped =
      "browse_action: click_text \"Call me again\": no matching control on the page | " +
      "consoleErrors(7): Failed to load resource: the server responded with a status of 404 ()";
    expect(
      classifyBrowseActionFailure(["<html></html>"], wrapped, { continueWhenMissingControl: true })
    ).toBe("missing_control_continue");
  });

  it("does not treat other action failures as a missing control", () => {
    expect(
      classifyBrowseActionFailure(
        [OVERLAY],
        'click_text "Call me again": Timeout 10000ms exceeded',
        { continueWhenMissingControl: true }
      )
    ).toBe("none");
  });

  it("lets continueWhenText win over the missing-control flag", () => {
    expect(
      classifyBrowseActionFailure([CALLING], MISS, {
        continueWhenText: "We're calling you",
        continueWhenMissingControl: true
      })
    ).toBe("continue_run");
  });

  it("lets skipWhenText win over the missing-control flag", () => {
    expect(
      classifyBrowseActionFailure([OVERLAY], MISS, {
        skipWhenText: "already been claimed",
        continueWhenMissingControl: true
      })
    ).toBe("end_run");
  });
});

describe("applyForceWhenText", () => {
  const UNCLAIMED = "Call me to claim referral";
  const NOT_CONFIRMED = "NOT CONFIRMED, claim by hand now";
  const rule = [{ contains: UNCLAIMED, set: { claim_state: NOT_CONFIRMED } }];

  it("overwrites the model when the unclaimed button is still on the page", () => {
    const page = `<button>Call me to claim referral</button>`;
    const result = applyForceWhenText([page], rule, { claim_state: "Call me again" });
    expect(result.values.claim_state).toBe(NOT_CONFIRMED);
    expect(result.applied).toEqual([UNCLAIMED]);
  });

  it("leaves a real success page alone", () => {
    const page = "We're calling you at Amy's Cell. Call me again";
    const result = applyForceWhenText([page], rule, { claim_state: "HomeLight is calling our line" });
    expect(result.values.claim_state).toBe("HomeLight is calling our line");
    expect(result.applied).toEqual([]);
  });

  it("returns the values unchanged when no rules are configured", () => {
    const result = applyForceWhenText(["Call me to claim referral"], undefined, { claim_state: "kept" });
    expect(result.values.claim_state).toBe("kept");
    expect(result.applied).toEqual([]);
  });

  it("lets a later matching rule overwrite an earlier one", () => {
    const result = applyForceWhenText(
      ["Call me to claim referral and We're calling you"],
      [
        { contains: "Call me to claim referral", set: { claim_state: "first" } },
        { contains: "We're calling you", set: { claim_state: "second" } }
      ],
      { claim_state: "model" }
    );
    expect(result.values.claim_state).toBe("second");
    expect(result.applied).toEqual(["Call me to claim referral", "We're calling you"]);
  });

  it("ignores a blank phrase", () => {
    const result = applyForceWhenText(["Call me to claim referral"], [{ contains: "  ", set: { claim_state: "x" } }], {
      claim_state: "kept"
    });
    expect(result.values.claim_state).toBe("kept");
    expect(result.applied).toEqual([]);
  });
});
