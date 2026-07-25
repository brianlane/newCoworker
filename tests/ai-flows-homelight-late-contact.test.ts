import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, validateDefinitionSemantics } from "@/lib/ai-flows/schema";
import {
  addAlreadyClaimedGuard,
  addRung1,
  addRung2,
  addSentinels,
  ALREADY_CLAIMED_VAR,
  CONTACT_STATUS_VAR,
  DEAD_CLAIM_LINE,
  dropDeadClaimLink,
  findStep,
  GUARDED_SEND_IDS,
  LOST_BRANCH_ID,
  patchDefinition,
  RUNG_1_BRANCH_ID,
  RUNG_1_STATUS_VAR,
  RUNG_2_BRANCH_ID,
  RUNG_2_STATUS_VAR,
  type Definition,
  type Step
} from "../scripts/oneshot/homelight-late-contact-retry";

/**
 * The one-shot that closes the late-contact-details gap on Amy's "HomeLight
 * Referral" flow (Salma A., Jul 25 2026: Dave was texted "Salma A. none"
 * because HomeLight's details email had not arrived when the flow looked, and
 * the page said the referral was already claimed by another agent).
 *
 * The helpers are pure, so these pin their edits, their idempotency, and that
 * the patched LIVE shape still passes the real authoring schema.
 */

const CONNECTION_ID = "9ddd5344-14f2-46df-a89d-dddc2d50e944";
const MINUTES = { rung1Minutes: 10, rung2Minutes: 60 };

