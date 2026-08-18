import { describe, it, expect } from "vitest";
import {
  composeIntakeLeadSms,
  DEFAULT_INTAKE_CAPTURE_FIELDS,
  INBOUND_VOICEMAIL_RECOGNITION_LINE,
  inboundVoicemailMessageLine,
  intakeSystemInstruction,
  iosScreeningLine,
  OUTBOUND_VOICEMAIL_TOOL_LINE,
  STAR_ROW
} from "../vps/voice-bridge/src/intake";

describe("intakeSystemInstruction", () => {
  it("leads with the configured persona and lists the capture fields", () => {
    const persona = "Hi, this is Amy Laidlaw's office.";
    const instr = intakeSystemInstruction("Amy Laidlaw", persona, "America/Phoenix", [
      "name",
      "phone",
      "address"
    ]);
    expect(instr).toContain(persona);
    expect(instr).toContain("Amy Laidlaw");
    expect(instr).toContain("capture_lead");
    expect(instr).toContain("name, phone, address");
  });

  it("falls back to a default opener and default fields when none provided", () => {
    const instr = intakeSystemInstruction("Acme", undefined, null, []);
    expect(instr).toContain("Acme's office");
    expect(instr).toContain(DEFAULT_INTAKE_CAPTURE_FIELDS.join(", "));
  });

  it("transfer mode pivots to the good-time script and names the agent", () => {
    const persona = "Hi, I'm calling with Amy Laidlaw's office. How are you?";
    const instr = intakeSystemInstruction(
      "Amy Laidlaw",
      persona,
      "America/Phoenix",
      [],
      true,
      { agentName: "Dave" }
    );
    expect(instr).toContain(persona);
    expect(instr).toContain("follow-up call");
    expect(instr).toContain("whether now is a good time to talk");
    expect(instr).toContain("one moment while I get Dave on the line");
    expect(instr).toContain("`transfer_to_owner`");
    // The capture checklist must not fight the call script...
    expect(instr).not.toContain("Collect these details");
    // ...but capture_lead stays available for notes / a better time.
    expect(instr).toContain("capture_lead");
    // Never hang up on a successfully transferred call.
    expect(instr).toContain("never after a successful transfer");
    // Barge-in guard + no callback-number non-sequitur (first live test).
    expect(instr).toContain("only ONCE");
    expect(instr).toContain("NEVER ask for their phone number");
  });

  it("transfer mode without an agent name uses a generic handle", () => {
    const instr = intakeSystemInstruction("Acme", undefined, null, [], false, {});
    expect(instr).toContain("the team member handling this");
    expect(instr).not.toContain("end_call");
  });

  it("every variant carries the greet-once barge-in guard", () => {
    for (const instr of [
      intakeSystemInstruction("Acme", undefined, null, []),
      intakeSystemInstruction("Acme", undefined, null, [], false, {}),
      intakeSystemInstruction("Acme", undefined, null, [], false, undefined, true)
    ]) {
      expect(instr).toContain("only ONCE");
      expect(instr).toContain("never restart it");
    }
  });

  it("an outbound call (we dialed) reframes the intake and never asks for their number", () => {
    const instr = intakeSystemInstruction(
      "Amy Laidlaw",
      "Hi, quick call from Amy's office!",
      null,
      ["name", "timeframe"],
      false,
      undefined,
      true
    );
    expect(instr).toContain("making a call the office asked you to place");
    expect(instr).toContain("The person has just answered");
    expect(instr).toContain("NEVER ask for their phone number");
    expect(instr).not.toContain("best callback number");
    expect(instr).not.toContain("call them back shortly");
    // Capture still works for the fields the flow configured.
    expect(instr).toContain("name, timeframe");
    expect(instr).toContain("capture_lead");
  });

  it("outbound collect lists drop 'phone' (defaults and explicit), degrading to notes", () => {
    // Default field set includes phone — outbound must not list it (Bugbot:
    // listing it contradicts the never-ask rule in the same paragraph).
    const defaults = intakeSystemInstruction("Acme", undefined, null, [], false, undefined, true);
    expect(defaults).toContain("name, address, timeframe, notes");
    expect(defaults).not.toContain("name, phone,");
    // Same for the transfer script's capture-fields mention.
    const transfer = intakeSystemInstruction("Acme", undefined, null, ["phone", "best time"], false, {});
    expect(transfer).toContain("fields: best time,");
    // A list that is ONLY phone degrades to notes, never an empty list.
    const onlyPhone = intakeSystemInstruction("Acme", undefined, null, ["phone"], false, undefined, true);
    expect(onlyPhone).toContain("confirming as you go: notes.");
  });

  it("outbound default opener drops the call-you-right-back promise", () => {
    const outbound = intakeSystemInstruction("Acme", undefined, null, [], false, undefined, true);
    expect(outbound).toContain("reaching out with a quick follow-up");
    expect(outbound).not.toContain("call you right back");
    const withTransfer = intakeSystemInstruction("Acme", undefined, null, [], false, {});
    expect(withTransfer).toContain("reaching out with a quick follow-up");
    expect(withTransfer).not.toContain("call you right back");
  });

  it("a known-details note lands with a never-re-ask rule (any variant)", () => {
    const note = "Their name: Bryan. Property: 123 Main St.";
    for (const instr of [
      intakeSystemInstruction("Acme", undefined, null, [], false, undefined, true, note),
      intakeSystemInstruction("Acme", undefined, null, [], false, { agentName: "Dave" }, true, note)
    ]) {
      expect(instr).toContain("ALREADY KNOW");
      expect(instr).toContain(note);
      expect(instr).toContain("This OVERRIDES any collect list above");
      expect(instr).toContain("NEVER ask for a detail listed there");
    }
    // Absent/blank note → no known-details block at all.
    const bare = intakeSystemInstruction("Acme", undefined, null, [], false, undefined, true, "  ");
    expect(bare).not.toContain("ALREADY KNOW");
  });

  it("the inbound live-transfer intake keeps the callback-number ask and opener", () => {
    const instr = intakeSystemInstruction("Acme", undefined, null, []);
    expect(instr).toContain("taking a live seller lead");
    expect(instr).toContain("best callback number");
    expect(instr).toContain("call you right back");
    expect(instr).toContain("name, phone, address, timeframe, notes");
  });

  it("the inbound intake chases the phone number FIRST", () => {
    // The referral partner withholds the seller's number until after this call,
    // so the person on the line is often the only source for it: a hang-up two
    // minutes in must not leave the team with no way to reach them.
    const instr = intakeSystemInstruction("Acme", undefined, null, []);
    expect(instr).toContain("YOUR FIRST PRIORITY is their phone number");
    expect(instr).toContain("read it back to confirm it");
    expect(instr).toContain("someone from the team will be in touch");
    expect(instr).toContain("answer their questions about selling as best you can");
  });

  it("does not chase the number on a call WE placed", () => {
    // We dialed them, so asking is the "why do you need my number?" non-sequitur.
    const outbound = intakeSystemInstruction("Acme", undefined, null, [], false, undefined, true);
    expect(outbound).not.toContain("YOUR FIRST PRIORITY");
    const transfer = intakeSystemInstruction("Acme", undefined, null, [], false, {});
    expect(transfer).not.toContain("YOUR FIRST PRIORITY");
  });

  it("a mid-call brief carrying the number overrides the phone-first priority", () => {
    // The portal released the details while the AI was talking, so it must stop
    // asking rather than making them repeat what we now have.
    const instr = intakeSystemInstruction(
      "Acme",
      undefined,
      null,
      [],
      false,
      undefined,
      false,
      "Their phone: +16025550100."
    );
    expect(instr).toContain("INCLUDING the phone-number priority");
    expect(instr).toContain("NEVER ask for a detail listed there");
  });
});

