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
  });

  it("transfer mode without an agent name uses a generic handle", () => {
    const instr = intakeSystemInstruction("Acme", undefined, null, [], false, {});
    expect(instr).toContain("the team member handling this");
    expect(instr).not.toContain("end_call");
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
