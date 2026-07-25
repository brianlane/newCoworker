import { describe, expect, it } from "vitest";
import {
  parseAiFlowDefinition,
  validateDefinitionSemantics,
  type AiFlowDefinition
} from "@/lib/ai-flows/schema";
import {
  aiCallVoiceDefinition,
  AI_CALL_FLOW_NAME,
  planVoiceCutover,
  type VoiceFlowRow
} from "../scripts/oneshot/seed-homelight-ai-call-voice-flow";
import {
  addCallBrief,
  addClaimClick,
  addLeadNotesField,
  AI_ON_CALL_LINE,
  BRIEF_STEP_ID,
  CLICK_STEP_ID,
  rewordOffer
} from "../scripts/oneshot/homelight-ai-call-referral-patch";

const HOMELIGHT = "+14159851909";
const DAVE = "+16025245719";
const AMY = "+16026951142";

describe("aiCallVoiceDefinition", () => {
  const built = () =>
    aiCallVoiceDefinition({ fromE164: HOMELIGHT, daveE164: DAVE, amyE164: AMY }) as Record<
      string,
      unknown
    >;

  it("is a valid voice flow triggered by HomeLight's live-transfer line", () => {
    const def = parseAiFlowDefinition(built());
    expect(validateDefinitionSemantics(def)).toEqual([]);
    expect(def.trigger).toMatchObject({ channel: "voice", fromE164: HOMELIGHT });
  });

  it("has the AI answer first, with the humans kept as the fallback", () => {
    const def = parseAiFlowDefinition(built());
    // The ring steps still exist: that is what makes the safety net structural.
    expect(def.steps.map((s) => s.type)).toEqual([
      "ring_handoff",
      "ring_handoff",
      "voice_ai_intake"
    ]);
    const intake = def.steps[2];
    if (intake.type !== "voice_ai_intake") throw new Error("expected the intake last");
    expect(intake.answerFirst).toBe(true);
    expect(def.steps[0]).toMatchObject({ toE164: DAVE });
    expect(def.steps[1]).toMatchObject({ toE164: AMY });
  });

  it("presses 1 after the announcement and holds the greeting for the seller dial", () => {
    const def = parseAiFlowDefinition(built());
    const intake = def.steps[2];
    if (intake.type !== "voice_ai_intake") throw new Error("expected intake");
    expect(intake.acceptDigits).toEqual([{ digit: "1", afterSeconds: 3 }]);
    expect(intake.mediaStartSeconds).toBe(2);
  });

  it("texts the details to Dave with a copy to Amy, and knows the alert", () => {
    const def = parseAiFlowDefinition(built());
    const intake = def.steps[2];
    if (intake.type !== "voice_ai_intake") throw new Error("expected intake");
    expect(intake.notifyE164).toBe(DAVE);
    expect(intake.alsoNotifyE164).toBe(AMY);
    expect(intake.briefFromSmsContaining).toBe("HomeLight Referral");
  });

  it("keeps the alerts star-framed", () => {
    expect(parseAiFlowDefinition(built()).options?.starAlerts).toBe(true);
  });

  it("captures the callback number, since the AI never dialed the seller", () => {
    const def = parseAiFlowDefinition(built());
    const intake = def.steps[2];
    if (intake.type !== "voice_ai_intake") throw new Error("expected intake");
    expect(intake.captureFields).toContain("phone");
    expect(intake.captureFields).toContain("address");
  });
});

describe("planVoiceCutover", () => {
  const OLD: VoiceFlowRow = { id: "old", name: "Voice routing (+1415...)", enabled: true };
  const MINE_OFF: VoiceFlowRow = { id: "mine", name: AI_CALL_FLOW_NAME, enabled: false };
  const MINE_ON: VoiceFlowRow = { id: "mine", name: AI_CALL_FLOW_NAME, enabled: true };
  const plan = (existing: VoiceFlowRow[], enable: boolean, legacyChainLive = true) =>
    planVoiceCutover({ existing, flowName: AI_CALL_FLOW_NAME, enable, legacyChainLive });

  it("first pass without --enable seeds and touches nothing else", () => {
    // A bare --apply must be a safe preview: the tenant keeps working routing.
    expect(plan([OLD], false)).toEqual({
      seed: true,
      enableExistingId: null,
      disableFlowIds: [],
      disableLegacyChain: false
    });
  });

  it("ENABLES the already-seeded copy on the second pass, before disabling the old", () => {
    // The documented cutover is --apply then --apply --enable. Without this the
    // old flows would go off while the replacement stayed off too, leaving the
    // caller with no routing at all.
    expect(plan([OLD, MINE_OFF], true)).toEqual({
      seed: false,
      enableExistingId: "mine",
      disableFlowIds: ["old"],
      disableLegacyChain: true
    });
  });

  it("seeds and cuts over in one pass when --apply --enable runs first", () => {
    expect(plan([OLD], true)).toEqual({
      seed: true,
      enableExistingId: null,
      disableFlowIds: ["old"],
      disableLegacyChain: true
    });
  });

  it("is a no-op once the copy is live and the old routing is off", () => {
    expect(plan([{ ...OLD, enabled: false }, MINE_ON], true, false)).toEqual({
      seed: false,
      enableExistingId: null,
      disableFlowIds: [],
      disableLegacyChain: false
    });
  });

  it("never disables its own copy, whatever else matches the caller", () => {
    const p = plan([OLD, MINE_ON, { id: "other", name: "Another", enabled: true }], true);
    expect(p.disableFlowIds).toEqual(["old", "other"]);
    expect(p.disableFlowIds).not.toContain("mine");
  });

  it("leaves an already-off legacy chain alone", () => {
    expect(plan([OLD], true, false).disableLegacyChain).toBe(false);
  });
});