describe("composeIntakeLeadSms", () => {
  it("includes a generic header, captured fields, transfer line, and transcript", () => {
    const text = composeIntakeLeadSms({
      businessName: "Amy Laidlaw",
      lead: { name: "Javier", phone: "+15551112222", address: "123 Main St", timeframe: "3 months" },
      transferFromE164: "+14159851909",
      transcript: "AI: Hi\nClient: I want to sell",
      maxChars: 3000
    });
    expect(text).toContain("New live-transfer lead (AI intake)");
    // Generic wording: no hardcoded agent names in the header.
    expect(text).not.toContain("Dave");
    expect(text).toContain("Name: Javier");
    expect(text).toContain("Callback: +15551112222");
    expect(text).toContain("Address: 123 Main St");
    expect(text).toContain("Timeframe: 3 months");
    // The transfer partner's line is labeled as such — never as the callback.
    expect(text).toContain("Transferred via: +14159851909");
    expect(text).toContain("Transcript:");
    expect(text).toContain("Client: I want to sell");
  });

  it("never presents the transfer ANI as the seller's callback", () => {
    const text = composeIntakeLeadSms({
      businessName: "Acme",
      lead: {},
      transferFromE164: "+14159851909",
      transcript: "",
      maxChars: 3000
    });
    // No captured phone and no fabricated callback from the transfer line.
    expect(text).not.toContain("Callback:");
    expect(text).toContain("Transferred via: +14159851909");
    expect(text).not.toContain("Transcript:");
  });

  it("omits the transfer line when none is provided", () => {
    const text = composeIntakeLeadSms({
      businessName: "Acme",
      lead: { name: "Sam" },
      transcript: "",
      maxChars: 3000
    });
    expect(text).toContain("Name: Sam");
    expect(text).not.toContain("Transferred via:");
  });

  it("omits the transfer line when it is blank/whitespace", () => {
    const text = composeIntakeLeadSms({
      businessName: "Acme",
      lead: { name: "Sam" },
      transferFromE164: "   ",
      transcript: "",
      maxChars: 3000
    });
    expect(text).not.toContain("Transferred via:");
  });

  it("renders custom captured fields (not just the standard five)", () => {
    const text = composeIntakeLeadSms({
      businessName: "Acme",
      lead: { name: "Sam", budget_range: "500k-600k", hoa_status: "none" },
      transcript: "",
      maxChars: 3000
    });
    expect(text).toContain("Name: Sam");
    // Custom keys are title-cased and included.
    expect(text).toContain("Budget Range: 500k-600k");
    expect(text).toContain("Hoa Status: none");
  });

  it("truncates to maxChars", () => {
    const text = composeIntakeLeadSms({
      businessName: "Acme",
      lead: {},
      transferFromE164: "+1555",
      transcript: "x".repeat(5000),
      maxChars: 200
    });
    expect(text.length).toBe(200);
  });

  it("frames the summary in asterisks when the flow opted into star alerts", () => {
    const plain = composeIntakeLeadSms({
      businessName: "Amy Laidlaw",
      lead: { name: "Javier" },
      transcript: "AI: Hi",
      maxChars: 3000
    });
    const framed = composeIntakeLeadSms({
      businessName: "Amy Laidlaw",
      lead: { name: "Javier" },
      transcript: "AI: Hi",
      maxChars: 3000,
      starFrame: true
    });
    // Same body, only framed: the wording never changes with the option.
    expect(framed).toBe(`${STAR_ROW}\n${plain}\n${STAR_ROW}`);
  });

  it("leaves the summary plain when starFrame is false or omitted", () => {
    const args = { businessName: "Acme", lead: { name: "Sam" }, transcript: "", maxChars: 3000 };
    expect(composeIntakeLeadSms(args).startsWith(STAR_ROW)).toBe(false);
    expect(composeIntakeLeadSms({ ...args, starFrame: false }).startsWith(STAR_ROW)).toBe(false);
  });

  it("keeps a framed summary inside maxChars, closing row included", () => {
    // The frame comes out of the truncation budget: a long transcript must
    // never push the closing row off the end of the message.
    const text = composeIntakeLeadSms({
      businessName: "Acme",
      lead: {},
      transferFromE164: "+1555",
      transcript: "x".repeat(5000),
      maxChars: 200,
      starFrame: true
    });
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.startsWith(`${STAR_ROW}\n`)).toBe(true);
    expect(text.endsWith(`\n${STAR_ROW}`)).toBe(true);
  });

  it("still frames when the budget leaves no room for a body", () => {
    const text = composeIntakeLeadSms({
      businessName: "Acme",
      lead: {},
      transcript: "",
      maxChars: 1,
      starFrame: true
    });
    expect(text).toBe(`${STAR_ROW}\n\n${STAR_ROW}`);
  });
});

