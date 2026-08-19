import { describe, it, expect } from "vitest";
import {
  ADD_NOTE_OPENER,
  AUTH_LABEL,
  GATE_OURS_ARM_ID,
  GATE_STEP_ID,
  NAMED_ARM_ID,
  NAMED_BRANCH_ID,
  NOTE_EXPECT,
  NOTE_STEP_ID,
  NOTE_SUBMIT,
  NOTE_TEXT,
  NOTE_TEXTAREA,
  URL_VAR,
  addPortalNote,
  allStepIds,
  buildPortalNote,
  noteActions
} from "../scripts/oneshot/amy-homelight-portal-note-definition";
import {
  parseAiFlowDefinition,
  validateDefinitionSemantics,
  type AiFlowDefinition
} from "@/lib/ai-flows/schema";

/**
 * Pins the HomeLight portal-note gate (plan Phase 4b).
 *
 * Every selector here is a click/fill target read live headless through Amy's
 * render sidecar on 2026-08-19; a reworded data-test breaks the write
 * silently, and this is the file that should fail first. The name click is a
 * TEMPLATED target (`{{vars.lead_name}}`), which the runtime renders at plan
 * time; a search-box fill was tried instead and raced the SPA list re-render
 * onto the wrong referral.
 */

/** A trunk shaped like the live "HomeLight Referral" flow (4a3b03f4). */
function liveish(): AiFlowDefinition {
  return parseAiFlowDefinition({
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: 2,
      conditions: [{ type: "has_url" }, { type: "contains", value: "HomeLight" }]
    },
    steps: [
      { id: "url", type: "extract_url", saveAs: URL_VAR },
      {
        id: "card",
        type: "browse_extract",
        urlVar: URL_VAR,
        auth: { integrationLabel: AUTH_LABEL },
        fields: [
          { name: "lead_name", description: "the client's full name, or none" },
          { name: "lead_phone", description: "the client's phone, or none" },
          { name: "already_claimed", description: "yes when another agent holds it" }
        ]
      },
      {
        id: "route",
        type: "route_to_team",
        offerTemplate: "New HomeLight referral {{vars.lead_name}}, reply 1",
        ownerFallbackTemplate: "Nobody claimed {{vars.lead_name}}"
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
                when: { var: "claimed_agent", notEquals: "none" },
                to: "{{vars.claimed_agent_phone}}",
                body: "Lead assigned: {{vars.lead_name}} {{vars.lead_phone}}"
              }
            ]
          }
        ],
        else: []
      },
      {
        id: "bp_wait",
        type: "wait_for_reply",
        saveAs: "agent_report",
        phoneVar: "claimed_agent_phone",
        timeoutMinutes: 60
      }
    ]
  } as unknown as Record<string, unknown>);
}

describe("noteActions", () => {
  it("navigates, posts, and re-clicks the opener as the submit proof", () => {
    expect(noteActions()).toEqual([
      { kind: "click_text", target: "Referrals" },
      { kind: "click_text", target: "{{vars.lead_name}}" },
      { kind: "click_selector", target: ADD_NOTE_OPENER },
      { kind: "fill_selector", target: NOTE_TEXTAREA, valueTemplate: NOTE_TEXT },
      { kind: "click_selector", target: NOTE_SUBMIT },
      // The editor REPLACES the opener while open, so this click can only
      // land after the form accepted the submit and the editor closed. A
      // swallowed submit leaves the editor up and fails the step loudly,
      // and with the fresh editor's textarea empty, the expectText fragment
      // can only be satisfied by the activity feed showing the posted note,
      // never by the typed draft.
      { kind: "click_selector", target: ADD_NOTE_OPENER }
    ]);
  });

  it("pins the drawer selectors read live on 2026-08-19", () => {
    expect(ADD_NOTE_OPENER).toBe('[data-test="referral-detail-modal-add-note-button"]');
    expect(NOTE_TEXTAREA).toBe('[data-test="referral-add-note-textarea"]');
    expect(NOTE_SUBMIT).toBe('[data-test="referral-add-note-btn"]');
  });

  it("the note is the honest actions_taken log and the expect is its leading fragment", () => {
    expect(NOTE_TEXT).toContain("{{vars.actions_taken}}");
    expect(NOTE_TEXT.startsWith(NOTE_EXPECT)).toBe(true);
  });
});

