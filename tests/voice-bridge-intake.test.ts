import { describe, it, expect } from "vitest";
import {
  composeIntakeLeadSms,
  DEFAULT_INTAKE_CAPTURE_FIELDS,
  intakeSystemInstruction
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
    expect(transfer).toContain("fields: best time —");
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
});
