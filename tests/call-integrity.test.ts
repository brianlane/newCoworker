import { describe, expect, it } from "vitest";
import {
  AMOUNT_MATCH_TOLERANCE,
  DEFAULT_MIN_ASSISTANT_TURNS,
  MIN_REPORTABLE_AMOUNT,
  amountIsSourced,
  callerAmounts,
  collectAllowedNumbers,
  detectCallIntegrity,
  callIntegrityAlertSubject,
  clipAlertDetail,
  clipOnWordBoundary,
  extractSpokenNumbers,
  formatCallIntegrityAlert,
  hasRoleLeak,
  isUnheardAssistantTurn,
  kindPhrase,
  isAcceptPrompt,
  looksMachineGenerated,
  partitionBlockedFindings,
  spokenAmounts,
  spokenNumberForm
} from "../supabase/functions/_shared/call_integrity.ts";

/**
 * Detection for the ways a voice call can go wrong that no code check can
 * catch, because each is either the model disobeying its prompt or a partner
 * refusing us silently.
 *
 * Every signature is lifted from a real call on Amy Laidlaw's account, not
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
    //
    // This asserted `toEqual([])` until gate_never_cleared shipped, which was
    // shorthand for "talked_to_recording does not fire" back when it was the
    // only rule this fixture could trip. The fixture ENDS on the partner's
    // accept prompt, so it is also a call that never took the referral, and
    // the new rule is right to say so. The original intent is what is pinned
    // here; the companion case below pins the new finding deliberately.
    const findings = detectCallIntegrity([
      t("caller", "Press one to be connected."),
      t("assistant", "Hello?")
    ]);
    expect(findings.map((f) => f.kind)).not.toContain("talked_to_recording");
  });

  it("honours a caller-supplied turn threshold", () => {
    const turns = [
      t("caller", "Press one to be connected."),
      t("assistant", "a"),
      t("assistant", "b")
    ];
    // Same premise change as above: this fixture ends on the accept prompt,
    // so gate_never_cleared fires either way and only the threshold-driven
    // finding is what this test is about.
    expect(detectCallIntegrity(turns).map((f) => f.kind)).not.toContain("talked_to_recording");
    expect(detectCallIntegrity(turns, { minAssistantTurns: 2 }).map((f) => f.kind)).toContain(
      "talked_to_recording"
    );
  });

  it("does not count [Muted] or [Voicemail] assistant turns as a conversation", () => {
    // Sep 1 2026 call 9b03d39d (Jon, Amy Laidlaw). The email named three
    // assistant turns against two machine caller turns. Only "Hi Jon," was
    // heard: the model turn was muted, the badge is code-written.
    const findings = detectCallIntegrity([
      t("caller", "Hi, you've reached Jon. Please leave a message after the tone."),
      t("assistant", "Hi Jon,"),
      t("caller", "I couldn't hear you. To continue recording, press two."),
      t(
        "assistant",
        "[Muted] This is Amy Laidlaw Real Estate's office, calling about your inquiry."
      ),
      t("assistant", "[Voicemail] Hi Jon, this is Amy Laidlaw with Amy Laidlaw Real Estate.")
    ]);
    expect(findings.map((f) => f.kind)).not.toContain("talked_to_recording");
  });

  it("does not blame muted or badge turns for a leaked role or invented number", () => {
    const findings = detectCallIntegrity(
      [
        t("caller", "hello"),
        t("assistant", "[Muted] Is that correct?user\nCorrect."),
        t("assistant", "[Voicemail] Call us back at 480-269-7977.")
      ],
      { allowedNumbers: new Set(["6026951142"]) }
    );
    expect(findings.map((f) => f.kind)).not.toContain("role_leak");
    expect(findings.map((f) => f.kind)).not.toContain("invented_contact_number");
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

describe("isUnheardAssistantTurn", () => {
  it("names the two prefixes the lead never heard", () => {
    expect(isUnheardAssistantTurn("[Voicemail] script")).toBe(true);
    expect(isUnheardAssistantTurn("[Muted] chatter")).toBe(true);
    expect(isUnheardAssistantTurn("  [Muted] still")).toBe(true);
    expect(isUnheardAssistantTurn("Hi Jon,")).toBe(false);
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

  it("carries the offending number as a structured field, in spoken 3-3-4 form", () => {
    // The sweep matches this against the bridge's suppressed-number record;
    // parsing it back out of `detail` would couple the match to prose.
    const findings = detectCallIntegrity(
      [t("assistant", "call us at (480) 400-0588 today")],
      { allowedNumbers: allowed }
    );
    expect(findings[0]!.number).toBe("480-400-0588");
  });
});

describe("partitionBlockedFindings", () => {
  const invented = (number: string): ReturnType<typeof detectCallIntegrity>[number] => ({
    kind: "invented_contact_number",
    number,
    detail: `spoke ${number}`
  });

  it("moves a suppressed number to blocked and leaves the rest as failures", () => {
    const findings = [invented("480-400-0588"), invented("480-331-9100")];
    const { failures, blocked } = partitionBlockedFindings(findings, ["480-400-0588"]);
    expect(blocked.map((f) => f.number)).toEqual(["480-400-0588"]);
    expect(failures.map((f) => f.number)).toEqual(["480-331-9100"]);
  });

  it("normalizes the bridge's record defensively: any phone-ish shape matches", () => {
    const { blocked } = partitionBlockedFindings(
      [invented("480-400-0588")],
      ["+14804000588", "garbage", 42, null]
    );
    expect(blocked).toHaveLength(1);
  });

  it("treats a missing or malformed record as nothing blocked", () => {
    const findings = [invented("480-400-0588")];
    expect(partitionBlockedFindings(findings, null).failures).toHaveLength(1);
    expect(partitionBlockedFindings(findings, undefined).failures).toHaveLength(1);
    expect(partitionBlockedFindings(findings, "480-400-0588").failures).toHaveLength(1);
    expect(partitionBlockedFindings(findings, {}).failures).toHaveLength(1);
  });

  it("only invented_contact_number findings can be blocked", () => {
    // A role leak on a call that also had a suppression must still page: the
    // guard cut a number, never the leak.
    const leak = { kind: "role_leak" as const, detail: "user: yes" };
    const { failures, blocked } = partitionBlockedFindings([leak], ["480-400-0588"]);
    expect(failures).toEqual([leak]);
    expect(blocked).toEqual([]);
  });

  it("a number finding without the structured field stays a failure", () => {
    const bare = { kind: "invented_contact_number" as const, detail: "spoke 480-400-0588" };
    const { failures, blocked } = partitionBlockedFindings([bare], ["480-400-0588"]);
    expect(failures).toEqual([bare]);
    expect(blocked).toEqual([]);
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
    expect(text.length).toBeLessThan(8000);
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

  it("keeps the Sep 1 talked_to_recording detail intact instead of clipping mid-word", () => {
    const detail =
      "3 assistant turns against 2 machine-sounding caller turns, e.g. " +
      '"Hi, you\'ve reached Jon. Please leave a message after the tone or pre-record."';
    const text = formatCallIntegrityAlert([
      {
        ...call,
        transcriptId: "9b03d39d-7b2c-4a1e-a02d-76e8c8482c30",
        kind: "talked_to_recording",
        detail
      }
    ]);
    expect(text).toContain("or pre-record");
    expect(text).not.toMatch(/or pre"/);
  });
});

describe("clipAlertDetail", () => {
  it("cuts on a word boundary and closes an open quote", () => {
    const detail =
      '3 assistant turns against 2 machine-sounding caller turns, e.g. "Hi, you\'ve reached Jon. Please leave a message after the tone or pre-record your name and number for a callback."';
    const clipped = clipAlertDetail(detail, 160);
    expect(clipped.endsWith('"')).toBe(true);
    expect(clipped).toContain("...");
    expect(clipped).not.toMatch(/or pre$/);
    expect(clipped.includes("pre-record") || clipped.includes("...")).toBe(true);
  });

  it("leaves a short detail alone", () => {
    expect(clipOnWordBoundary("short", 160)).toBe("short");
    expect(clipAlertDetail("no quotes here", 160)).toBe("no quotes here");
  });

  it("clips a single long token without searching for a space", () => {
    expect(clipOnWordBoundary("x".repeat(50), 10)).toBe(`${"x".repeat(7)}...`);
  });

  it("strips trailing punctuation before the ellipsis", () => {
    expect(clipOnWordBoundary("Hello, world extra words here", 12)).toBe("Hello...");
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

/**
 * gate_never_cleared (call 3578b1a7, 2026-07-30).
 *
 * A HomeLight live transfer opened on the partner's accept menu, the accept
 * digit never landed, and the partner repeated "press one to agree" TEN times
 * before the call ended. Nothing reported it: the AI behaved perfectly, so
 * every other rule stayed silent, and the $800K referral was simply lost.
 *
 * The strings below are verbatim last-caller-turns from real calls. The two
 * mailbox menus are the whole reason the rule is written the way it is: both
 * come from transfers that CONNECTED, and both contain "press one".
 */