/** A faithful replica of Amy's live definition (trimmed bodies, real shape). */
function liveShape(): Definition {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: 15,
      conditions: [
        { type: "has_url" },
        { type: "contains", value: "HomeLight Referral", caseInsensitive: true }
      ]
    },
    steps: [
      { id: "url", type: "extract_url", saveAs: "leadUrl" },
      {
        id: "alert",
        type: "extract_text",
        fields: [
          { name: "lead_first_name", description: "first name" },
          { name: "price", description: "price" },
          { name: "price_digits", description: "digits" },
          { name: "city", description: "city" },
          { name: "lead_type", description: "buyer or seller" },
          { name: "price_band", description: "over_1m or under_1m" }
        ]
      },
      {
        id: "open",
        type: "browse_extract",
        urlVar: "leadUrl",
        auth: { integrationLabel: "Home Light" },
        screenshot: true,
        extractLinks: [{ name: "claim_link", matchText: "Call me to claim referral" }]
      },
      {
        id: "route",
        type: "route_to_team",
        agentNames: ["Dave Lane", "Amy Laidlaw"],
        responseMinutes: 5,
        attachScreenshot: true,
        offerTemplate:
          "New HomeLight referral: {{vars.lead_first_name}}, {{vars.lead_type}} in {{vars.city}} (~{{vars.price}}).\n" +
          "Tap to claim and click button to have homelight call you (no phone number to call): {{vars.leadUrl}}\n" +
          DEAD_CLAIM_LINE +
          "Reply 1 to claim or 2 to pass by {{offer.deadline}}.\n" +
          "First to reply 1 gets it.",
        ownerFallbackTemplate: "No one claimed the HomeLight referral {{vars.lead_first_name}}.",
        claimedNotifyTemplate: "{{agent.name}} claimed {{vars.lead_first_name}}.",
        claimedNotifyEmail: "amy@amylaidlaw.com",
        ownerDirectNudges: true,
        ownerDirectWhen: { var: "price_band", equals: "over_1m" },
        ownerDirectTemplate: "HIGH-VALUE HomeLight referral, kept for you."
      },
      {
        id: "card",
        type: "browse_extract",
        urlVar: "leadUrl",
        auth: { integrationLabel: "Home Light" },
        screenshot: true,
        when: { var: "claimed_agent", notEquals: "none" },
        fields: [
          { name: "lead_name", description: "the client's full name" },
          { name: "lead_phone", description: "the client's phone" },
          { name: "lead_email", description: "the client's email" },
          { name: "lead_address", description: "the property address" }
        ]
      },
      {
        id: "email_card",
        type: "email_extract",
        when: { var: "claimed_agent", notEquals: "none" },
        connectionId: CONNECTION_ID,
        fromContains: "homelight.com",
        fillOnlyEmpty: true,
        matchTemplates: ["{{vars.lead_first_name}}"],
        lookbackMinutes: 60,
        fields: [
          { name: "lead_phone", description: "labeled Phone" },
          { name: "lead_email", description: "labeled Email" },
          { name: "lead_address", description: "labeled Address" }
        ]
      },
      {
        id: "save_contact",
        type: "upsert_customer",
        when: { var: "claimed_agent", notEquals: "none" },
        phoneVar: "lead_phone",
        nameVar: "lead_name",
        emailVar: "lead_email"
      },
      {
        id: "to_agent",
        type: "send_sms",
        to: "{{vars.claimed_agent_phone}}",
        when: { var: "claimed_agent", notEquals: "none" },
        body: "HomeLight lead is yours: {{vars.lead_name}} {{vars.lead_phone}}"
      },
      {
        id: "qt_email",
        type: "send_email",
        to: "amy@amylaidlaw.com",
        subject: "{{vars.lead_name}} QT HL CC DAVE",
        body: "HomeLight referral claimed by {{vars.claimed_agent}}. QT attached.",
        attachScreenshot: true,
        when: { var: "claimed_agent", notEquals: "none" }
      },
      {
        id: "lead_sms",
        type: "send_sms",
        to: "{{vars.lead_phone}}",
        when: { var: "claimed_agent", notEquals: "none" },
        body: "Hi {{vars.lead_first_name}}, this is Amy Laidlaw (HomeSmart).",
        quietHours: {
          timezone: "America/Phoenix",
          noSendAfter: "21:00",
          resumeAt: "08:00",
          emailFallbackVar: "lead_email",
          emailSubject: "Regarding your recent Inquiry to Sell your Home on HomeLight"
        }
      },
      {
        id: "lead_email",
        type: "send_email",
        to: "{{vars.lead_email}}",
        subject: "Regarding your recent Inquiry to Sell your Home on HomeLight",
        body: "Hi {{vars.lead_first_name}}, re: your inquiry.",
        when: { var: "claimed_agent", notEquals: "none" }
      },
      {
        id: "notify",
        type: "notify_owner",
        when: { var: "claimed_agent", notEquals: "none" },
        message: "HomeLight referral: {{vars.lead_first_name}}. Outcome: {{vars.actions_taken}}."
      },
      {
        id: "notify_unclaimed",
        type: "notify_owner",
        when: { var: "claimed_agent", equals: "none" },
        message: "HomeLight referral: {{vars.lead_first_name}} not claimed."
      },
      {
        id: "bp_wait_minutes",
        type: "math",
        operation: "add",
        left: "{{vars.claimed_agent_eta_minutes}}",
        right: "60",
        saveAs: "report_wait_minutes"
      },
      {
        id: "bp_wait",
        type: "wait_for_reply",
        phoneVar: "claimed_agent_phone",
        saveAs: "agent_report",
        timeoutMinutes: 60,
        timeoutMinutesTemplate: "{{vars.report_wait_minutes}}"
      },
      {
        id: "bp_classify",
        type: "classify",
        when: { var: "agent_report", notEquals: "no_reply" },
        textVar: "agent_report",
        saveAs: "agent_report_class",
        question: "The team member's follow-up about that lead.",
        categories: [
          { value: "bad_phone_number", description: "says the phone is bad" },
          { value: "other_update", description: "any other update" }
        ]
      },
      {
        id: "bp_branch",
        type: "branch",
        question: "Did the team member report a bad phone number?",
        branches: [
          {
            id: "bp_bad_phone",
            label: "Bad phone number reported",
            condition: { var: "agent_report_class", equals: "bad_phone_number" },
            steps: [
              {
                id: "bp_email_amy",
                type: "send_email",
                to: "amy@amylaidlaw.com",
                subject: "BAD PHONE NUMBER, {{vars.lead_name}}",
                body: "{{vars.claimed_agent}} reported a bad number."
              }
            ]
          }
        ],
        else: [
          {
            id: "bp_forward",
            type: "notify_owner",
            when: { var: "agent_report", notEquals: "no_reply" },
            message: "Update from {{vars.claimed_agent}}: {{vars.agent_report}}"
          }
        ]
      }
    ]
  };
}

