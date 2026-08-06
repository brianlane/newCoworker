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