describe("detectCallIntegrity: the partner never let us in", () => {
  const ACCEPT_FEE =
    "Press one to agree to our referral fee specified in the referral agreement " +
    "and to be connected to the client on a recorded line.";
  const ACCEPT_CONNECT = "Press one to be connected to the client on a recorded line.";

  it("reports a call that ended on the partner's accept prompt", () => {
    const findings = detectCallIntegrity([
      t("caller", "Our client, Dera H, would like to sell a single family home in 85213."),
      t("caller", ACCEPT_FEE),
      t("caller", ACCEPT_FEE)
    ]);
    const gate = findings.find((f) => f.kind === "gate_never_cleared");
    expect(gate).toBeDefined();
    expect(gate!.detail).toContain("still asking us to accept");
  });

  it("recognises both partner wordings", () => {
    expect(isAcceptPrompt(ACCEPT_FEE)).toBe(true);
    expect(isAcceptPrompt(ACCEPT_CONNECT)).toBe(true);
  });

  it("covers a rewording HomeLight has not used yet", () => {
    // The two errors do not cost the same. An unmatched rewording turns the
    // rule silently off and loses a referral exactly the way the incident
    // did; an extra verb costs one line in a digest a human reads.
    expect(isAcceptPrompt("Press 1 to accept this referral.")).toBe(true);
    // The keypress and the same-sentence window still have to hold.
    expect(isAcceptPrompt("We accept referrals. Press one.")).toBe(false);
  });

  /**
   * The false-positive that would have muted this rule. Both of these ended
   * calls that reached the seller (28f9c228 and dbd44742): the AI was put
   * through, hit a mailbox, and the mailbox offered its own keypad options.
   * Reporting these as lost referrals would have made the digest untrustworthy
   * within a week.
   */
  it("never mistakes a voicemail keypad menu for the accept prompt", () => {
    const menus = [
      "Replay your message. Press one. To continue recording, press two.",
      "To review, re-record or add to your message, press one. To mark your " +
        "message urgent, press two. To mark your message private, press three.",
      "You have reached the maximum time permitted for recording your message."
    ];
    for (const menu of menus) expect(isAcceptPrompt(menu)).toBe(false);
  });

  it("stays quiet when the partner connected us", () => {
    const findings = detectCallIntegrity([
      t("caller", ACCEPT_FEE),
      t("caller", "Connecting you now. Say hi at the beep."),
      t("assistant", "Hi, this is Amy Laidlaw's office with HomeSmart.")
    ]);
    expect(findings.map((f) => f.kind)).not.toContain("gate_never_cleared");
  });

  it("stays quiet on a call with no caller side at all", () => {
    const findings = detectCallIntegrity([t("assistant", "Hello, anyone there?")]);
    expect(findings.map((f) => f.kind)).not.toContain("gate_never_cleared");
  });

  it("names the lost referral rather than blaming the model", () => {
    const body = formatCallIntegrityAlert([
      {
        kind: "gate_never_cleared",
        detail: "d",
        transcriptId: "3578b1a7",
        business: "Amy Laidlaw Real Estate",
        caller: "+14159851909",
        startedAt: "2026-07-30T17:03:28Z"
      }
    ]);
    expect(body).toContain("the referral was lost");
  });
});

