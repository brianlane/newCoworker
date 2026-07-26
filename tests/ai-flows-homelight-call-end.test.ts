import { describe, expect, it } from "vitest";
import {
  addEtaArm,
  addEtaAsk,
  addEtaCategory,
  addRecheckBlock,
  addSpokenToQt,
  applyAll,
  CALL_PREFIX,
  ETA_ARM_ID,
  ETA_ASK_LINE,
  ETA_CATEGORY,
  findStep,
  QT_SPOKEN_LINE,
  RELEASE_VAR,
  type Definition
} from "../scripts/oneshot/homelight-call-end-details";
import { parseAiFlowDefinition, validateDefinitionSemantics } from "@/lib/ai-flows/schema";

const FROM = "+14159851909";
const CLAIMED = { var: "claimed_agent", notEquals: "none" };

/** The live flow's shape, trimmed to what this patch anchors on. */
function liveDef(): Definition {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
    steps: [
      { id: "url", type: "extract_url", saveAs: "leadUrl" },
      {
        id: "card",
        type: "browse_extract",
        urlVar: "leadUrl",
        auth: { integrationLabel: "Home Light" },
        screenshot: true,
        when: CLAIMED,
        fields: [
          { name: "lead_name", description: "The lead's full name" },
          { name: "lead_phone", description: "The lead's mobile phone" },
          { name: "lead_email", description: "The lead's email" },
          { name: "lead_address", description: "The property address" },
          { name: "already_claimed", description: "yes or no" },
          { name: "lead_notes", description: "The client notes" }
        ]
      },
      {
        id: "brief_call",
        type: "voice_brief",
        fromE164: FROM,
        noteTemplate: "Client notes: {{vars.lead_notes}}",
        withinMinutes: 30,
        when: CLAIMED
      },
      {
        id: "lost_branch",
        type: "branch",
        question: "Is this referral still ours?",
        branches: [
          {
            id: "still_ours",
            label: "Still ours",
            condition: { var: "already_claimed", notEquals: "yes" },
            steps: [
              {
                id: "to_agent",
                type: "send_sms",
                to: "{{vars.claimed_agent_phone}}",
                when: CLAIMED,
                body:
                  "HomeLight lead is yours: {{vars.lead_name}} {{vars.lead_phone}}\n" +
                  "Address: {{vars.lead_address}}"
              },
              {
                id: "qt_email",
                type: "send_email",
                to: "amy@amylaidlaw.com",
                subject: "{{vars.lead_name}} QT HL CC DAVE",
                attachScreenshot: true,
                when: CLAIMED,
                body:
                  "HomeLight referral claimed by {{vars.claimed_agent}}.\n" +
                  "Lead: {{vars.lead_name}} ({{vars.lead_phone}})\n" +
                  "Address: {{vars.lead_address}}\nLead source: HomeLight"
              }
            ]
          }
        ],
        else: []
      },
      { id: "bp_wait", type: "wait_for_reply", phoneVar: "claimed_agent_phone", saveAs: "agent_report" },
      {
        id: "bp_classify",
        type: "classify",
        textVar: "agent_report",
        saveAs: "agent_report_class",
        question: "The team member's follow-up text about that lead.",
        categories: [
          { value: "bad_phone_number", description: "says the lead's phone is bad" },
          { value: "other_update", description: "any other update about the lead" }
        ],
        when: { var: "agent_report", notEquals: "no_reply" }
      },
      {
        id: "bp_branch",
        type: "branch",
        question: "What did they report?",
        branches: [
          {
            id: "bp_bad_phone",
            label: "Bad phone",
            condition: { var: "agent_report_class", equals: "bad_phone_number" },
            steps: [{ id: "bp_email_amy", type: "notify_owner", message: "bad number" }]
          }
        ],
        else: [{ id: "bp_forward", type: "notify_owner", message: "{{vars.agent_report}}" }]
      }
    ]
  };
}

const trunkIds = (def: Definition) => (def.steps ?? []).map((s) => s.id);

