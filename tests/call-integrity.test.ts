import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_ASSISTANT_TURNS,
  collectAllowedNumbers,
  detectCallIntegrity,
  callIntegrityAlertSubject,
  extractSpokenNumbers,
  formatCallIntegrityAlert,
  hasRoleLeak,
  looksMachineGenerated,
  spokenNumberForm
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

/**
 * The invented-number rule. Signature from real calls: on 2026-08-26 the AI
 * told a lead to "give us a call back at 480-269-7977" and on 2026-08-27
 * another to call 480-331-9100, numbers belonging to nobody on the account,
 * with the prompt rule against exactly this (PR #1612) verified deployed.
 * Detection replaced a fourth prompt attempt.
 */
describe("spokenNumberForm", () => {
  it("normalises E.164, formatted, and bare forms to one spoken shape", () => {
    expect(spokenNumberForm("+14802697977")).toBe("480-269-7977");
    expect(spokenNumberForm("(480) 269-7977")).toBe("480-269-7977");
    expect(spokenNumberForm("480.269.7977")).toBe("480-269-7977");
    expect(spokenNumberForm("4802697977")).toBe("480-269-7977");
  });

  it("returns null for values that are not North American numbers", () => {
    expect(spokenNumberForm("+85251234567")).toBe(null); // HK: 11 digits, no leading 1
    expect(spokenNumberForm("12345")).toBe(null);
    expect(spokenNumberForm("")).toBe(null);
    expect(spokenNumberForm(null)).toBe(null);
    expect(spokenNumberForm(undefined)).toBe(null);
  });
});

describe("extractSpokenNumbers", () => {
  it("finds numbers however speech transcribes them", () => {
    expect(extractSpokenNumbers("call back at 480-269-7977.")).toEqual(["480-269-7977"]);
    expect(extractSpokenNumbers("that's (602) 695 1142, any time")).toEqual(["602-695-1142"]);
    expect(extractSpokenNumbers("dial +1 480.331.9100 today")).toEqual(["480-331-9100"]);
  });

  it("returns every number, in order, and nothing from plain text", () => {
    expect(extractSpokenNumbers("602-695-1142 or 480-269-7977")).toEqual([
      "602-695-1142",
      "480-269-7977"
    ]);
    expect(extractSpokenNumbers("since 1989, about 500 thousand")).toEqual([]);
    expect(extractSpokenNumbers("")).toEqual([]);
  });
});

describe("collectAllowedNumbers", () => {
  it("collects any phone/e164/did/number-named column from keyed rows", () => {
    const allowed = collectAllowedNumbers({
      phoneKeyedRows: [
        { phone: "+16026951142", name: "Amy Laidlaw" },
        { telnyx_sms_from_e164: "+16028053377", enabled: true },
        { FORWARD_TO_E164: "+14807202013" },
        null,
        undefined
      ]
    });
    expect(allowed).toEqual(new Set(["602-695-1142", "602-805-3377", "480-720-2013"]));
  });

  it("takes bare values and skips ones that do not normalise", () => {
    const allowed = collectAllowedNumbers({ values: ["+16025245719", "not a phone", null] });
    expect(allowed).toEqual(new Set(["602-524-5719"]));
  });

  it("reads flow definitions as E.164 or separated 3-3-4, never bare digit runs", () => {
    const allowed = collectAllowedNumbers({
      flowDefinitions: [
        { voicemailTemplate: "Give us a call back at 602-695-1142." },
        { notifyE164: "+14807039575" },
        // An epoch timestamp is ten digits; matching it would quietly widen
        // the allowlist until fabrications pass. Also covers a null
        // definition, which a half-seeded flow row can hold.
        { scheduledAtMs: 1756224984, raw: "1756224984123" },
        null
      ]
    });
    expect(allowed).toEqual(new Set(["602-695-1142", "480-703-9575"]));
  });

  it("returns an empty set for no sources at all", () => {
    expect(collectAllowedNumbers({})).toEqual(new Set());
  });
});