/**
 * Amy's live flow, trimmed to the steps this patch touches (the shape PR #913
 * left behind: an `open` browse carrying the already_claimed sentinel, the
 * broadcast offer, and the post-claim `card` read).
 */
function referralFlow(): Record<string, unknown> {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: 15,
      conditions: [{ type: "has_url" }, { type: "contains", value: "HomeLight Referral" }]
    },
    steps: [
      { id: "url", type: "extract_url", saveAs: "leadUrl" },
      {
        id: "alert",
        type: "extract_text",
        fields: [
          { name: "lead_first_name", description: "First name" },
          { name: "price", description: "Price" },
          { name: "city", description: "City" },
          { name: "lead_type", description: "buyer or seller" }
        ]
      },
      {
        id: "open",
        type: "browse_extract",
        urlVar: "leadUrl",
        auth: { integrationLabel: "Home Light" },
        screenshot: true,
        fields: [
          {
            name: "already_claimed",
            description: "yes if this referral was already claimed, no otherwise"
          }
        ]
      },
      {
        id: "route",
        type: "route_to_team",
        agentNames: ["Dave Lane", "Amy Laidlaw"],
        responseMinutes: 5,
        offerTemplate:
          "New HomeLight referral: {{vars.lead_first_name}}, {{vars.lead_type}} in {{vars.city}} (~{{vars.price}}).\n" +
          "Tap to claim and click button to have homelight call you (no phone number to call): {{vars.leadUrl}}\n" +
          "Reply 1 to claim or 2 to pass by {{offer.deadline}}.\n" +
          "First to reply 1 gets it.",
        ownerFallbackTemplate:
          "No one claimed {{vars.lead_first_name}} in time, it's back to you.\n" +
          "Tap to claim and have it call you: {{vars.leadUrl}}"
      },
      {
        id: "card",
        type: "browse_extract",
        urlVar: "leadUrl",
        auth: { integrationLabel: "Home Light" },
        when: { var: "claimed_agent", notEquals: "none" },
        fields: [
          { name: "lead_name", description: "Client full name" },
          { name: "lead_phone", description: "Client phone" },
          { name: "lead_address", description: "Property address" }
        ]
      },
      {
        id: "to_agent",
        type: "send_sms",
        to: "{{vars.claimed_agent_phone}}",
        body: "HomeLight lead is yours: {{vars.lead_name}} {{vars.lead_phone}}",
        when: { var: "claimed_agent", notEquals: "none" }
      }
    ],
    options: { suppressDefaultReply: true }
  };
}

type Def = { steps?: Array<Record<string, unknown>> } & Record<string, unknown>;

/** Apply all four edits the way the script does. */
function patched(): Def {
  const def = referralFlow() as Def;
  rewordOffer(def);
  addClaimClick(def, "Call me to claim referral");
  addLeadNotesField(def);
  addCallBrief(def, HOMELIGHT);
  return def;
}

describe("rewordOffer", () => {
  it("says the AI is on the call and asks who takes the follow-up", () => {
    const def = referralFlow() as Def;
    expect(rewordOffer(def)).toBe(true);
    const offer = String(
      (def.steps ?? []).find((s) => s.type === "route_to_team")?.offerTemplate ?? ""
    );
    expect(offer).toContain(AI_ON_CALL_LINE);
    expect(offer).toContain("Reply 1 to take the follow-up or 2 to pass");
    // The stale instruction to claim so HomeLight calls YOU is gone.
    expect(offer).not.toContain("have homelight call you");
    // The lead summary still leads, and the portal link survives.
    expect(offer.split("\n")[0]).toContain("New HomeLight referral:");
    expect(offer).toContain("Portal: {{vars.leadUrl}}");
    // Every other line is untouched.
    expect(offer).toContain("First to reply 1 gets it.");
  });

  it("stops the owner fallback from triggering a second call", () => {
    // "Tap to claim and have it call you" would have HomeLight ring Amy on a
    // referral the AI already took.
    const def = referralFlow() as Def;
    rewordOffer(def);
    const fallback = String(
      (def.steps ?? []).find((s) => s.type === "route_to_team")?.ownerFallbackTemplate ?? ""
    );
    expect(fallback).not.toContain("have it call you");
    expect(fallback).toContain("Portal: {{vars.leadUrl}}");
    // The rest of the fallback wording is untouched.
    expect(fallback).toContain("it's back to you.");
  });

  it("is idempotent", () => {
    const def = referralFlow() as Def;
    expect(rewordOffer(def)).toBe(true);
    expect(rewordOffer(def)).toBe(false);
  });

  it("leaves a flow with no route step alone", () => {
    const def = { steps: [{ id: "x", type: "notify_owner", message: "hi" }] } as Def;
    expect(rewordOffer(def)).toBe(false);
  });
});