describe("homelight-call-end-details: the re-read block", () => {
  it("inserts the whole block directly after brief_call", () => {
    const def = liveDef();
    expect(addRecheckBlock(def, FROM)).toBe(true);
    expect(trunkIds(def)).toEqual([
      "url",
      "card",
      "brief_call",
      "recheck1_wait",
      "recheck1",
      "recheck2_wait",
      "recheck2",
      "brief_release",
      "wait_hl_call",
      "final_read",
      "lost_branch",
      "bp_wait",
      "bp_classify",
      "bp_branch"
    ]);
  });

  it("puts the screenshot read BEFORE qt_email, which is the whole QT fix", () => {
    // screenshot_path is a single var each screenshotting browse overwrites, so
    // the last one before the email is what gets attached. Before this patch
    // that was `card`, taken while HomeLight was still withholding.
    const def = liveDef();
    addRecheckBlock(def, FROM);
    const ids = trunkIds(def);
    expect(ids.indexOf("final_read")).toBeLessThan(ids.indexOf("lost_branch"));
    expect(findStep(def, "final_read")).toMatchObject({ screenshot: true });
    // ...and it is the ONLY re-read that shoots, so nothing after it can put a
    // still-blank card back into screenshot_path.
    expect(findStep(def, "recheck1")?.screenshot).toBeUndefined();
    expect(findStep(def, "recheck2")?.screenshot).toBeUndefined();
  });

  it("re-reads only ever backfill, so a still-blank page cannot erase details", () => {
    const def = liveDef();
    addRecheckBlock(def, FROM);
    for (const id of ["recheck1", "recheck2", "final_read"]) {
      expect(findStep(def, id)).toMatchObject({ fillOnlyEmpty: true, urlVar: "leadUrl" });
    }
  });

  it("carries the card's credentials and its extraction wording", () => {
    const def = liveDef();
    addRecheckBlock(def, FROM);
    const recheck = findStep(def, "recheck1")!;
    expect(recheck.auth).toEqual({ integrationLabel: "Home Light" });
    const names = (recheck.fields ?? []).map((f) => f.name);
    // The contact fields, plus the release sentinel; never already_claimed (a
    // re-read must not flip the lost-referral guard) or lead_notes.
    expect(names).toEqual([
      "lead_name",
      "lead_phone",
      "lead_email",
      "lead_address",
      RELEASE_VAR
    ]);
  });

  it("only takes the second look when the first one came up empty", () => {
    const def = liveDef();
    addRecheckBlock(def, FROM);
    expect(findStep(def, "recheck2_wait")?.when).toEqual({
      var: RELEASE_VAR,
      notEquals: "released"
    });
    expect(findStep(def, "recheck2")?.when).toEqual({ var: RELEASE_VAR, notEquals: "released" });
    expect(findStep(def, "brief_release")?.when).toEqual({ var: RELEASE_VAR, equals: "released" });
  });

  it("backfills the flow's own vars from what the seller said", () => {
    const def = liveDef();
    addRecheckBlock(def, FROM);
    expect(findStep(def, "wait_hl_call")).toMatchObject({
      type: "wait_for_call",
      fromE164: FROM,
      capturePrefix: CALL_PREFIX,
      backfill: [
        { from: "phone", to: "lead_phone" },
        { from: "email", to: "lead_email" },
        { from: "address", to: "lead_address" },
        { from: "name", to: "lead_name" }
      ]
    });
  });

  it("is idempotent and fails loudly on a rebuilt flow", () => {
    const def = liveDef();
    expect(addRecheckBlock(def, FROM)).toBe(true);
    expect(addRecheckBlock(def, FROM)).toBe(false);
    const noBrief = liveDef();
    noBrief.steps = (noBrief.steps ?? []).filter((s) => s.id !== "brief_call");
    expect(() => addRecheckBlock(noBrief, FROM)).toThrow(/brief_call/);
  });
});