/** The live shape must itself be valid, or every assertion below is worthless. */
function armOf(def: Definition, branchId: string): Step[] {
  const branch = findStep(def, branchId);
  if (!branch) throw new Error(`branch ${branchId} missing`);
  const arms = branch.branches as Array<{ steps?: Step[] }>;
  return arms[0].steps ?? [];
}

function trunkIds(def: Definition): string[] {
  return (def.steps ?? []).map((s) => String(s.id));
}

describe("HomeLight late-contact one-shot: fixture", () => {
  it("the replica of the live flow is valid before any patch", () => {
    const def = parseAiFlowDefinition(liveShape());
    expect(validateDefinitionSemantics(def)).toEqual([]);
    expect(def.steps).toHaveLength(17);
  });
});

describe("addSentinels", () => {
  it("adds the found/missing sentinel to email_card and already_claimed to card", () => {
    const def = liveShape();
    expect(addSentinels(def)).toBe(true);
    const emailCard = findStep(def, "email_card")!;
    const card = findStep(def, "card")!;
    expect(emailCard.fields?.map((f) => f.name)).toContain(CONTACT_STATUS_VAR);
    expect(card.fields?.map((f) => f.name)).toContain(ALREADY_CLAIMED_VAR);
    // The sentinel must tell the model exactly which two words to answer.
    const desc = emailCard.fields?.find((f) => f.name === CONTACT_STATUS_VAR)?.description ?? "";
    expect(desc).toContain("found");
    expect(desc).toContain("missing");
  });

  it("keeps the original extraction fields untouched", () => {
    const def = liveShape();
    addSentinels(def);
    expect(findStep(def, "email_card")!.fields?.map((f) => f.name)).toEqual([
      "lead_phone",
      "lead_email",
      "lead_address",
      CONTACT_STATUS_VAR
    ]);
  });

  it("is idempotent", () => {
    const def = liveShape();
    expect(addSentinels(def)).toBe(true);
    expect(addSentinels(def)).toBe(false);
  });

  it("throws loudly when the flow no longer has the expected steps", () => {
    const def = liveShape();
    def.steps = (def.steps ?? []).filter((s) => s.id !== "email_card");
    expect(() => addSentinels(def)).toThrow(/email_card/);
    const noCard = liveShape();
    noCard.steps = (noCard.steps ?? []).filter((s) => s.id !== "card");
    expect(() => addSentinels(noCard)).toThrow(/"card"/);
  });
});

