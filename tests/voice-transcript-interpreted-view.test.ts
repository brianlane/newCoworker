import { describe, expect, it } from "vitest";
import { forwardedCallNotice, turnSpeaker } from "@/lib/voice/transcript-badges";

/**
 * What the call view is allowed to CLAIM about a transferred call.
 *
 * Both claims it used to make were wrong on an interpreted call (found on Amy
 * Laidlaw's call 5634b7f0, 2026-08-18):
 *
 *   - the banner said "Only the conversation before the transfer is transcribed
 *     below", while six of that call's fourteen turns happened after it,
 *   - every one of those turns was labelled CALLER, when the teammate who had
 *     just picked up was almost certainly the one saying "Hello. Hello.".
 *
 * The second is not a labelling oversight, it is a limit: Telnyx's both_tracks
 * fork feeds both humans into one Gemini input stream, so after the bridge the
 * platform genuinely cannot tell them apart. The fix is to stop claiming it
 * can.
 */
describe("forwardedCallNotice", () => {
  it("says nothing at all for a call that was never forwarded", () => {
    expect(forwardedCallNotice({ callKind: null, status: "completed", turnCount: 8 })).toBeNull();
  });

  it("reports a transfer nobody answered", () => {
    expect(
      forwardedCallNotice({ callKind: "forwarded", status: "missed", turnCount: 0 })
    ).toBe("missed");
  });

  it("reports a straight forward with no AI conversation", () => {
    expect(
      forwardedCallNotice({ callKind: "forwarded", status: "completed", turnCount: 0 })
    ).toBe("noTranscript");
  });

  it("keeps today's wording when the AI left at the transfer", () => {
    expect(
      forwardedCallNotice({ callKind: "forwarded", status: "completed", turnCount: 8 })
    ).toBe("transferred");
  });

  it("says the AI stayed on when it interpreted", () => {
    // The one case where the old copy actively misled: the conversation after
    // the transfer IS below, and the owner should know the AI was in it.
    expect(
      forwardedCallNotice({
        callKind: "forwarded",
        status: "completed",
        turnCount: 14,
        interpretedFromTurnIndex: 7
      })
    ).toBe("interpreted");
  });

  it("treats turn index 0 as interpreting, not as absent", () => {
    // A falsy-check on the index would classify the earliest possible
    // interpretation as an ordinary transfer.
    expect(
      forwardedCallNotice({
        callKind: "forwarded",
        status: "completed",
        turnCount: 3,
        interpretedFromTurnIndex: 0
      })
    ).toBe("interpreted");
  });
});

describe("turnSpeaker", () => {
  it("labels the assistant and the caller on an ordinary call", () => {
    expect(turnSpeaker({ role: "assistant", turnIndex: 0 })).toBe("assistant");
    expect(turnSpeaker({ role: "caller", turnIndex: 1 })).toBe("caller");
  });

  it("still names the caller before interpreting began", () => {
    expect(
      turnSpeaker({ role: "caller", turnIndex: 3, interpretedFromTurnIndex: 7 })
    ).toBe("caller");
  });

  it("stops naming the caller once both humans share one audio track", () => {
    expect(
      turnSpeaker({ role: "caller", turnIndex: 8, interpretedFromTurnIndex: 7 })
    ).toBe("callerOrTeammate");
    expect(
      turnSpeaker({ role: "caller", turnIndex: 7, interpretedFromTurnIndex: 7 })
    ).toBe("callerOrTeammate");
  });

  it("never relabels our own speech, which is never ambiguous", () => {
    // The assistant turns are our own audio: we know exactly who said them.
    expect(
      turnSpeaker({ role: "assistant", turnIndex: 9, interpretedFromTurnIndex: 7 })
    ).toBe("assistant");
  });
});