/**
 * Aug 14 2026, HomeLight transfer, call 28f9c228. This is the persona that
 * ran on that call: the AI-takeover path builds its instruction here, not in
 * systemInstructionForBusiness, so rules added only there would have missed
 * the incident they were written for (caught by Bugbot on PR #1377).
 *
 * The transfer dropped the AI into the seller's voicemail. It ran this
 * script at the recording: the "read it back to confirm it" rule below is
 * what turned menu digits into "that's 975 568. Is that correct?", and with
 * nobody replying the model supplied the seller's answer itself, role token
 * and all, then answered its own question.
 */
describe("intakeSystemInstruction: call-integrity rules", () => {
  const variants: Array<[string, string]> = [
    ["inbound seller takeover", intakeSystemInstruction("Amy Laidlaw", undefined, "America/Phoenix", [])],
    [
      "outbound call",
      intakeSystemInstruction("Amy Laidlaw", undefined, "America/Phoenix", [], false, undefined, true)
    ],
    [
      "transfer mode",
      intakeSystemInstruction("Amy Laidlaw", undefined, "America/Phoenix", [], false, {
        agentName: "Dave"
      })
    ]
  ];

  for (const [label, instr] of variants) {
    it(`forbids voicing the caller's side in ${label}`, () => {
      expect(instr).toContain("Never speak the caller's side of the conversation");
      expect(instr).toContain("never write out a role label");
      expect(instr).toContain("Only ever react to words the caller actually said");
    });

    it(`teaches recordings are not people in ${label}`, () => {
      expect(instr).toContain("recorded system rather than a person");
      expect(instr).toContain("do not carry on a conversation with it");
      // The precise trap on the incident call: digits read out by a menu are
      // not a number the caller gave, and this persona is told to collect a
      // callback number and read it back.
      expect(instr).toContain("never treat digits or words it reads out as something the caller told you");
    });
  }
});