/**
 * invented_amount (call 60a64ddd, 2026-08-20).
 *
 * "Clever offered you a cash offer program, and the offers on your file are
 * 375k and 395k." The real offers were $320,097, $342,000 and $325,000, and
 * they arrived four minutes after the call ended.
 */
describe("detectCallIntegrity: figures nothing gave it", () => {
  const INCIDENT =
    "Great, so, Clever offered you a cash offer program, and the offers on " +
    "your file are 375k and 395k.";

  it("reports every distinct unsourced amount in the incident turn", () => {
    const turns = [t("caller", "Sure."), t("assistant", INCIDENT)];
    const kinds = detectCallIntegrity(turns, { allowedAmounts: callerAmounts(turns) });
    const amounts = kinds.filter((f) => f.kind === "invented_amount");
    expect(amounts).toHaveLength(2);
    expect(amounts[0]!.detail).toContain("$375,000");
    expect(amounts[1]!.detail).toContain("$395,000");
  });

  it("ignores a muted turn that would otherwise look invented", () => {
    const turns = [t("caller", "Sure."), t("assistant", `[Muted] ${INCIDENT}`)];
    const findings = detectCallIntegrity(turns, { allowedAmounts: callerAmounts(turns) });
    expect(findings.map((f) => f.kind)).not.toContain("invented_amount");
  });

  it("stays quiet when the caller supplied the figure", () => {
    const turns = [
      t("caller", "I'm hoping to get around $425,000 for it."),
      t("assistant", "Got it, $425,000 is the target.")
    ];
    const findings = detectCallIntegrity(turns, { allowedAmounts: callerAmounts(turns) });
    expect(findings.map((f) => f.kind)).not.toContain("invented_amount");
  });

  it("allows rounding a sourced figure aloud", () => {
    // "about 438" for $437,900 is the same fact, and reporting it would be a
    // false positive. HomeLight's own announcement reads the exact figure and
    // a person answers in round numbers.
    const turns = [
      t("caller", "The home is listed at $437,900."),
      t("assistant", "So roughly 438k, understood.")
    ];
    const findings = detectCallIntegrity(turns, { allowedAmounts: callerAmounts(turns) });
    expect(findings.map((f) => f.kind)).not.toContain("invented_amount");
  });

  it("reports one finding per amount however often it is repeated", () => {
    const turns = [
      t("assistant", "The offer is 375k."),
      t("assistant", "As I said, 375k.")
    ];
    const findings = detectCallIntegrity(turns, { allowedAmounts: new Set<number>() });
    expect(findings.filter((f) => f.kind === "invented_amount")).toHaveLength(1);
  });

  it("does not run at all without an allowlist, so a caller cannot half-enable it", () => {
    const findings = detectCallIntegrity([t("assistant", INCIDENT)]);
    expect(findings.map((f) => f.kind)).not.toContain("invented_amount");
  });

  it("ignores what the caller said when deciding what the AI invented", () => {
    // The assistant's own turns are not a source: a figure repeated by the
    // speaker that invented it would otherwise launder itself.
    const turns = [t("assistant", "375k."), t("caller", "Okay, 375k then.")];
    expect(callerAmounts(turns).has(375_000)).toBe(true);
    expect(callerAmounts([t("assistant", "375k.")]).size).toBe(0);
  });

  it("skips a turn whose content is not a string", () => {
    expect(callerAmounts([{ role: "caller", content: null }]).size).toBe(0);
  });

  it("names the failure in the alert body", () => {
    const body = formatCallIntegrityAlert([
      {
        kind: "invented_amount",
        detail: "d",
        transcriptId: "60a64ddd",
        business: "Amy Laidlaw Real Estate",
        caller: "+16028752869",
        startedAt: "2026-08-20T22:59:52Z"
      }
    ]);
    expect(body).toContain("quoted a figure nothing gave it");
  });
});