describe("detectCallIntegrity invented_contact_number", () => {
  const allowed = new Set(["602-695-1142", "320-293-1236"]);

  it("flags the incident's shape: a fabricated callback number in an ad-lib", () => {
    const findings = detectCallIntegrity(
      [t("caller", "may hang up or press one for more options."),
       t("assistant", "If you're still interested, give us a call back at 480-269-7977.")],
      { allowedNumbers: allowed }
    );
    const invented = findings.filter((f) => f.kind === "invented_contact_number");
    expect(invented).toHaveLength(1);
    expect(invented[0]!.detail).toContain("480-269-7977");
    expect(invented[0]!.detail).toContain("give us a call back");
  });

  it("allows the business's own numbers and the parties on the call", () => {
    // The caller's number joins `allowedNumbers` at the call site, so here it
    // is simply part of the set: reading someone their own number back is
    // correct behavior, not fabrication.
    const findings = detectCallIntegrity(
      [t("assistant", "Amy's number is 602-695-1142, and yours ends 320 293 1236, correct?")],
      { allowedNumbers: allowed }
    );
    expect(findings).toEqual([]);
  });

  it("never blames the caller side: a mailbox reading its number is not our AI", () => {
    const findings = detectCallIntegrity(
      [t("caller", "5208586771 is not available. At the tone, please record your message.")],
      { allowedNumbers: allowed }
    );
    expect(findings.map((f) => f.kind)).not.toContain("invented_contact_number");
  });

  it("reports each distinct number once, however often it is repeated", () => {
    const findings = detectCallIntegrity(
      [
        t("assistant", "Call 480-269-7977. Again, that's 480-269-7977."),
        t("assistant", "Or try 480-331-9100.")
      ],
      { allowedNumbers: allowed }
    );
    expect(findings.map((f) => f.detail.slice(6, 18))).toEqual(["480-269-7977", "480-331-9100"]);
  });

  it("does not run at all without an allowlist", () => {
    // An allowlist a caller failed to build must fail toward silence: with no
    // set supplied, a spoken number is not evidence of anything.
    expect(detectCallIntegrity([t("assistant", "call me at 480-269-7977")])).toEqual([]);
  });

  it("clips the quoted turn so one long ramble cannot flood the alert", () => {
    const findings = detectCallIntegrity(
      [t("assistant", `call 480-269-7977 ${"x".repeat(500)}`)],
      { allowedNumbers: allowed }
    );
    expect(findings[0]!.detail.length).toBeLessThan(220);
  });
});

/**
 * Alerting. Findings used to land at `level: "warn"`, which keeps them off
 * the fleet dashboard entirely: `src/lib/db/system-logs.ts` states that feed
 * reads `level = 'error'` only. So a failure showed on one client's page and
 * nowhere else, for something that happens about once every seven weeks.
 * Nobody would ever have looked on the right day.
 *
 * The warn convention exists for a poll that fails once a minute and clears
 * itself on the next run. This is the opposite: daily, deduped, and fired on
 * a call that already went wrong and cannot be retried. It meets that file's
 * own bar for `error`, "a claim that a human should look".
 */
describe("formatCallIntegrityAlert", () => {
  const call = {
    transcriptId: "28f9c228",
    business: "Amy Laidlaw Real Estate",
    caller: "+14159851909",
    startedAt: "2026-08-14T17:26:54Z"
  };

  it("leads with the count so the summary is readable before expanding", () => {
    const text = formatCallIntegrityAlert([
      { ...call, kind: "role_leak", detail: "Is that correct?user Correct." }
    ]);
    expect(text).toContain("1 call-integrity failure");
    expect(text).toContain("Amy Laidlaw Real Estate");
    expect(text).toContain("28f9c228");
  });

  it("pluralises and names each distinct kind", () => {
    const text = formatCallIntegrityAlert([
      { ...call, kind: "role_leak", detail: "a" },
      { ...call, transcriptId: "0f12d4ef", kind: "talked_to_recording", detail: "b" },
      { ...call, transcriptId: "68ca8cdb", kind: "invented_contact_number", detail: "c" }
    ]);
    expect(text).toContain("3 call-integrity failures");
    expect(text).toContain("spoke the caller's side");
    expect(text).toContain("talked to a recording");
    expect(text).toContain("gave out a number it does not own");
  });

  it("caps the body so one bad day cannot post a wall of text", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...call,
      transcriptId: `t${i}`,
      kind: "role_leak" as const,
      detail: "x".repeat(400)
    }));
    const text = formatCallIntegrityAlert(many);
    expect(text.length).toBeLessThan(4000);
    expect(text).toContain("40 call-integrity failures");
    expect(text).toContain("and 30 more");
  });

  it("names an unknown caller and time rather than printing null", () => {
    // Both columns are nullable on voice_call_transcripts, and a call that
    // arrives without caller id is exactly the odd one worth reading.
    const text = formatCallIntegrityAlert([
      { ...call, caller: null, startedAt: null, kind: "role_leak", detail: "x" }
    ]);
    expect(text).toContain("unknown caller");
    expect(text).toContain("unknown time");
    expect(text).not.toContain("null");
  });

  it("returns empty string for no findings, so callers cannot post nothing", () => {
    expect(formatCallIntegrityAlert([])).toBe("");
  });
});

describe("callIntegrityAlertSubject", () => {
  const call = {
    transcriptId: "28f9c228",
    business: "Amy Laidlaw Real Estate",
    caller: "+14159851909",
    startedAt: "2026-08-14T17:26:54Z"
  };

  it("names the tenant when every finding is theirs", () => {
    expect(callIntegrityAlertSubject([{ ...call, kind: "role_leak", detail: "x" }])).toBe(
      "1 call-integrity failure at Amy Laidlaw Real Estate"
    );
  });

  it("drops the tenant name when more than one is involved", () => {
    const s = callIntegrityAlertSubject([
      { ...call, kind: "role_leak", detail: "x" },
      { ...call, business: "Truly Insurance", kind: "talked_to_recording", detail: "y" }
    ]);
    expect(s).toBe("2 call-integrity failures");
  });

  it("is empty for no findings, so nothing can be sent about nothing", () => {
    expect(callIntegrityAlertSubject([])).toBe("");
  });
});