describe("addPortalNote", () => {
  it("appends the gate as the LAST trunk step and reports the new ids", () => {
    const def = liveish();
    const trunkBefore = def.steps.length;
    const added = addPortalNote(def);
    expect(added).toEqual([
      GATE_STEP_ID,
      GATE_OURS_ARM_ID,
      NAMED_BRANCH_ID,
      NAMED_ARM_ID,
      NOTE_STEP_ID
    ]);

    // End of trunk, deliberately: a note failure is classified permanent, and
    // mid-trunk it would dead-letter the late-contact ladder and the
    // claimed-agent report steps behind it (Bugbot, PR #1527).
    expect(def.steps).toHaveLength(trunkBefore + 1);
    const gate = def.steps[def.steps.length - 1] as unknown as {
      id: string;
      type: string;
      else: unknown[];
      branches: Array<{
        id: string;
        condition: Record<string, unknown>;
        steps: Array<Record<string, unknown>>;
      }>;
    };
    expect(gate.id).toBe(GATE_STEP_ID);
    expect(gate.type).toBe("branch");
    expect(gate.else).toEqual([]);
    // Three guards ANDed across the nesting: ours -> named -> claimed.
    expect(gate.branches[0].condition).toEqual({ var: "already_claimed", notEquals: "yes" });
    const named = gate.branches[0].steps[0] as {
      id: string;
      branches: Array<{ condition: Record<string, unknown>; steps: Array<Record<string, unknown>> }>;
    };
    expect(named.id).toBe(NAMED_BRANCH_ID);
    expect(named.branches[0].condition).toEqual({ var: "lead_name", notEquals: "none" });
    const note = named.branches[0].steps[0];
    expect(note).toMatchObject({
      id: NOTE_STEP_ID,
      type: "browse_action",
      when: { var: "claimed_agent", notEquals: "none" },
      auth: { integrationLabel: AUTH_LABEL },
      urlVar: URL_VAR,
      expectText: NOTE_EXPECT,
      screenshot: true
    });
    expect((note as { actions: unknown }).actions).toEqual(noteActions());
  });

  it("does not rename or remove any existing step id", () => {
    const def = liveish();
    const existing = allStepIds(def);
    addPortalNote(def);
    for (const id of existing) expect(allStepIds(def)).toContain(id);
  });

  it("is idempotent: a second application adds nothing", () => {
    const def = liveish();
    addPortalNote(def);
    expect(addPortalNote(def)).toEqual([]);
    expect(allStepIds(def).filter((id) => id === GATE_STEP_ID)).toHaveLength(1);
  });

  it("throws when the flow no longer produces a var the guards depend on", () => {
    const def = liveish();
    const card = def.steps.find((s) => s.id === "card") as unknown as {
      fields: Array<{ name: string }>;
    };
    card.fields = card.fields.filter((f) => f.name !== "already_claimed");
    expect(() => addPortalNote(def)).toThrow(/no longer produces already_claimed/);
  });

  it("throws when there is no route_to_team to produce claimed_agent", () => {
    const def = liveish();
    def.steps = def.steps.filter((s) => s.id !== "route");
    expect(() => addPortalNote(def)).toThrow(/claimed_agent/);
  });
});

describe("buildPortalNote", () => {
  it("returns a mutated copy that still parses and passes semantic validation", () => {
    const live = liveish();
    const { definition, added } = buildPortalNote(live);
    expect(added).toHaveLength(5);
    // The input is untouched (the applier keeps it as the ledger `previous`).
    expect(allStepIds(live)).not.toContain(GATE_STEP_ID);
    const parsed = parseAiFlowDefinition(JSON.parse(JSON.stringify(definition)));
    expect(validateDefinitionSemantics(parsed)).toEqual([]);
  });

  it("the templated name target survives parsing verbatim", () => {
    const { definition } = buildPortalNote(liveish());
    const parsed = parseAiFlowDefinition(JSON.parse(JSON.stringify(definition)));
    const gate = parsed.steps[parsed.steps.length - 1] as unknown as {
      branches: Array<{
        steps: Array<{ branches: Array<{ steps: Array<{ actions: Array<{ target: string }> }> }> }>;
      }>;
    };
    const actions = gate.branches[0].steps[0].branches[0].steps[0].actions;
    expect(actions[1].target).toBe("{{vars.lead_name}}");
  });
});
