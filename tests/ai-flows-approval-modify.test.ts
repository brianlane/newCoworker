/**
 * The answer Brian actually sends.
 *
 * An approval gate offers numbered options, which cannot express a pick PLUS
 * a change. From the session that produced this feature, verbatim:
 *
 *   "Yes but shortened (option 3) but don't track link clicks for
 *    owner/employees"
 *
 * Today that text falls past the gate entirely and lands in the owner's
 * operator turn, which does not know a run is parked. The draft sits waiting
 * forever and the owner gets a conversational reply about something else.
 *
 * The pieces under test are the PURE ones the SMS webhook and the worker both
 * import, so the contract holds identically on both sides:
 *   - `approvalModifyForReply` decides whether a reply is a modification;
 *   - the stored-approval parser round-trips the rewind target the worker
 *     persisted at park time.
 *
 * The rewind target rides on `context.approval` for the same reason the option
 * list does (approval_options.ts): the webhook must read what the owner was
 * ACTUALLY offered, not what today's code would build, so a deploy in the
 * middle of an approval cannot reinterpret a reply.
 */
import { describe, expect, it } from "vitest";

import {
  RESUME_STEP_ID_VAR,
  resolveResumeIndex,
  withResumeMarkerVar
} from "../supabase/functions/_shared/ai_flows/branching";

import {
  approvalModifyForReply,
  approvalOptionForReply,
  parseStoredApprovalOptions,
  parseStoredRedraftStepIndex,
  type ApprovalGateOption
} from "../supabase/functions/_shared/ai_flows/approval_options";

const OFFERED: ApprovalGateOption[] = ["approve", "skip", "cancel"];

describe("a modification is recognized only when the gate offered one", () => {
  it("takes free text as a modification when a rewind target was stored", () => {
    expect(approvalModifyForReply(2, "shorter, and drop the second paragraph")).toEqual({
      redraftStepIndex: 2,
      note: "shorter, and drop the second paragraph"
    });
  });

  it("takes Brian's actual reply shape", () => {
    const reply = "Yes but shortened but don't track link clicks for owner/employees";
    expect(approvalModifyForReply(0, reply)).toEqual({ redraftStepIndex: 0, note: reply });
  });

  it("refuses when the gate stored no rewind target", () => {
    // A gate without allowModify must keep behaving exactly as it does today:
    // free text falls through to the surfaces below it.
    expect(approvalModifyForReply(null, "shorter please")).toBeNull();
  });

  it("never swallows a bare digit, which belongs to the option list", () => {
    // The digit vocabulary is globally ordered and fully allocated (1/2 claim
    // and pass, 86 unclaim, 1..N the gate). A modify branch that ate "2"
    // would silently break every existing approval.
    for (const digit of ["1", "2", "3", "12", " 2 "]) {
      expect(approvalModifyForReply(1, digit), digit).toBeNull();
    }
    expect(approvalOptionForReply(OFFERED, "2")).toBe("skip");
  });

  it("refuses an empty or whitespace-only reply", () => {
    for (const blank of ["", "   ", "\n"]) {
      expect(approvalModifyForReply(1, blank), JSON.stringify(blank)).toBeNull();
    }
  });

  it("trims the note, so the redraft prompt gets no stray whitespace", () => {
    expect(approvalModifyForReply(1, "  make it shorter  ")?.note).toBe("make it shorter");
  });
});

describe("the rewind target survives the round trip through the run", () => {
  it("reads back an index the worker stored", () => {
    expect(parseStoredRedraftStepIndex(3)).toBe(3);
    expect(parseStoredRedraftStepIndex(0)).toBe(0);
  });

  it("rejects anything that is not a usable step index", () => {
    // A malformed value must disable modification rather than rewinding to a
    // step that does not exist, which would park the run with nothing able to
    // resume it.
    for (const bad of [undefined, null, -1, 1.5, "2", {}, [], NaN]) {
      expect(parseStoredRedraftStepIndex(bad), JSON.stringify(bad ?? null)).toBeNull();
    }
  });

  it("leaves the option list parsing untouched", () => {
    // Guards the regression this change could cause: the two values share one
    // context object, and the digit path must keep resolving exactly as before.
    expect(parseStoredApprovalOptions(["approve", "skip", "cancel"])).toEqual(OFFERED);
    expect(approvalOptionForReply(parseStoredApprovalOptions(undefined), "1")).toBe("approve");
  });
});

describe("the rewind actually relocates the run", () => {
  /**
   * The gate parked, so `vars.__resume_step_id` names the GATE.
   * `resolveResumeIndex` follows that marker in preference to the stored
   * index, so a rewind that only moves `current_step` resumes straight back
   * onto the gate: the drafting step never re-runs and the owner's note is
   * ignored, while the ack still says "redoing that with your changes".
   *
   * Silent, and the reason `withResumeMarkerVar` exists for external writers
   * (goal jumps, route-claim rewinds). This pins that the modify rewind is
   * one of them.
   */
  const FLAT = [
    { step: { id: "s_draft", type: "run_agent" } },
    { step: { id: "s_gate", type: "approval_gate" } },
    { step: { id: "s_send", type: "send_email" } }
  ] as never;

  it("follows a re-pointed marker to the redraft step, not back to the gate", () => {
    const parked = { vars: { [RESUME_STEP_ID_VAR]: "s_gate" } };
    // Before: current_step says 0, but the marker still says the gate.
    expect(resolveResumeIndex(FLAT, 0, "s_gate")).toBe(1);
    // After withResumeMarkerVar re-points it, the rewind lands on the drafter.
    const rewound = withResumeMarkerVar(parked, "s_draft");
    const marker = (rewound.vars as Record<string, unknown>)[RESUME_STEP_ID_VAR];
    expect(resolveResumeIndex(FLAT, 0, marker as string)).toBe(0);
  });

  it("relocates by ID, so the rewind survives a reordered flow", () => {
    // The marker is why parked runs tolerate step insertions. A rewind that
    // cleared it instead of re-pointing would give that up.
    const shifted = [{ step: { id: "s_new", type: "notify_owner" } }, ...FLAT] as never;
    expect(resolveResumeIndex(shifted, 0, "s_draft")).toBe(1);
  });
});