describe("addRung1", () => {
  it("inserts one trunk branch right after notify_unclaimed", () => {
    const def = liveShape();
    addSentinels(def);
    expect(addRung1(def, 10)).toBe(true);
    const ids = trunkIds(def);
    expect(ids[ids.indexOf("notify_unclaimed") + 1]).toBe(RUNG_1_BRANCH_ID);
    expect(ids).toHaveLength(18);
  });

  it("gates on the first-pass sentinel, which doubles as the claim gate", () => {
    const def = liveShape();
    addSentinels(def);
    addRung1(def, 10);
    const arms = findStep(def, RUNG_1_BRANCH_ID)!.branches as Array<{ condition?: unknown }>;
    expect(arms[0].condition).toEqual({ var: CONTACT_STATUS_VAR, equals: "missing" });
  });

  it("sleeps, re-reads the mailbox, then delivers to the claimer and the lead", () => {
    const def = liveShape();
    addSentinels(def);
    addRung1(def, 10);
    const arm = armOf(def, RUNG_1_BRANCH_ID);
    expect(arm.map((s) => s.type)).toEqual([
      "sleep",
      "email_extract",
      "upsert_customer",
      "send_sms",
      "notify_owner",
      "send_sms",
      "send_email"
    ]);
    expect(arm[0].minutes).toBe(10);
    // The re-read reuses the flow's own mailbox config and backfills only gaps.
    expect(arm[1].connectionId).toBe(CONNECTION_ID);
    expect(arm[1].fromContains).toBe("homelight.com");
    expect(arm[1].fillOnlyEmpty).toBe(true);
    expect(arm[1].fields?.map((f) => f.name)).toEqual([
      "lead_phone",
      "lead_email",
      "lead_address",
      RUNG_1_STATUS_VAR
    ]);
    // Every delivery step waits for the FRESH sentinel, not the stale one.
    for (const step of arm.slice(2)) {
      expect(step.when).toEqual({ var: RUNG_1_STATUS_VAR, equals: "found" });
    }
    expect(arm[3].to).toBe("{{vars.claimed_agent_phone}}");
  });

  it("re-sends the owner's exact intro copy rather than a second version of it", () => {
    const def = liveShape();
    addSentinels(def);
    addRung1(def, 10);
    const arm = armOf(def, RUNG_1_BRANCH_ID);
    const original = findStep(liveShape(), "lead_sms")!;
    const clone = arm.find((s) => s.id === "late_lead_sms")!;
    expect(clone.body).toBe(original.body);
    expect(clone.quietHours).toEqual(original.quietHours);
    expect(clone.to).toBe(original.to);
    const originalEmail = findStep(liveShape(), "lead_email")!;
    const cloneEmail = arm.find((s) => s.id === "late_lead_email")!;
    expect(cloneEmail.body).toBe(originalEmail.body);
    expect(cloneEmail.subject).toBe(originalEmail.subject);
  });

  it("is idempotent and honors the configured wait", () => {
    const def = liveShape();
    addSentinels(def);
    expect(addRung1(def, 25)).toBe(true);
    expect(addRung1(def, 25)).toBe(false);
    expect(armOf(def, RUNG_1_BRANCH_ID)[0].minutes).toBe(25);
  });

  it("throws when the anchor step is gone", () => {
    const def = liveShape();
    addSentinels(def);
    def.steps = (def.steps ?? []).filter((s) => s.id !== "notify_unclaimed");
    expect(() => addRung1(def, 10)).toThrow(/notify_unclaimed/);
  });
});

describe("addRung2", () => {
  it("appends after the agent-report block so it adds no new dead time", () => {
    const def = liveShape();
    addSentinels(def);
    addRung1(def, 10);
    expect(addRung2(def, 60)).toBe(true);
    const ids = trunkIds(def);
    expect(ids[ids.length - 1]).toBe(RUNG_2_BRANCH_ID);
    expect(ids.indexOf("bp_branch")).toBeLessThan(ids.indexOf(RUNG_2_BRANCH_ID));
  });

  it("fires only when rung 1 RAN and still came up empty", () => {
    // equals "missing", not notEquals "found": an unset var (rung 1 never ran
    // because the details arrived on the first pass) must NOT re-read the
    // mailbox and re-text the claimer.
    const def = liveShape();
    addSentinels(def);
    addRung1(def, 10);
    addRung2(def, 60);
    const arms = findStep(def, RUNG_2_BRANCH_ID)!.branches as Array<{ condition?: unknown }>;
    expect(arms[0].condition).toEqual({ var: RUNG_1_STATUS_VAR, equals: "missing" });
  });

  it("uses its own fresh sentinel so fillOnlyEmpty cannot serve a stale value", () => {
    const def = liveShape();
    addSentinels(def);
    addRung1(def, 10);
    addRung2(def, 60);
    const arm = armOf(def, RUNG_2_BRANCH_ID);
    const read = arm.find((s) => s.type === "email_extract")!;
    expect(read.fields?.map((f) => f.name)).toContain(RUNG_2_STATUS_VAR);
    expect(read.fields?.map((f) => f.name)).not.toContain(RUNG_1_STATUS_VAR);
    expect(read.lookbackMinutes).toBe(240);
  });

  it("tells the claimer and the owner when the details never arrived at all", () => {
    const def = liveShape();
    addSentinels(def);
    addRung1(def, 10);
    addRung2(def, 60);
    const arm = armOf(def, RUNG_2_BRANCH_ID);
    const never = arm.filter((s) =>
      JSON.stringify(s.when ?? {}) === JSON.stringify({ var: RUNG_2_STATUS_VAR, equals: "missing" })
    );
    expect(never.map((s) => s.type)).toEqual(["send_sms", "notify_owner"]);
    expect(never[0].to).toBe("{{vars.claimed_agent_phone}}");
    expect(String(never[1].message)).toContain("never sent");
  });

  it("is idempotent", () => {
    const def = liveShape();
    addSentinels(def);
    addRung1(def, 10);
    expect(addRung2(def, 60)).toBe(true);
    expect(addRung2(def, 60)).toBe(false);
  });
});

