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
});

describe("composeIntakeLeadSms", () => {
  it("includes header, captured fields, client number, and transcript", () => {
    const text = composeIntakeLeadSms({
      businessName: "Amy Laidlaw",
      lead: { name: "Javier", address: "123 Main St", timeframe: "3 months" },
      clientE164: "+19178628675",
      transcript: "AI: Hi\nClient: I want to sell",
      maxChars: 3000
    });
    expect(text).toContain("HomeLight lead (AI intake)");
    expect(text).toContain("Name: Javier");
    expect(text).toContain("Address: 123 Main St");
    expect(text).toContain("Timeframe: 3 months");
    // No captured phone, so it falls back to the client's call number.
    expect(text).toContain("Callback: +19178628675");
    expect(text).toContain("Call from: +19178628675");
    expect(text).toContain("Transcript:");
    expect(text).toContain("Client: I want to sell");
  });

  it("prefers a captured callback phone over the client ANI", () => {
    const text = composeIntakeLeadSms({
      businessName: "Acme",
      lead: { phone: "+15551112222" },
      clientE164: "+19178628675",
      transcript: "",
      maxChars: 3000
    });
    expect(text).toContain("Callback: +15551112222");
    expect(text).not.toContain("Callback: +19178628675");
    expect(text).toContain("Call from: +19178628675");
    expect(text).not.toContain("Transcript:");
  });

  it("truncates to maxChars", () => {
    const text = composeIntakeLeadSms({
      businessName: "Acme",
      lead: {},
      clientE164: "+1555",
      transcript: "x".repeat(5000),
      maxChars: 200
    });
    expect(text.length).toBe(200);
  });
});
