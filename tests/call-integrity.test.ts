import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_ASSISTANT_TURNS,
  detectCallIntegrity,
  hasRoleLeak,
  looksMachineGenerated
} from "../supabase/functions/_shared/call_integrity.ts";

/**
 * Detection for the two ways a voice call can go wrong that no code check can
 * catch, because both are the model disobeying its prompt.
 *
 * Both signatures are lifted from real calls on Amy Laidlaw's account, not
 * imagined:
 *
 *   role_leak (call 28f9c228, 2026-08-14) - the AI, dropped into a seller's
 *   voicemail, spoke the caller's turns itself. Its own audio transcribed as
 *   "...that's 975 568. Is that correct?user / Correct. I want to sell my
 *   house ASAP.Got it, ASAP. And what's the property address..."
 *
 *   talked_to_recording (call 0f12d4ef, 2026-06-27) - the AI greeted a
 *   looping "Press one to be connected" menu three times and never pressed.
 */

const t = (role: string, content: string) => ({ role, content });

describe("hasRoleLeak", () => {
  it("catches the incident's shape: a role token inside the AI's own speech", () => {
    expect(hasRoleLeak("Is that correct?user\nCorrect. I want to sell my house ASAP.")).toBe(true);
  });

  it("catches a labelled turn however it is punctuated", () => {
    expect(hasRoleLeak("Sure. user: yes please")).toBe(true);
    expect(hasRoleLeak('He said "assistant: hello"')).toBe(true);
    expect(hasRoleLeak("model:\nhello")).toBe(true);
  });

  it("does not fire on the ordinary words in normal speech", () => {
    // These are the false positives that would make the detector ignorable.
    expect(hasRoleLeak("I'll check the user manual for you.")).toBe(false);
    expect(hasRoleLeak("Our assistant will call you back.")).toBe(false);
    expect(hasRoleLeak("That model of home sells fast.")).toBe(false);
    expect(hasRoleLeak("")).toBe(false);
  });
});

describe("looksMachineGenerated", () => {
  it("recognises the menus and greetings from both real calls", () => {
    expect(looksMachineGenerated("Press one to be connected to the client")).toBe(true);
    expect(looksMachineGenerated("To continue recording, press two.")).toBe(true);
    expect(looksMachineGenerated("Please leave a message after the tone")).toBe(true);
    expect(looksMachineGenerated("say hi AT THE BEEP")).toBe(true);
  });

  it("leaves ordinary seller speech alone", () => {
    expect(looksMachineGenerated("Hi, I want to sell my house in Mesa.")).toBe(false);
    expect(looksMachineGenerated("")).toBe(false);
  });
});

describe("detectCallIntegrity", () => {
  it("reports a role leak once, quoting the offending turn", () => {
    const findings = detectCallIntegrity([
      t("caller", "press one to be connected"),
      t("assistant", "Is that correct?user\nCorrect. I want to sell my house ASAP."),
      t("assistant", "And also user: another one")
    ]);
    const leaks = findings.filter((f) => f.kind === "role_leak");
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.detail).toContain("Is that correct?");
  });

  it("never blames the caller's own turn for a role leak", () => {
    // The caller side is a transcription of whatever was on the line. A menu
    // that happens to say "user:" is not our AI misbehaving.
    expect(detectCallIntegrity([t("caller", "user: press one")])).toEqual([]);
  });

  it("reports a conversation held with a recording", () => {
    const findings = detectCallIntegrity([
      t("caller", "Press one to be connected to the client on a recorded line."),
      t("assistant", "Hi, thanks"),
      t("caller", "Press one to be connected to the client."),
      t("assistant", "Hi, thanks for calling Amy Laidlaw Real Estate"),
      t("caller", "Press one to be connected."),
      t("assistant", "Hi, how can I help?")
    ]);
    expect(findings.map((f) => f.kind)).toContain("talked_to_recording");
  });

  it("stays quiet when a human speaks at any point", () => {
    // One real turn means it was not talking to a machine, even if the call
    // opened on an IVR. This is the ordinary HomeLight accept path.
    const findings = detectCallIntegrity([
      t("caller", "Press one to be connected to the client on a recorded line."),
      t("assistant", "Hello, this is Amy Laidlaw's office."),
      t("caller", "Hi yes, I'm looking to sell my place in Mesa."),
      t("assistant", "Great, tell me about it."),
      t("assistant", "What's the address?")
    ]);
    expect(findings.map((f) => f.kind)).not.toContain("talked_to_recording");
  });

  it("stays quiet when the AI said almost nothing to the recording", () => {
    // Pressing a key and waiting is CORRECT behavior on the HomeLight gate.
    // Only a sustained conversation is the failure.
    const findings = detectCallIntegrity([
      t("caller", "Press one to be connected."),
      t("assistant", "Hello?")
    ]);
    expect(findings).toEqual([]);
  });

  it("honours a caller-supplied turn threshold", () => {
    const turns = [
      t("caller", "Press one to be connected."),
      t("assistant", "a"),
      t("assistant", "b")
    ];
    expect(detectCallIntegrity(turns)).toEqual([]);
    expect(detectCallIntegrity(turns, { minAssistantTurns: 2 }).map((f) => f.kind)).toContain(
      "talked_to_recording"
    );
  });

  it("ignores empty and malformed turns without throwing", () => {
    expect(
      detectCallIntegrity([
        { role: null, content: null },
        { role: "assistant", content: "" },
        { role: "caller", content: null }
      ])
    ).toEqual([]);
    expect(detectCallIntegrity([])).toEqual([]);
  });

  it("defaults to three assistant turns", () => {
    expect(DEFAULT_MIN_ASSISTANT_TURNS).toBe(3);
  });
});
