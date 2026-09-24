import { describe, expect, it } from "vitest";
import { groundUncommittedClaims, toolTurnFact } from "@/lib/dashboard-chat/claim-grounding";

const DID = "+14808061313";

function ground(
  content: string,
  extras: Partial<Parameters<typeof groundUncommittedClaims>[1]> = {}
) {
  return groundUncommittedClaims(content, {
    facts: [],
    draftCount: 0,
    coworkerDid: DID,
    canToggleFlows: true,
    ...extras
  });
}

describe("toolTurnFact", () => {
  it("treats a staged edit as unapplied and an applied edit as a write", () => {
    expect(toolTurnFact("edit_aiflow", { ok: true, staged: true, confirmationToken: "t" })).toEqual({
      name: "edit_aiflow",
      ok: true,
      applied: false,
      staged: true
    });
    expect(toolTurnFact("edit_aiflow", { ok: true, applied: true })).toEqual({
      name: "edit_aiflow",
      ok: true,
      applied: true,
      staged: false
    });
    expect(toolTurnFact("edit_aiflow", { ok: true, confirmationToken: "tok" }).staged).toBe(true);
    expect(toolTurnFact("edit_aiflow", { ok: false, staged: true }).staged).toBe(false);
    expect(toolTurnFact("edit_aiflow", null)).toEqual({
      name: "edit_aiflow",
      ok: false,
      applied: false,
      staged: false
    });
  });
});

describe("groundUncommittedClaims", () => {
  it("leaves an honest reply alone, including a blank one", () => {
    expect(ground("The only automation on the account is still off.")).toBe(
      "The only automation on the account is still off."
    );
    expect(ground("  ")).toBe("  ");
  });

  it("corrects a claimed automation write, staged edit, knowledge save, and draft that did not happen", () => {
    const text = ground(
      "I updated the automation wording. I staged the SMS. I saved it to memory. Open in AiFlows builder."
    );
    expect(text).toContain("did not change an automation");
    expect(text).toContain("did not stage");
    expect(text).toContain("did not write a knowledge section");
    expect(text).toContain("did not create an AiFlows draft");
  });

  it("keeps a claim that the tool result backs", () => {
    const text = ground(
      "I updated the automation wording. I staged it. I saved it to knowledge. Open in AiFlows builder.",
      {
        facts: [
          { name: "edit_aiflow", ok: true, applied: true, staged: false },
          { name: "update_business_knowledge", ok: true, applied: false, staged: false }
        ],
        draftCount: 1
      }
    );
    expect(text).not.toContain("Correction:");
  });

  it("corrects a false cannot-toggle claim and a test call to the wrong number", () => {
    const text = ground(
      "I cannot toggle workflows from this chat. Call (218) 770-2372 to test Quinn."
    );
    expect(text).toContain("can turn an automation on or off");
    expect(text).toContain(DID);
    expect(text).toContain("(218) 770-2372");
  });

  it("ignores a number that is not offered as a test call", () => {
    expect(ground("The form reference is (218) 770-2372 on the sheet.")).not.toContain("Correction:");
  });

  it("allows the coworker DID and skips the phone check when the DID is unknown", () => {
    expect(ground(`Call ${DID} to test Quinn.`)).not.toContain("Correction:");
    expect(
      ground("Call (218) 770-2372 to test Quinn.", { coworkerDid: null, canToggleFlows: false })
    ).not.toContain("Correction:");
  });

  it("still corrects a test-call number when the coworker line on file is too short to compare", () => {
    const text = ground("Call (218) 770-2372 to test Quinn.", { coworkerDid: "+123" });
    expect(text).toContain("call +123");
    expect(text).toContain("(218) 770-2372");
  });

  it("does not scold a toggle the tool already made", () => {
    const text = ground("I cannot toggle the workflow from here.", {
      facts: [{ name: "set_flow_enabled", ok: true, applied: false, staged: false }]
    });
    expect(text).not.toContain("Correction:");
  });
});