describe("homelight-call-end-details: the when-can-you-call ask", () => {
  it("asks Dave when, and shows both numbers labeled by source", () => {
    const def = liveDef();
    expect(addEtaAsk(def)).toBe(true);
    const body = String(findStep(def, "to_agent")!.body);
    expect(body).toContain(ETA_ASK_LINE);
    expect(body).toContain('"1, 20 min"');
    expect(body).toContain(`Seller said on the call: {{vars.${CALL_PREFIX}phone}}`);
    expect(addEtaAsk(def)).toBe(false);
  });

  it("keeps the owner's existing copy, adding to it rather than replacing it", () => {
    // The body references vars earlier steps produce and Amy edits it by hand;
    // rewriting it wholesale would drop both.
    const def = liveDef();
    const before = String(findStep(def, "to_agent")!.body);
    addEtaAsk(def);
    const after = String(findStep(def, "to_agent")!.body);
    for (const line of before.split("\n")) expect(after).toContain(line);
    // The spoken number sits directly under the address it qualifies.
    const lines = after.split("\n");
    expect(lines[lines.findIndex((l) => l.includes("lead_address")) + 1]).toContain(
      `{{vars.${CALL_PREFIX}phone}}`
    );
  });

  it("still appends the ask when the body has no address line", () => {
    const def = liveDef();
    findStep(def, "to_agent")!.body = "HomeLight lead is yours: {{vars.lead_name}}";
    expect(addEtaAsk(def)).toBe(true);
    const body = String(findStep(def, "to_agent")!.body);
    expect(body).toContain(ETA_ASK_LINE);
    expect(body).toContain(`{{vars.${CALL_PREFIX}phone}}`);
  });

  it("reuses the existing reply wait rather than opening a second offer", () => {
    // A second route_to_team would give the "1 / 1, 20 min" handshake for free,
    // but its owner fallback resets claimed_agent and claimed_agent_phone to
    // "none", which would break every claim-gated step after it (bp_wait's own
    // phoneVar included). bp_wait already parks on the claimer's next text.
    const def = liveDef();
    applyAll(def, FROM);
    const routes = (def.steps ?? []).filter((s) => s.type === "route_to_team");
    expect(routes).toHaveLength(0);
    expect(findStep(def, "bp_wait")).toMatchObject({ phoneVar: "claimed_agent_phone" });
  });

  it("teaches the classifier the timing reply, ahead of the catch-all", () => {
    const def = liveDef();
    expect(addEtaCategory(def)).toBe(true);
    const categories = findStep(def, "bp_classify")!.categories as Array<{ value: string }>;
    expect(categories.map((c) => c.value)).toEqual([
      "bad_phone_number",
      ETA_CATEGORY,
      "other_update"
    ]);
    expect(addEtaCategory(def)).toBe(false);
  });

  it("forwards what he said to Amy on its own arm", () => {
    const def = liveDef();
    expect(addEtaArm(def)).toBe(true);
    const arms = findStep(def, "bp_branch")!.branches as Array<Record<string, unknown>>;
    const arm = arms.find((a) => a.id === ETA_ARM_ID)!;
    expect(arm.condition).toEqual({ var: "agent_report_class", equals: ETA_CATEGORY });
    expect(JSON.stringify(arm.steps)).toContain("{{vars.agent_report}}");
    expect(addEtaArm(def)).toBe(false);
  });

  it("puts the spoken number on the QT too", () => {
    const def = liveDef();
    expect(addSpokenToQt(def)).toBe(true);
    const body = String(findStep(def, "qt_email")!.body);
    expect(body).toContain(`${QT_SPOKEN_LINE} {{vars.${CALL_PREFIX}phone}}`);
    // Still the same email, still attaching a screenshot.
    expect(body).toContain("HomeLight referral claimed by");
    expect(findStep(def, "qt_email")).toMatchObject({ attachScreenshot: true });
    expect(addSpokenToQt(def)).toBe(false);
  });
});

describe("homelight-call-end-details: the patched flow", () => {
  it("is still a valid definition", () => {
    const def = liveDef();
    const applied = applyAll(def, FROM);
    expect(applied).toHaveLength(5);
    const parsed = parseAiFlowDefinition(def);
    expect(validateDefinitionSemantics(parsed)).toEqual([]);
  });

  it("re-running changes nothing", () => {
    const def = liveDef();
    applyAll(def, FROM);
    const before = JSON.stringify(def);
    expect(applyAll(def, FROM)).toEqual([]);
    expect(JSON.stringify(def)).toBe(before);
  });
});