/**
 * The accept keypress is the whole HomeLight mechanic: the call is answered
 * into a partner announcement and the referral is won by pressing a digit on
 * a timer (docs/tenants/homelight-flow.md, "the accept is a DTMF keypress").
 * The bridge arms that with an ivrGate, a `press_digits` tool, and a
 * coordinator cue telling the model to stay silent and press the key.
 *
 * RECORDED_SYSTEM_LINE rides every intake session, gated ones included, and
 * a persistent system-instruction rule outranks a mid-call cue. Written
 * without a carve-out it forbade answering a recording's prompts at all,
 * which would have made the model sit through the announcement and lose the
 * referral: a worse failure than the voicemail incident it was written for
 * (Bugbot, PR #1377).
 */
describe("intakeSystemInstruction: the recording rule leaves the accept press alone", () => {
  const instr = intakeSystemInstruction("Amy Laidlaw", undefined, "America/Phoenix", []);

  it("permits pressing a key when a coordinator message asks for it", () => {
    expect(instr).toContain("press a key");
    expect(instr).toContain("Pressing a key is not talking to it");
  });

  it("still bans conversing with the recording and mining it for caller facts", () => {
    // The carve-out must not swallow the rule it is carved out of.
    expect(instr).toContain("do not carry on a conversation with it");
    expect(instr).toContain("never treat digits or words it reads out as something the caller told you");
  });
});

/**
 * The platform already owns voicemail policy for outbound calls: a
 * `place_ai_call` step leaves a message ONLY when the author set
 * `voicemailTemplate`, and without one the AI hangs up rather than talk to a
 * recording (the outcome reason is `voicemail_no_message`, and the compile
 * docs say plainly that talking to a recording wastes minutes).
 *
 * An unconditional "at the beep, leave one short message" in the persistent
 * instruction would override that: every unscripted call would start
 * improvising voicemails at customers, in copy nobody approved.
 */
describe("intakeSystemInstruction: voicemail deference", () => {
  const instr = intakeSystemInstruction("Amy Laidlaw", undefined, "America/Phoenix", []);

  it("leaves a message only when it was given one to leave", () => {
    expect(instr).toContain("your instructions include a message to leave");
    expect(instr).toContain("do not improvise one");
  });

  it("still bans reading the briefing into a voicemail", () => {
    expect(instr).toContain("Never read out lead details");
  });
});

