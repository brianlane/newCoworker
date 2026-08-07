import { describe, expect, it } from "vitest";
import {
  answeringMachineBadgeLabel,
  verbatimBadgeState
} from "@/lib/voice/transcript-badges";
import { VERBATIM_ALERT_THRESHOLD } from "../supabase/functions/_shared/voice_verbatim";

/**
 * What the call view says about an answering-machine verdict.
 *
 * The distinction these carry is the point of surfacing AMD at all: before it,
 * a call a voicemail picked up and a call a person answered read identically
 * in the dashboard, and an owner reviewing what their assistant did on their
 * behalf could not tell them apart.
 */

describe("answeringMachineBadgeLabel", () => {
  // A badge on every ordinary row would be noise. The interesting fact here is
  // always the exception, so a human answer renders nothing at all.
  it("renders nothing for a human answer or when AMD was not requested", () => {
    expect(answeringMachineBadgeLabel("human", false)).toBeNull();
    expect(answeringMachineBadgeLabel(null, false)).toBeNull();
    expect(answeringMachineBadgeLabel(undefined, false)).toBeNull();
    // "unknown" is Telnyx declining to commit (silence, fax, not_sure). Saying
    // "machine" there would assert something the detection explicitly did not.
    expect(answeringMachineBadgeLabel("unknown", false)).toBeNull();
  });

  // Reaching a voicemail and hanging up is a different thing to have happened
  // to the person on the other end than being left a message.
  it("distinguishes leaving a message from merely reaching a machine", () => {
    expect(answeringMachineBadgeLabel("machine", true)).toBe("Voicemail");
    expect(answeringMachineBadgeLabel("machine", false)).toBe("No answer, machine");
  });

  // An older row predates the column, so a null must not read as "we left one".
  it("treats a missing voicemail flag as no message left", () => {
    expect(answeringMachineBadgeLabel("machine", null)).toBe("No answer, machine");
    expect(answeringMachineBadgeLabel("machine", undefined)).toBe("No answer, machine");
  });
});

describe("verbatimBadgeState", () => {
  it("renders nothing when no message was left", () => {
    expect(verbatimBadgeState(null)).toBeNull();
    expect(verbatimBadgeState(undefined)).toBeNull();
    expect(verbatimBadgeState(NaN)).toBeNull();
  });

  it("reports a whole percentage", () => {
    expect(verbatimBadgeState(1)).toEqual({ percent: 100, drifted: false });
    expect(verbatimBadgeState(0.9234)).toEqual({ percent: 92, drifted: false });
  });

  // A close read is expected and should not draw the eye; a low score is the
  // owner's cue to go read what was actually said on their behalf.
  it("flags drift exactly at the alert threshold", () => {
    expect(verbatimBadgeState(VERBATIM_ALERT_THRESHOLD)?.drifted).toBe(false);
    expect(verbatimBadgeState(VERBATIM_ALERT_THRESHOLD - 0.0001)?.drifted).toBe(true);
    expect(verbatimBadgeState(0)?.drifted).toBe(true);
  });

  // PostgREST serializes a `numeric` column as a STRING. The column is double
  // precision so that should not happen, but a reader that rejected a string
  // would respond by silently never rendering, and a badge that never appears
  // is not a failure anyone notices.
  it("accepts a numeric string, which is how PostgREST returns numeric columns", () => {
    expect(verbatimBadgeState("0.92")).toEqual({ percent: 92, drifted: false });
    expect(verbatimBadgeState("0.10")).toEqual({ percent: 10, drifted: true });
    expect(verbatimBadgeState("not a number")).toBeNull();
    expect(verbatimBadgeState("")).toBeNull();
  });

  // A stored value outside 0-1 would otherwise render "script 130%".
  it("clamps a nonsensical stored score into range", () => {
    expect(verbatimBadgeState(1.3)?.percent).toBe(100);
    expect(verbatimBadgeState(-0.5)?.percent).toBe(0);
  });
});
