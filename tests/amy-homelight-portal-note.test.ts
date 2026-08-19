import { describe, it, expect } from "vitest";
import {
  ADD_NOTE_OPENER,
  AUTH_LABEL,
  GATE_ARM_ID,
  GATE_STEP_ID,
  HOST_ARM_ID,
  HOST_BRANCH_ID,
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
        id: HOST_BRANCH_ID,
        type: "branch",
        question: "Is this referral still ours?",
        branches: [
          {
            id: HOST_ARM_ID,
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
      }
    ]
  } as unknown as Record<string, unknown>);
}

/** Dig the still_ours arm's steps back out of a mutated definition. */
function armSteps(def: AiFlowDefinition): Array<Record<string, unknown>> {
  const host = def.steps.find((s) => s.id === HOST_BRANCH_ID) as unknown as {
    branches: Array<{ id: string; steps: Array<Record<string, unknown>> }>;
  };
  return host.branches.find((b) => b.id === HOST_ARM_ID)!.steps;
}

describe("noteActions", () => {
  it("navigates by nav link, templated name click, then the three drawer controls", () => {
    expect(noteActions()).toEqual([
      { kind: "click_text", target: "Referrals" },
      { kind: "click_text", target: "{{vars.lead_name}}" },
      { kind: "click_selector", target: ADD_NOTE_OPENER },
      { kind: "fill_selector", target: NOTE_TEXTAREA, valueTemplate: NOTE_TEXT },
      { kind: "click_selector", target: NOTE_SUBMIT }
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
  it("appends the gate to the still_ours arm and reports the new ids", () => {
    const def = liveish();
    const added = addPortalNote(def);
    expect(added).toEqual([GATE_STEP_ID, GATE_ARM_ID, NOTE_STEP_ID]);

    const steps = armSteps(def);
    const gate = steps[steps.length - 1] as {
      id: string;
      type: string;
      branches: Array<{
        id: string;
        condition: Record<string, unknown>;
        steps: Array<Record<string, unknown>>;
      }>;
      else: unknown[];
    };
    expect(gate.id).toBe(GATE_STEP_ID);
    expect(gate.type).toBe("branch");
    expect(gate.else).toEqual([]);
    // Two guards ANDed: the arm condition needs the name, the step's own
    // `when` needs a claiming teammate, matching the sibling sends.
    expect(gate.branches[0].condition).toEqual({ var: "lead_name", notEquals: "none" });
    const note = gate.branches[0].steps[0];
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

  it("does not touch the trunk or any existing step id", () => {
    const def = liveish();
    const before = def.steps.map((s) => s.id);
    const existing = allStepIds(def);
    addPortalNote(def);
    expect(def.steps.map((s) => s.id)).toEqual(before);
    for (const id of existing) expect(allStepIds(def)).toContain(id);
  });

  it("is idempotent: a second application adds nothing", () => {
    const def = liveish();
    addPortalNote(def);
    expect(addPortalNote(def)).toEqual([]);
    expect(allStepIds(def).filter((id) => id === GATE_STEP_ID)).toHaveLength(1);
  });

  it("throws when the host branch is missing rather than silently no-opping", () => {
    const def = liveish();
    def.steps = def.steps.filter((s) => s.id !== HOST_BRANCH_ID);
    expect(() => addPortalNote(def)).toThrow(/No trunk branch "lost_branch"/);
  });

  it("throws when the still_ours arm is missing", () => {
    const def = liveish();
    const host = def.steps.find((s) => s.id === HOST_BRANCH_ID) as unknown as {
      branches: Array<{ id: string }>;
    };
    host.branches[0].id = "renamed_arm";
    expect(() => addPortalNote(def)).toThrow(/no arm "still_ours"/);
  });
});

describe("buildPortalNote", () => {
  it("returns a mutated copy that still parses and passes semantic validation", () => {
    const live = liveish();
    const { definition, added } = buildPortalNote(live);
    expect(added).toHaveLength(3);
    // The input is untouched (the applier keeps it as the ledger `previous`).
    expect(allStepIds(live)).not.toContain(GATE_STEP_ID);
    const parsed = parseAiFlowDefinition(JSON.parse(JSON.stringify(definition)));
    expect(validateDefinitionSemantics(parsed)).toEqual([]);
  });

  it("the templated name target survives parsing verbatim", () => {
    const { definition } = buildPortalNote(liveish());
    const parsed = parseAiFlowDefinition(JSON.parse(JSON.stringify(definition)));
    const steps = (() => {
      const host = parsed.steps.find((s) => s.id === HOST_BRANCH_ID) as unknown as {
        branches: Array<{ id: string; steps: Array<Record<string, unknown>> }>;
      };
      return host.branches.find((b) => b.id === HOST_ARM_ID)!.steps;
    })();
    const gate = steps[steps.length - 1] as {
      branches: Array<{ steps: Array<{ actions: Array<{ target: string }> }> }>;
    };
    expect(gate.branches[0].steps[0].actions[1].target).toBe("{{vars.lead_name}}");
  });
});