describe("addAlreadyClaimedGuard", () => {
  it("moves the post-claim sends into a still-ours arm, verbatim", () => {
    const def = liveShape();
    const before = GUARDED_SEND_IDS.map((id) => JSON.stringify(findStep(liveShape(), id)));
    expect(addAlreadyClaimedGuard(def)).toBe(true);
    const arm = armOf(def, LOST_BRANCH_ID);
    expect(arm.map((s) => s.id)).toEqual([...GUARDED_SEND_IDS]);
    // Byte-identical: each step keeps its own claim gate and its copy.
    expect(arm.map((s) => JSON.stringify(s))).toEqual(before);
  });

  it("puts the branch where the sends were and leaves the rest of the trunk alone", () => {
    const def = liveShape();
    addAlreadyClaimedGuard(def);
    expect(trunkIds(def)).toEqual([
      "url",
      "alert",
      "open",
      "route",
      "card",
      "email_card",
      LOST_BRANCH_ID,
      "notify_unclaimed",
      "bp_wait_minutes",
      "bp_wait",
      "bp_classify",
      "bp_branch"
    ]);
  });

  it("takes the still-ours arm unless the page said another agent has it", () => {
    // notEquals "yes" so an UNSET var (nobody claimed, so `card` never ran)
    // still takes the arm; the steps inside then skip on their own claim gate.
    const def = liveShape();
    addAlreadyClaimedGuard(def);
    const arms = findStep(def, LOST_BRANCH_ID)!.branches as Array<{ condition?: unknown }>;
    expect(arms[0].condition).toEqual({ var: ALREADY_CLAIMED_VAR, notEquals: "yes" });
  });

  it("tells the claimer and the owner instead of ending the run silently", () => {
    const def = liveShape();
    addAlreadyClaimedGuard(def);
    const lost = findStep(def, LOST_BRANCH_ID)!.else as Step[];
    expect(lost.map((s) => s.type)).toEqual(["send_sms", "notify_owner"]);
    expect(lost[0].to).toBe("{{vars.claimed_agent_phone}}");
    for (const step of lost) {
      expect(step.when).toEqual({ var: "claimed_agent", notEquals: "none" });
      expect(String(step.body ?? step.message)).toContain("another agent");
    }
  });

  it("is idempotent", () => {
    const def = liveShape();
    expect(addAlreadyClaimedGuard(def)).toBe(true);
    expect(addAlreadyClaimedGuard(def)).toBe(false);
  });

  it("throws when a guarded send is missing", () => {
    const def = liveShape();
    def.steps = (def.steps ?? []).filter((s) => s.id !== "qt_email");
    expect(() => addAlreadyClaimedGuard(def)).toThrow(/qt_email/);
  });
});

