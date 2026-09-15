import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  ADD_NOTE_OPENER,
  AUTH_LABEL,
  GATE_OURS_ARM_ID,
  GATE_STEP_ID,
  LEGACY_NAME_CLICK,
  LEGACY_NAMED_ARM_CONDITION,
  LEGACY_REFERRALS_CLICK,
  LEGACY_REFERRALS_HREF_SELECTOR,
  NAMED_ARM_CONDITION,
  NAMED_ARM_ID,
  NAMED_BRANCH_ID,
  NOTE_EXPECT,
  NOTE_STEP_ID,
  NOTE_SUBMIT,
  NOTE_TEXT,
  NOTE_TEXTAREA,
  REFERRAL_ROW_NAME_TEST,
  REFERRAL_ROW_SELECTOR,
  REFERRAL_ROW_TEST,
  REFERRALS_NAV_SELECTOR,
  URL_VAR,
  addPortalNote,
  allStepIds,
  buildPortalNote,
  findNamedArm,
  findPortalNoteStep,
  noteActions,
  patchPortalNoteNav,
  patchPortalNoteRow,
  referralRowSelector
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
 * silently, and this is the file that should fail first. The row click is a
 * TEMPLATED first-name `:has-text` on HomeLight's list-row data-test, not
 * `click_text` of the full card name: the list abbreviates "Vince Nguyen" to
 * "Vince N.". A search-box fill was tried instead and raced the SPA list
 * re-render onto the wrong referral.
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
        id: "alert",
        type: "extract_text",
        fields: [{ name: "lead_first_name", description: "The lead's first name from the alert" }]
      },
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
      { kind: "click_selector", target: REFERRALS_NAV_SELECTOR },
      { kind: "click_selector", target: REFERRAL_ROW_SELECTOR },
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

  it("keys the claim-page header on /referrals and /referrals/page/, not claim URLs", () => {
    expect(REFERRALS_NAV_SELECTOR).toContain('a[href="/referrals"]');
    expect(REFERRALS_NAV_SELECTOR).toContain('a[href^="/referrals/page/"]');
    expect(REFERRALS_NAV_SELECTOR).not.toContain('href^="/referrals"]');
    expect(LEGACY_REFERRALS_HREF_SELECTOR).toBe('nav[data-test="navbar"] a[href="/referrals"]');
    expect(LEGACY_REFERRALS_CLICK).toEqual({ kind: "click_text", target: "Referrals" });
  });

  it("clicks the list row by first name, not the full card name", () => {
    expect(REFERRAL_ROW_TEST).toBe("referralsList-row");
    expect(REFERRAL_ROW_NAME_TEST).toBe("referralsList-rowClientName");
    expect(REFERRAL_ROW_SELECTOR).toBe(
      `[data-test="referralsList-row"]:has([data-test="referralsList-rowClientName"]:has-text("{{vars.lead_first_name}}"))`
    );
    expect(referralRowSelector("Vince")).toContain(':has-text("Vince")');
    expect(REFERRAL_ROW_SELECTOR).not.toContain("lead_name");
    expect(LEGACY_NAME_CLICK).toEqual({ kind: "click_text", target: "{{vars.lead_name}}" });
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
    expect(named.branches[0].condition).toEqual(NAMED_ARM_CONDITION);
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

  it("throws when the flow no longer produces lead_first_name", () => {
    const def = liveish();
    def.steps = def.steps.filter((s) => s.id !== "alert");
    expect(() => addPortalNote(def)).toThrow(/no longer produces lead_first_name/);
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
    expect(actions[1].target).toBe(REFERRAL_ROW_SELECTOR);
    expect(actions[0].target).toBe(REFERRALS_NAV_SELECTOR);
    expect(actions[1].target).toContain("{{vars.lead_first_name}}");
    expect(actions[1].target).not.toContain("{{vars.lead_name}}");
  });
});