describe("spokenAmounts", () => {
  it("reads the forms a person actually says", () => {
    expect(spokenAmounts("375k and 395k")).toEqual([375_000, 395_000]);
    expect(spokenAmounts("$425,000.00")).toEqual([425_000]);
    expect(spokenAmounts("$1.2M")).toEqual([1_200_000]);
    expect(spokenAmounts("they want 437,900")).toEqual([437_900]);
  });

  it("needs something to say it is money, so bare digit runs are not amounts", () => {
    // On a real-estate call the bare runs are zips, street numbers and years.
    expect(spokenAmounts("a home in 85205 at 4046 East Camino, built 1998")).toEqual([]);
  });

  it("does not read the m of a word as millions", () => {
    // Call 12f073e0, 2026-08-12: "timeframe:9 months" scored as $9,000,000
    // until the trailing lookahead landed.
    expect(spokenAmounts("timeframe:9 months")).toEqual([]);
    expect(spokenAmounts("call back in 20 minutes")).toEqual([]);
  });

  it("keeps a sentence-ending full stop from hiding the last figure", () => {
    // An earlier draft blocked "." after the suffix and found only the first
    // of the incident's two figures.
    expect(spokenAmounts("the offers are 375k and 395k.")).toEqual([375_000, 395_000]);
  });

  it("drops amounts below the reportable floor", () => {
    expect(MIN_REPORTABLE_AMOUNT).toBe(10_000);
    // An $89 tune-up and a $250 callout are legitimate and frequent.
    expect(spokenAmounts("that's $89, or $250 for the callout")).toEqual([]);
    expect(spokenAmounts("$9,999 and $10,000")).toEqual([10_000]);
  });

  it("refuses a digit run too large to be a number", () => {
    const absurd = "1" + ",000".repeat(120);
    expect(spokenAmounts(absurd)).toEqual([]);
  });

  it("does not read a number glued to letters as money", () => {
    expect(spokenAmounts("unit A4046")).toEqual([]);
  });
});