/**
 * The keypad exception is scoped per ANNOUNCEMENT, not per press, and both
 * halves of that are load-bearing.
 *
 * Re-pressing the SAME announcement is designed behavior: a Telnyx OK is not
 * proof the partner accepted, so an early blind fallback can land before the
 * menu is listening while the partner keeps looping "press 1". ivr-gate-press
 * allows up to IVR_MAX_ACCEPT_PRESSES with a cooldown, and sendPostAcceptCue
 * explicitly tells the model to press again if the recording is still asking.
 * A "spent once you have pressed" rule would outrank that cue and cost the
 * referral on an early first tone.
 *
 * Pressing into a DIFFERENT, later recording is the failure. On the incident
 * call (28f9c228) the seller's mailbox offered "Replay your message. Press
 * one. To continue recording, press two." That is the partner gate's DTMF
 * aimed at a stranger's voicemail. Both directions caught by Bugbot on #1377.
 */
describe("intakeSystemInstruction: the keypad exception is scoped per announcement", () => {
  const instr = intakeSystemInstruction("Amy Laidlaw", undefined, "America/Phoenix", []);

  it("scopes the press to the announcement it was told about", () => {
    expect(instr).toContain("only the announcement the coordinator named");
  });

  it("still allows re-pressing that same announcement while it loops", () => {
    expect(instr).toContain("if that same announcement is still asking, press again");
  });

  it("names the later-recording case it must not press into", () => {
    expect(instr).toContain("a voicemail menu offering to replay");
    expect(instr).toContain("do not press anything");
  });
});

/**
 * The inbound live-transfer leg can reach a MACHINE, and the generic
 * recordings rule alone leaves it silent rather than useful.
 *
 * On 2026-08-16 (Thomas L., the 16:40Z call) HomeLight bridged the accepted
 * referral onward to the seller's phone, which was off: a carrier voice said
 * "592030 is not available.", the model asked it whether it was trying to
 * give a phone number, and the seller's mailbox recorded four minutes of
 * one-sided intake before the time-limit menu ended it. Two fixes, both
 * scoped to the INBOUND branch only: name the carrier signatures verbatim so
 * recognition fires before the first wrong reply, and hand the persona ONE
 * pre-written message so the mailbox gets something useful instead of
 * improvisation (outbound calls keep their authored voicemailTemplate
 * policy, so they must NOT inherit this default).
 */
describe("intakeSystemInstruction: inbound carrier-voicemail handling", () => {
  const inbound = intakeSystemInstruction("Amy Laidlaw", undefined, "America/Phoenix", [], true);

  it("names the carrier signatures verbatim so recognition beats the first reply", () => {
    expect(inbound).toContain('"is not available"');
    expect(inbound).toContain('"please record your message"');
    expect(inbound).toContain('"at the tone"');
    expect(inbound).toContain("never treat a number it reads out as the seller's number");
  });

  it("gives the ONE scripted message, business-named, with no briefing details", () => {
    expect(inbound).toContain(
      '"Hi, this is the office of Amy Laidlaw calling back about the home you asked about selling. We will try you again shortly. Thank you."'
    );
    expect(inbound).toContain("leave EXACTLY this one message, once, and nothing else");
    expect(inbound).toContain("no details from your briefing");
  });

  it("ends the call via the end_call tool when available, by silence otherwise", () => {
    expect(inbound).toContain("call the `end_call` tool to hang up");
    const withoutEndCall = intakeSystemInstruction(
      "Amy Laidlaw",
      undefined,
      "America/Phoenix",
      [],
      false
    );
    expect(withoutEndCall).toContain("end the call by saying nothing more");
  });

  it("outbound and transfer calls keep the authored voicemailTemplate policy instead", () => {
    const outbound = intakeSystemInstruction(
      "Amy Laidlaw",
      undefined,
      "America/Phoenix",
      [],
      true,
      undefined,
      true
    );
    const transfer = intakeSystemInstruction("Amy Laidlaw", undefined, "America/Phoenix", [], true, {
      agentName: "Dave"
    });
    for (const instr of [outbound, transfer]) {
      expect(instr).not.toContain("calling back about the home you asked about selling");
      expect(instr).not.toContain("THE LINE IS NOT ALWAYS A PERSON");
    }
  });

  it("carries no em dash and no receptionist label", () => {
    expect(INBOUND_VOICEMAIL_RECOGNITION_LINE).not.toMatch(/—/);
    expect(inboundVoicemailMessageLine("Amy Laidlaw", true)).not.toMatch(/—/);
    expect(INBOUND_VOICEMAIL_RECOGNITION_LINE.toLowerCase()).not.toContain("receptionist");
  });
});