describe("dropDeadClaimLink", () => {
  it("removes the offer line that always rendered empty", () => {
    const def = liveShape();
    expect(String(findStep(def, "route")!.offerTemplate)).toContain(DEAD_CLAIM_LINE);
    expect(dropDeadClaimLink(def)).toBe(true);
    const offer = String(findStep(def, "route")!.offerTemplate);
    expect(offer).not.toContain("Direct claim button");
    expect(offer).not.toContain("claim_link");
    // The lines around it survive intact.
    expect(offer).toContain("no phone number to call): {{vars.leadUrl}}\nReply 1 to claim");
  });

  it("retires extractLinks but keeps the step readable (and its screenshot)", () => {
    const def = liveShape();
    dropDeadClaimLink(def);
    const open = findStep(def, "open")!;
    expect(open.extractLinks).toBeUndefined();
    expect(open.screenshot).toBe(true);
    // browse_extract needs fields or extractLinks; the already-claimed read
    // takes over, and it runs even for a referral nobody claims.
    expect(open.fields?.map((f) => f.name)).toEqual([ALREADY_CLAIMED_VAR]);
  });

  it("is idempotent", () => {
    const def = liveShape();
    expect(dropDeadClaimLink(def)).toBe(true);
    expect(dropDeadClaimLink(def)).toBe(false);
  });

  it("throws when the offer or browse step is gone", () => {
    const noRoute = liveShape();
    noRoute.steps = (noRoute.steps ?? []).filter((s) => s.id !== "route");
    expect(() => dropDeadClaimLink(noRoute)).toThrow(/route/);
    const noOpen = liveShape();
    noOpen.steps = (noOpen.steps ?? []).filter((s) => s.id !== "open");
    expect(() => dropDeadClaimLink(noOpen)).toThrow(/open/);
  });
});

describe("patchDefinition (the whole patch, as applied)", () => {
  it("reports every edit and leaves the definition valid", () => {
    const def = liveShape();
    const applied = patchDefinition(def, MINUTES);
    expect(applied).toEqual([
      "sentinels",
      "retry rung 1",
      "retry rung 2",
      "already-claimed guard",
      "dead claim-button line"
    ]);
    const parsed = parseAiFlowDefinition(def);
    expect(validateDefinitionSemantics(parsed)).toEqual([]);
  });

  it("stays under the 25-step trunk cap", () => {
    const def = liveShape();
    patchDefinition(def, MINUTES);
    // 17 trunk steps, minus the 6 sends folded into the guard, plus 3 branches.
    expect(def.steps).toHaveLength(14);
    expect((def.steps ?? []).length).toBeLessThanOrEqual(25);
  });

  it("keeps every original step id somewhere, so parked runs can still resume", () => {
    const def = liveShape();
    const idsBefore: string[] = [];
    for (const s of liveShape().steps ?? []) idsBefore.push(String(s.id));
    patchDefinition(def, MINUTES);
    for (const id of idsBefore) {
      expect(findStep(def, id), `step ${id} must survive the patch`).not.toBeNull();
    }
  });

  it("is idempotent: a second run changes nothing", () => {
    const def = liveShape();
    patchDefinition(def, MINUTES);
    const after = JSON.stringify(def);
    expect(patchDefinition(def, MINUTES)).toEqual([]);
    expect(JSON.stringify(def)).toBe(after);
  });

  it("does not touch the trigger, the options, or the routing rules", () => {
    const def = liveShape();
    const original = liveShape();
    patchDefinition(def, MINUTES);
    expect(def.trigger).toEqual(original.trigger);
    expect(def.options).toEqual(original.options);
    const route = findStep(def, "route")!;
    const routeBefore = findStep(original, "route")!;
    expect(route.agentNames).toEqual(routeBefore.agentNames);
    expect(route.ownerDirectWhen).toEqual(routeBefore.ownerDirectWhen);
    expect(route.ownerDirectTemplate).toEqual(routeBefore.ownerDirectTemplate);
    expect(route.claimedNotifyEmail).toEqual(routeBefore.claimedNotifyEmail);
  });

  it("adds no new lead-facing copy: every intro send quotes the originals", () => {
    const def = liveShape();
    const original = liveShape();
    patchDefinition(def, MINUTES);
    const smsBody = findStep(original, "lead_sms")!.body;
    const emailBody = findStep(original, "lead_email")!.body;
    for (const id of ["late_lead_sms", "late2_lead_sms"]) {
      expect(findStep(def, id)!.body).toBe(smsBody);
    }
    for (const id of ["late_lead_email", "late2_lead_email"]) {
      expect(findStep(def, id)!.body).toBe(emailBody);
    }
  });
});