describe("addClaimClick", () => {
  it("clicks the button right after the sentinel read, gated on not-yet-claimed", () => {
    const def = referralFlow() as Def;
    expect(addClaimClick(def, "Call me to claim referral")).toBe(true);
    const ids = (def.steps ?? []).map((s) => s.id);
    // Between the sentinel read and the offer: the referral is ours before
    // anyone is asked about the follow-up.
    expect(ids.indexOf(CLICK_STEP_ID)).toBe(ids.indexOf("open") + 1);
    expect(ids.indexOf(CLICK_STEP_ID)).toBeLessThan(ids.indexOf("route"));
    const click = (def.steps ?? []).find((s) => s.id === CLICK_STEP_ID)!;
    expect(click).toMatchObject({
      type: "browse_action",
      urlVar: "leadUrl",
      // Reuses the credentialed portal session the read already used.
      auth: { integrationLabel: "Home Light" },
      actions: [{ kind: "click_text", target: "Call me to claim referral" }],
      when: { var: "already_claimed", equals: "no" }
    });
  });

  it("is idempotent and refuses a flow with no already_claimed sentinel", () => {
    const def = referralFlow() as Def;
    expect(addClaimClick(def, "Call me to claim referral")).toBe(true);
    expect(addClaimClick(def, "Call me to claim referral")).toBe(false);
    // Without the sentinel there is nothing to gate on, so the script bails
    // rather than clicking an already-claimed referral into a second call.
    const bare = { steps: [{ id: "url", type: "extract_url", saveAs: "leadUrl" }] } as Def;
    expect(addClaimClick(bare, "Call me to claim referral")).toBe(false);
  });
});

describe("addLeadNotesField / addCallBrief", () => {
  it("reads the client notes the page always had and never extracted", () => {
    const def = referralFlow() as Def;
    expect(addLeadNotesField(def)).toBe(true);
    const fields = (def.steps ?? []).find((s) => s.id === "card")!.fields as Array<{
      name: string;
    }>;
    expect(fields.map((f) => f.name)).toContain("lead_notes");
    expect(addLeadNotesField(def)).toBe(false);
  });

  it("briefs the live call straight after the card read, on the same claim gate", () => {
    const def = referralFlow() as Def;
    addLeadNotesField(def);
    expect(addCallBrief(def, HOMELIGHT)).toBe(true);
    const ids = (def.steps ?? []).map((s) => s.id);
    expect(ids.indexOf(BRIEF_STEP_ID)).toBe(ids.indexOf("card") + 1);
    const brief = (def.steps ?? []).find((s) => s.id === BRIEF_STEP_ID)!;
    expect(brief).toMatchObject({
      type: "voice_brief",
      fromE164: HOMELIGHT,
      withinMinutes: 30,
      when: { var: "claimed_agent", notEquals: "none" }
    });
    expect(String(brief.noteTemplate)).toContain("{{vars.lead_notes}}");
    expect(addCallBrief(def, HOMELIGHT)).toBe(false);
  });

  it("does nothing when the flow has no card read", () => {
    const bare = { steps: [{ id: "url", type: "extract_url", saveAs: "leadUrl" }] } as Def;
    expect(addLeadNotesField(bare)).toBe(false);
    expect(addCallBrief(bare, HOMELIGHT)).toBe(false);
    // A card step without a fields array is left alone too.
    const noFields = { steps: [{ id: "card", type: "browse_extract", urlVar: "leadUrl" }] } as Def;
    expect(addLeadNotesField(noFields)).toBe(false);
  });
});

describe("the patched referral flow as a whole", () => {
  it("stays valid under the authoring schema", () => {
    const def = parseAiFlowDefinition(patched() as AiFlowDefinition);
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("keeps the claim gate and every original step id", () => {
    // claimed_agent is what unlocks the details pipeline, and a run parked at a
    // later step resumes BY ID, so no id may change.
    const before = (referralFlow() as Def).steps!.map((s) => s.id);
    const after = patched().steps!.map((s) => s.id);
    for (const id of before) expect(after).toContain(id);
    expect(after).toContain(CLICK_STEP_ID);
    expect(after).toContain(BRIEF_STEP_ID);
    const json = JSON.stringify(patched());
    expect(json).toContain("claimed_agent_phone");
    expect(json).toContain("route_to_team");
  });

  it("is idempotent end to end", () => {
    const once = patched();
    const twice = JSON.parse(JSON.stringify(once)) as Def;
    rewordOffer(twice);
    addClaimClick(twice, "Call me to claim referral");
    addLeadNotesField(twice);
    addCallBrief(twice, HOMELIGHT);
    expect(twice).toEqual(once);
  });
});