/**
 * Apple call screening on calls WE place (flow dials now run
 * premium_ios_call_screening_detection). The screening robot transcribes
 * what the caller says for the person deciding whether to pick up: one clear
 * identification sentence gets the call through, a full opener read at the
 * robot looks like spam on their screen, and conversing with it would break
 * the recordings rule.
 */
describe("intakeSystemInstruction: Apple call screening identification", () => {
  it("outbound and transfer personas carry the one-sentence identification", () => {
    const outbound = intakeSystemInstruction(
      "Amy Laidlaw",
      undefined,
      "America/Phoenix",
      [],
      true,
      undefined,
      true
    );
    const transfer = intakeSystemInstruction("Amy Laidlaw", undefined, "America/Phoenix", [], true, {
      agentName: "Dave"
    });
    for (const instr of [outbound, transfer]) {
      expect(instr).toContain(
        '"This is Amy Laidlaw\'s office with a quick follow-up call."'
      );
      expect(instr).toContain("say exactly ONE short sentence");
      expect(instr).toContain("stay quiet until a real person speaks");
    }
  });

  it("the inbound live-transfer persona does not (nobody screens a call they placed)", () => {
    const inbound = intakeSystemInstruction("Amy Laidlaw", undefined, "America/Phoenix", [], true);
    expect(inbound).not.toContain("call screening voice answers");
  });

  it("carries no em dash", () => {
    expect(iosScreeningLine("Amy Laidlaw")).not.toMatch(/—/);
  });
});

/**
 * Reporting a recording on calls WE placed.
 *
 * Carrier AMD is primary and it guesses wrong on personal greetings: it read
 * Jim Inderberg's mailbox as `human_residence` (2026-08-17), so nothing
 * stamped the call, the cadence recorded "spoke with them", and the follow-up
 * text that only sends on no-answer was skipped. On the same day the
 * assistant delivered a full listing pitch into Jennifer Kline's mailbox and
 * narrated a transfer it never made. The `voicemail_reached` tool is where
 * the assistant's own verdict goes, and the rule ships only with the tool.
 */
describe("intakeSystemInstruction: reporting a recording", () => {
  const withTool = intakeSystemInstruction(
    "Amy Laidlaw",
    undefined,
    "America/Phoenix",
    [],
    true,
    undefined,
    true,
    undefined,
    undefined,
    true
  );

  it("names the recording signatures verbatim and reports BEFORE speaking", () => {
    expect(withTool).toContain("`voicemail_reached`");
    expect(withTool).toContain('"please record your message"');
    expect(withTool).toContain('"when you have finished recording you may hang up"');
    expect(withTool).toContain("REPORT IT BEFORE YOU SAY ANYTHING ELSE");
    // The Jennifer failure in one clause: no pitch at a machine, and no
    // narrating a transfer that is not happening.
    expect(withTool).toContain("never narrate an action you are about to take");
  });

  it("reads a returned script verbatim, and stays silent when there is none", () => {
    expect(withTool).toContain("read that text aloud word for word");
    expect(withTool).toContain("If it returns no script, say nothing at all");
  });

  // Three endings, not two. When the OTHER path already holds the claim a
  // message is playing into the recording right now, so hanging up would cut
  // it off part way through (Bugbot, PR #1428).
  it("waits instead of hanging up when a message is already being left", () => {
    expect(withTool).toContain("a message is already being left");
    expect(withTool).toContain("do NOT end the call");
    expect(withTool).toContain("cut that message off part way through");
  });

  it("ships the rule only when the tool exists", () => {
    const withoutTool = intakeSystemInstruction(
      "Amy Laidlaw",
      undefined,
      "America/Phoenix",
      [],
      true,
      undefined,
      true
    );
    expect(withoutTool).not.toContain("voicemail_reached");
  });

  it("carries no em dash and never says receptionist", () => {
    expect(OUTBOUND_VOICEMAIL_TOOL_LINE).not.toMatch(/—/);
    expect(OUTBOUND_VOICEMAIL_TOOL_LINE.toLowerCase()).not.toContain("receptionist");
  });
});