describe("amountIsSourced", () => {
  it("matches inside the tolerance and not outside it", () => {
    expect(AMOUNT_MATCH_TOLERANCE).toBe(0.02);
    expect(amountIsSourced(438_000, new Set([437_900]))).toBe(true);
    // The incident: 375k against the briefed $425,000 is 11.8% out.
    expect(amountIsSourced(375_000, new Set([425_000]))).toBe(false);
  });

  it("is false against an empty source set", () => {
    expect(amountIsSourced(375_000, new Set())).toBe(false);
  });
});

/**
 * One phrase source for both readers.
 *
 * The alert email and the per-tenant `system_logs` row the fleet dashboard
 * reads used to build their wording separately, and the sweep's copy was a
 * chained ternary that ENDED on the recording sentence. Every kind it did not
 * name inherited that ending, so a forfeited referral and an invented price
 * were each shown to the client as the AI holding a conversation with a
 * recording (Bugbot, this PR).
 */
describe("kindPhrase", () => {
  const KINDS = [
    "role_leak",
    "talked_to_recording",
    "invented_contact_number",
    "gate_never_cleared",
    "invented_amount"
  ] as const;

  it("gives every kind its own sentence, and none inherits another's", () => {
    const phrases = KINDS.map((k) => kindPhrase(k));
    expect(new Set(phrases).size).toBe(KINDS.length);
    for (const p of phrases) expect(p.length).toBeGreaterThan(0);
  });

  it("does not describe the two new kinds as talking to a recording", () => {
    expect(kindPhrase("gate_never_cleared")).not.toContain("recording");
    expect(kindPhrase("invented_amount")).not.toContain("recording");
  });
});
