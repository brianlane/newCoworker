import { describe, expect, it } from "vitest";
import {
  createSpokenNumberGuard,
  extractSpokenNumbers,
  GUARD_MAX_CUES,
  GUARD_TURN_TAIL_CHARS,
  NUMBER_SUPPRESSED_CUE,
  spokenNumberForm
} from "../vps/voice-bridge/src/spoken-number-guard";

/**
 * The call-time firewall for spoken phone numbers. Its allowlist is the
 * NO_INVENTED_CONTACT_LINE prompt rule made mechanical: a number is
 * legitimate when the bridge gave it to the model or the caller said it, and
 * anything else the model speaks is by construction fabricated. Fixture
 * numbers are the real fabrications from Amy Laidlaw's calls.
 */
describe("spokenNumberForm / extractSpokenNumbers", () => {
  it("normalizes every phone-ish shape to spoken 3-3-4 form", () => {
    expect(spokenNumberForm("+16026951142")).toBe("602-695-1142");
    expect(spokenNumberForm("(480) 400-0588")).toBe("480-400-0588");
    expect(spokenNumberForm("480.400.0588")).toBe("480-400-0588");
    expect(spokenNumberForm("16024005880")).toBe("602-400-5880");
    expect(spokenNumberForm("not a number")).toBeNull();
    expect(spokenNumberForm("12345")).toBeNull();
    expect(spokenNumberForm(null)).toBeNull();
  });

  it("finds numbers in transcribed speech, separated or bare", () => {
    expect(extractSpokenNumbers("call us back at 480-400-0588. Thanks!")).toEqual([
      "480-400-0588"
    ]);
    expect(extractSpokenNumbers("reach me at 4804000588 anytime")).toEqual(["480-400-0588"]);
    expect(extractSpokenNumbers("that's +1 (602) 695 1142, got it")).toEqual(["602-695-1142"]);
    expect(extractSpokenNumbers("no numbers here")).toEqual([]);
  });
});

describe("createSpokenNumberGuard", () => {
  it("flags a number nothing on the call supplied, once per call", () => {
    const guard = createSpokenNumberGuard();
    const first = guard.noteAssistantText("please call us back at 480-400-0588. Thanks!");
    expect(first).toHaveLength(1);
    expect(first[0]!.number).toBe("480-400-0588");
    // Repeats of the SAME number never re-fire: one violation per distinct
    // number per call, mirroring the daily sweep's one-finding rule.
    guard.endAssistantTurn();
    expect(guard.noteAssistantText("again, 480-400-0588")).toEqual([]);
    expect(guard.suppressedNumbers()).toEqual(["480-400-0588"]);
  });

  it("allows numbers seeded from instructions and materials, in any format", () => {
    const guard = createSpokenNumberGuard();
    guard.allowText("Give us a call back at 602-695-1142. Thanks.");
    guard.allowNumber("+14805770534");
    expect(guard.noteAssistantText("call us at (602) 695-1142")).toEqual([]);
    expect(guard.noteAssistantText("your number ending 480 577 0534, correct?")).toEqual([]);
    expect(guard.suppressedNumbers()).toEqual([]);
  });

  it("allows a number the caller just said (repeating back is legitimate)", () => {
    const guard = createSpokenNumberGuard();
    guard.noteCallerText("my cell is 480-256-2580");
    expect(guard.noteAssistantText("got it, 480-256-2580, is that right?")).toEqual([]);
  });

  it("assembles a number split across transcription fragments", () => {
    const guard = createSpokenNumberGuard();
    expect(guard.noteAssistantText("call us back at 480-4")).toEqual([]);
    const v = guard.noteAssistantText("00-0588, thanks");
    expect(v.map((x) => x.number)).toEqual(["480-400-0588"]);
  });

  it("resets the turn buffer at turn end so unrelated turns cannot join digits", () => {
    const guard = createSpokenNumberGuard();
    // Joined, these two fragments would read as 480-400-0588 (the split-
    // fragment test above proves the concatenation fires WITHIN a turn); the
    // turn boundary is what must keep them apart.
    guard.noteAssistantText("the extension is 480-4");
    guard.endAssistantTurn();
    expect(guard.noteAssistantText("00-0588 is the code")).toEqual([]);
  });

  it("ignores empty and non-string input everywhere", () => {
    const guard = createSpokenNumberGuard();
    guard.allowText(null);
    guard.allowText(undefined);
    guard.allowText("");
    guard.allowNumber(undefined);
    guard.noteCallerText(null);
    expect(guard.noteAssistantText(null)).toEqual([]);
    expect(guard.noteAssistantText(undefined)).toEqual([]);
    expect(guard.noteAssistantText("")).toEqual([]);
  });

  it("bounds the turn buffer while still catching a number at the tail", () => {
    const guard = createSpokenNumberGuard();
    const filler = "so anyway ".repeat(GUARD_TURN_TAIL_CHARS / 5);
    const v = guard.noteAssistantText(filler + "call 480-331-9100 now");
    expect(v.map((x) => x.number)).toEqual(["480-331-9100"]);
  });

  it("does not read street addresses, zips, or prices as phone numbers", () => {
    const guard = createSpokenNumberGuard();
    expect(
      guard.noteAssistantText(
        "the home at 859 W Desert Seasons Dr in 85143 listed at $385,000 in 2026"
      )
    ).toEqual([]);
  });
});

describe("guard cue constants", () => {
  it("the correction cue never contains digits the model could parrot back", () => {
    expect(extractSpokenNumbers(NUMBER_SUPPRESSED_CUE)).toEqual([]);
    expect(NUMBER_SUPPRESSED_CUE.startsWith("[Coordinator]")).toBe(true);
  });

  it("cues are bounded", () => {
    expect(GUARD_MAX_CUES).toBeGreaterThan(0);
    expect(GUARD_MAX_CUES).toBeLessThanOrEqual(3);
  });
});