describe("patchPortalNoteNav", () => {
  it("is a no-op when the note step already uses the href selector", () => {
    const def = liveish();
    addPortalNote(def);
    expect(patchPortalNoteNav(def)).toBe(false);
    expect(findPortalNoteStep(def)?.actions[0]).toEqual({
      kind: "click_selector",
      target: REFERRALS_NAV_SELECTOR
    });
  });

  it("rewrites the live click_text Referrals action in place", () => {
    const def = liveish();
    addPortalNote(def);
    const note = findPortalNoteStep(def)!;
    note.actions[0] = { ...LEGACY_REFERRALS_CLICK };
    expect(patchPortalNoteNav(def)).toBe(true);
    expect(note.actions[0]).toEqual({
      kind: "click_selector",
      target: REFERRALS_NAV_SELECTOR
    });
    // The rest of the sequence, including the row click, is untouched.
    expect(note.actions[1]).toEqual({ kind: "click_selector", target: REFERRAL_ROW_SELECTOR });
    expect(patchPortalNoteNav(def)).toBe(false);
  });

  it("rewrites the Sep 12 exact /referrals href to also match /referrals/page/", () => {
    const def = liveish();
    addPortalNote(def);
    const note = findPortalNoteStep(def)!;
    note.actions[0] = { kind: "click_selector", target: LEGACY_REFERRALS_HREF_SELECTOR };
    expect(patchPortalNoteNav(def)).toBe(true);
    expect(note.actions[0].target).toBe(REFERRALS_NAV_SELECTOR);
  });

  it("refuses when the note step is missing", () => {
    expect(() => patchPortalNoteNav(liveish())).toThrow(/no hl_portal_note/);
  });

  it("refuses when the note step has no actions", () => {
    const def = liveish();
    addPortalNote(def);
    findPortalNoteStep(def)!.actions = [];
    expect(() => patchPortalNoteNav(def)).toThrow(/no actions/);
  });

  it("refuses when the first action is neither the legacy click nor the selector", () => {
    const def = liveish();
    addPortalNote(def);
    findPortalNoteStep(def)!.actions[0] = { kind: "click_text", target: "Dashboard" };
    expect(() => patchPortalNoteNav(def)).toThrow(/Dashboard/);
  });
});

/** Shape of the live HomeLight Referral note step as of Sep 14 2026 (after nav + nocall). */
function liveNoteShape(def: ReturnType<typeof liveish>): void {
  addPortalNote(def);
  const note = findPortalNoteStep(def)!;
  note.actions[0] = { kind: "click_selector", target: LEGACY_REFERRALS_HREF_SELECTOR };
  note.actions[1] = { ...LEGACY_NAME_CLICK };
  const arm = findNamedArm(def)!;
  arm.condition = { ...LEGACY_NAMED_ARM_CONDITION };
}

describe("patchPortalNoteRow", () => {
  it("is a no-op when the note step already uses the row data-test", () => {
    const def = liveish();
    addPortalNote(def);
    expect(patchPortalNoteRow(def)).toEqual([]);
    expect(findPortalNoteStep(def)?.actions[1]).toEqual({
      kind: "click_selector",
      target: REFERRAL_ROW_SELECTOR
    });
    expect(findNamedArm(def)?.condition).toEqual(NAMED_ARM_CONDITION);
  });

  it("rewrites the live Sep 14 name click, exact href, and lead_name gate", () => {
    const def = liveish();
    liveNoteShape(def);
    const edits = patchPortalNoteRow(def);
    expect(edits.some((e) => e.startsWith("nav:"))).toBe(true);
    expect(edits.some((e) => e.startsWith("row:"))).toBe(true);
    expect(edits.some((e) => e.startsWith("gate:"))).toBe(true);
    const note = findPortalNoteStep(def)!;
    expect(note.actions).toEqual(noteActions());
    expect(findNamedArm(def)?.condition).toEqual(NAMED_ARM_CONDITION);
    expect(patchPortalNoteRow(def)).toEqual([]);
  });

  it("rewrites the 2026-09-13 live fixture without moving step ids", () => {
    const def = parseAiFlowDefinition(
      JSON.parse(
        readFileSync(join(__dirname, "fixtures", "homelight-referral-live-2026-09-13.json"), "utf8")
      )
    );
    const idsBefore = allStepIds(def);
    const edits = patchPortalNoteRow(def);
    expect(edits.length).toBeGreaterThan(0);
    expect(allStepIds(def)).toEqual(idsBefore);
    expect(findPortalNoteStep(def)?.actions).toEqual(noteActions());
    expect(findNamedArm(def)?.condition).toEqual(NAMED_ARM_CONDITION);
    expect(validateDefinitionSemantics(def)).toEqual([]);
    expect(patchPortalNoteRow(def)).toEqual([]);
  });

  it("refuses when the Add Note form actions were edited", () => {
    const def = liveish();
    addPortalNote(def);
    findPortalNoteStep(def)!.actions[2] = { kind: "click_text", target: "Add Note" };
    expect(() => patchPortalNoteRow(def)).toThrow(/Add Note sequence/);
  });

  it("refuses when the row action is neither the name click nor the data-test", () => {
    const def = liveish();
    addPortalNote(def);
    findPortalNoteStep(def)!.actions[1] = { kind: "click_text", target: "First row" };
    expect(() => patchPortalNoteRow(def)).toThrow(/First row/);
  });
});
