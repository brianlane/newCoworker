/**
 * Pure builder: make Amy's HomeLight flow post a progress note on the agent
 * dashboard after it works a referral (plan Phase 4b).
 *
 * THE GAP. HomeLight's agent dashboard nags "Any updates for <Name>?" per
 * referral, and referral volume follows engagement, but the "HomeLight
 * Referral" flow has never written anything there: it claims the referral and
 * runs the outreach, and the portal shows none of it. The dashboard's stage
 * field is NOT the surface for us: the flow's only call signal
 * (`hl_call_outcome`) proves our line answered HomeLight's claim call, not
 * that the client was reached, and HomeLight's own AI already maintains the
 * stage from its call system ("Stage updated by HomeLight AI" on live
 * timelines). A note is append-only free text, so it can be exactly as honest
 * as the run's own `actions_taken` log, which is the same model the
 * ReferralExchange update uses.
 *
 * THE SURFACE, read live headless on 2026-08-19 through Amy's render sidecar
 * (probe, nothing submitted):
 *
 *   agent.homelight.com/referrals lists every referral; rows are `<a>` with
 *   NO href, so forEachLink cannot reach them and the SPA navigates on click.
 *   Clicking the client's name opens a detail drawer:
 *     [data-test="referral-detail-modal-add-note-button"]  "Add Note"
 *   which swaps in a note editor (REPLACING that opener button):
 *     [data-test="referral-add-note-textarea"]  placeholder "Add an optional note..."
 *     [data-test="referral-add-note-btn"]       "Add note" (submits)
 *
 * WHY THE ROW `data-test` PLUS FIRST NAME, NOT `click_text` OF THE FULL
 * NAME. Action targets still render {{vars.*}} at plan time (steps.ts). The
 * list row is `[data-test="referralsList-row"]` with the client name in
 * `referralsList-rowClientName`. `click_text "{{vars.lead_name}}"` died on
 * Vince Nguyen / Brandi V. / Sharon I. (Sep 14 2026): the claim card and SMS
 * often carry a full name ("Vince Nguyen") while the list shows the
 * abbreviated form ("Vince N."), so an exact text click finds no control.
 * `:has-text("{{vars.lead_first_name}}")` matches both. Filling the list's
 * search box and clicking "the first row" was tried and RACES the re-render:
 * the click landed on the stale first row of the unfiltered list (a terminal
 * `Failed` referral, which does not even carry the note button). Do not go
 * back to that.
 *
 * HOW THE WRITE PROVES ITSELF. The note text alone cannot: right after the
 * fill, the draft is visible page text, so an `expectText` on the note
 * fragment would pass even when the submit was swallowed, which is exactly
 * the silent-success class this account has been bitten by (the Aug 16 claim
 * click). Two facts close it:
 *   1. The final action re-clicks the Add Note OPENER. The editor replaces
 *      the opener while it is open, so the opener exists again only after the
 *      form accepted the submit and the editor closed. A swallowed submit
 *      leaves the editor up, the opener absent, and the click fails the step
 *      loudly.
 *   2. Only then does `expectText` check the note fragment, and the freshly
 *      reopened editor's textarea is EMPTY, so the fragment can only be
 *      satisfied by the drawer's activity feed showing the posted note.
 *
 * PLACEMENT: the END of the trunk, deliberately. The first draft nested this
 * inside `lost_branch`'s still_ours arm, before the late-contact ladder and
 * the claimed-agent report steps, so a missing row or reworded control would
 * have dead-lettered the rest of the run's outreach machinery. As the last
 * trunk step, a note failure fails only itself (loudly, with a screenshot).
 * The step-30 slot is the trunk's LAST (schema caps steps at 30); the next
 * addition to this flow must nest inside an existing branch or retire a step.
 *
 * Guards, nested because a branch arm carries one condition and a step one
 * `when`:
 *   - outer arm  `already_claimed` != "yes": another brokerage's referral is
 *     not in Amy's list, so there is nothing to update;
 *   - inner arm  `lead_first_name` != "none": the row click uses the SMS
 *     first name, and an empty `:has-text("")` would match every row;
 *   - step when  `claimed_agent` != "none": matches the sibling sends, so an
 *     offer nobody took posts nothing.
 *
 * Inserting new ids is safe for parked runs; nothing here renames or removes
 * an existing id.
 *
 * Pure: no I/O. The applier reads, validates, writes and records the ledger.
 */
import type { AiFlowDefinition, FlowStep } from "@/lib/ai-flows/schema";

/** The gate branch this adds to the trunk's end (idempotence marker). */
export const GATE_STEP_ID = "hl_note_gate";
/** Outer arm: the referral is still ours. */
export const GATE_OURS_ARM_ID = "hl_note_ours";
/** Inner branch + arm: we know the client's first name. */
export const NAMED_BRANCH_ID = "hl_note_named";
export const NAMED_ARM_ID = "hl_note_go";
/** Inner-arm gate: skip the note rather than click `:has-text("")`. */
export const NAMED_ARM_CONDITION = { var: "lead_first_name", notEquals: "none" } as const;
/** Pre-Sep-15 inner arm: gated on the full card name. */
export const LEGACY_NAMED_ARM_CONDITION = { var: "lead_name", notEquals: "none" } as const;
/** The browse_action that posts the note. */
export const NOTE_STEP_ID = "hl_portal_note";

/** The URL var every browse step in this flow already uses. */
export const URL_VAR = "leadUrl";
/** The integration label every browse step in this flow already uses. */
export const AUTH_LABEL = "HomeLight";

/**
 * The note itself. `actions_taken` is the engine's running log of what the
 * run actually did, which is what keeps the note honest without anyone
 * maintaining it.
 */
export const NOTE_TEXT =
  "Update from Amy's assistant: {{vars.actions_taken}}. Will keep following up.";
export const NOTE_EXPECT = "Update from Amy's assistant";

/** Drawer controls, read live headless on 2026-08-19. */
export const ADD_NOTE_OPENER = '[data-test="referral-detail-modal-add-note-button"]';
export const NOTE_TEXTAREA = '[data-test="referral-add-note-textarea"]';
export const NOTE_SUBMIT = '[data-test="referral-add-note-btn"]';

/**
 * Header nav on the claim page. `click_text "Referrals"` lost a hydration
 * race on run 39f53cb7 (2026-09-11). The Sep 12 patch keyed the exact href
 * `/referrals`. Sep 14 runs then died with Next.js
 * `Abort fetching component for route: "/referrals/page/[page]"` and a 404
 * in the same error as the name click: the live list is
 * `/referrals/page/1`, not the bare `/referrals` path. Match both the bare
 * href (still in some nav builds) and any `/referrals/page/...` href. Do
 * NOT use `href^="/referrals"`: that would also hit `/referrals/claim`.
 */
export const LEGACY_REFERRALS_HREF_SELECTOR = 'nav[data-test="navbar"] a[href="/referrals"]';
export const REFERRALS_NAV_SELECTOR =
  'nav[data-test="navbar"] a[href="/referrals"], nav[data-test="navbar"] a[href^="/referrals/page/"]';
export const LEGACY_REFERRALS_CLICK = { kind: "click_text", target: "Referrals" } as const;
export const LEGACY_NAME_CLICK = { kind: "click_text", target: "{{vars.lead_name}}" } as const;

/** HomeLight list row + client-name cell, read live 2026-08-19. */
export const REFERRAL_ROW_TEST = "referralsList-row";
export const REFERRAL_ROW_NAME_TEST = "referralsList-rowClientName";
export const LEAD_FIRST_NAME_TEMPLATE = "{{vars.lead_first_name}}";

/**
 * Click the list row whose client-name cell contains the SMS first name.
 * Playwright `:has-text` is a case-insensitive substring, so "Vince" hits
 * both "Vince Nguyen" and "Vince N.".
 */
export function referralRowSelector(nameTemplate = LEAD_FIRST_NAME_TEMPLATE): string {
  return `[data-test="${REFERRAL_ROW_TEST}"]:has([data-test="${REFERRAL_ROW_NAME_TEST}"]:has-text("${nameTemplate}"))`;
}

export const REFERRAL_ROW_SELECTOR = referralRowSelector();

/** The six actions that post the note, from the claim page the run holds. */
export function noteActions(): Array<Record<string, string>> {
  return [
    { kind: "click_selector", target: REFERRALS_NAV_SELECTOR },
    { kind: "click_selector", target: REFERRAL_ROW_SELECTOR },
    { kind: "click_selector", target: ADD_NOTE_OPENER },
    { kind: "fill_selector", target: NOTE_TEXTAREA, valueTemplate: NOTE_TEXT },
    { kind: "click_selector", target: NOTE_SUBMIT },
    // Submit proof: the opener exists again only once the editor closed. A
    // swallowed submit leaves the editor up and fails this click loudly.
    { kind: "click_selector", target: ADD_NOTE_OPENER }
  ];
}

type BranchArm = { id: string; label?: string; condition?: unknown; steps?: FlowStep[] };
type BranchLike = { id: string; type?: string; branches?: BranchArm[]; else?: FlowStep[] };

/** Every step id in the definition, trunk and nested, for idempotence and printing. */
export function allStepIds(def: AiFlowDefinition): string[] {
  const out: string[] = [];
  const walk = (steps: readonly FlowStep[]): void => {
    for (const s of steps) {
      out.push(s.id);
      const b = s as unknown as BranchLike;
      for (const arm of b.branches ?? []) walk(arm.steps ?? []);
      walk((b.else ?? []) as FlowStep[]);
    }
  };
  walk(def.steps);
  return out;
}

type BrowseAction = { kind: string; target: string; valueTemplate?: string };
type BrowseActionStep = FlowStep & { type: "browse_action"; actions: BrowseAction[] };

/** Nested `hl_portal_note`, or null when the gate is not in this definition. */
export function findPortalNoteStep(def: AiFlowDefinition): BrowseActionStep | null {
  let found: BrowseActionStep | null = null;
  const walk = (steps: readonly FlowStep[]): void => {
    for (const s of steps) {
      if (s.id === NOTE_STEP_ID && s.type === "browse_action") {
        found = s as BrowseActionStep;
        return;
      }
      const b = s as unknown as BranchLike;
      for (const arm of b.branches ?? []) walk(arm.steps ?? []);
      walk((b.else ?? []) as FlowStep[]);
    }
  };
  walk(def.steps);
  return found;
}

function requirePortalNote(def: AiFlowDefinition): BrowseActionStep {
  const note = findPortalNoteStep(def);
  if (!note) {
    throw new Error(
      `The flow has no ${NOTE_STEP_ID} step. Apply amy-homelight-portal-note.ts first.`
    );
  }
  if (!note.actions[0]) {
    throw new Error(`${NOTE_STEP_ID} has no actions.`);
  }
  return note;
}

export function isCurrentReferralsNav(action: { kind: string; target: string }): boolean {
  return action.kind === "click_selector" && action.target === REFERRALS_NAV_SELECTOR;
}

export function isLegacyReferralsNav(action: { kind: string; target: string }): boolean {
  if (action.kind === LEGACY_REFERRALS_CLICK.kind && action.target === LEGACY_REFERRALS_CLICK.target) {
    return true;
  }
  return action.kind === "click_selector" && action.target === LEGACY_REFERRALS_HREF_SELECTOR;
}

export function isCurrentRowClick(action: { kind: string; target: string }): boolean {
  return action.kind === "click_selector" && action.target === REFERRAL_ROW_SELECTOR;
}

export function isLegacyNameClick(action: { kind: string; target: string }): boolean {
  return action.kind === LEGACY_NAME_CLICK.kind && action.target === LEGACY_NAME_CLICK.target;
}

function sameCondition(
  actual: unknown,
  expected: { var: string; notEquals: string }
): boolean {
  if (!actual || typeof actual !== "object") return false;
  const c = actual as { var?: string; equals?: string; notEquals?: string; contains?: string };
  return c.var === expected.var && c.notEquals === expected.notEquals && c.equals === undefined;
}

/** Nested `hl_note_go` arm, or null when the gate is not in this definition. */
export function findNamedArm(def: AiFlowDefinition): BranchArm | null {
  let found: BranchArm | null = null;
  const walk = (steps: readonly FlowStep[]): void => {
    for (const s of steps) {
      const b = s as unknown as BranchLike;
      for (const arm of b.branches ?? []) {
        if (arm.id === NAMED_ARM_ID) {
          found = arm;
          return;
        }
        walk(arm.steps ?? []);
      }
      walk((b.else ?? []) as FlowStep[]);
    }
  };
  walk(def.steps);
  return found;
}

/**
 * Replace the claim-page Referrals click with the href selector that matches
 * both `/referrals` and `/referrals/page/...`.
 * Returns true when it wrote, false when the step is already patched.
 * Throws when the note step is missing or its first action is none of the
 * known Referrals clicks, so a dashboard edit cannot be silently overwritten.
 */
export function patchPortalNoteNav(def: AiFlowDefinition): boolean {
  const note = requirePortalNote(def);
  const first = note.actions[0];
  if (isCurrentReferralsNav(first)) return false;
  if (!isLegacyReferralsNav(first)) {
    throw new Error(
      `${NOTE_STEP_ID} first action is ${first.kind} "${first.target}", not ` +
        `click_text "Referrals" or a Referrals href selector. The flow was edited; re-read it.`
    );
  }
  note.actions[0] = { kind: "click_selector", target: REFERRALS_NAV_SELECTOR };
  return true;
}

/**
 * Replace the exact-name list click with HomeLight's row `data-test` plus
 * first-name `:has-text`, and gate the arm on `lead_first_name`.
 * Returns the edits it wrote, or [] when already patched.
 * Throws when the note form actions (opener / fill / submit / proof) are not
 * the known sequence, so a dashboard edit cannot be silently overwritten.
 */
export function patchPortalNoteRow(def: AiFlowDefinition): string[] {
  const note = requirePortalNote(def);
  const expected = noteActions();
  if (note.actions.length !== expected.length) {
    throw new Error(
      `${NOTE_STEP_ID} has ${note.actions.length} actions, not ${expected.length}. ` +
        "The flow was edited; re-read it."
    );
  }
  for (let i = 2; i < expected.length; i++) {
    const actual = note.actions[i];
    const want = expected[i];
    if (
      actual.kind !== want.kind ||
      actual.target !== want.target ||
      (actual.valueTemplate ?? "") !== (want.valueTemplate ?? "")
    ) {
      throw new Error(
        `${NOTE_STEP_ID} action ${i} is ${actual.kind} "${actual.target}", not the known Add Note sequence. ` +
          "The flow was edited; re-read it."
      );
    }
  }

  const edits: string[] = [];
  const first = note.actions[0];
  if (!isCurrentReferralsNav(first)) {
    if (!isLegacyReferralsNav(first)) {
      throw new Error(
        `${NOTE_STEP_ID} first action is ${first.kind} "${first.target}", not a known Referrals click.`
      );
    }
    note.actions[0] = { kind: "click_selector", target: REFERRALS_NAV_SELECTOR };
    edits.push(`nav: ${first.kind} "${first.target}" -> click_selector "${REFERRALS_NAV_SELECTOR}"`);
  }

  const second = note.actions[1];
  if (!second) {
    throw new Error(`${NOTE_STEP_ID} is missing the row-click action.`);
  }
  if (!isCurrentRowClick(second)) {
    if (!isLegacyNameClick(second)) {
      throw new Error(
        `${NOTE_STEP_ID} row action is ${second.kind} "${second.target}", not ` +
          `click_text "{{vars.lead_name}}" or the row data-test. The flow was edited; re-read it.`
      );
    }
    note.actions[1] = { kind: "click_selector", target: REFERRAL_ROW_SELECTOR };
    edits.push(`row: ${second.kind} "${second.target}" -> click_selector "${REFERRAL_ROW_SELECTOR}"`);
  }

  const arm = findNamedArm(def);
  if (!arm) {
    throw new Error(`The flow has no ${NAMED_ARM_ID} arm. Apply amy-homelight-portal-note.ts first.`);
  }
  if (!sameCondition(arm.condition, NAMED_ARM_CONDITION)) {
    if (!sameCondition(arm.condition, LEGACY_NAMED_ARM_CONDITION)) {
      throw new Error(
        `${NAMED_ARM_ID} condition is ${JSON.stringify(arm.condition)}, not lead_name/lead_first_name. ` +
          "The flow was edited; re-read it."
      );
    }
    arm.condition = { ...NAMED_ARM_CONDITION };
    edits.push(`gate: lead_name -> lead_first_name`);
  }

  return edits;
}

/**
 * Append the note gate to the trunk's end. Returns the ids added, or [] when
 * the gate is already there.
 *
 * Throws when the vars the guards and actions depend on are not produced by
 * any step: a silent apply against a reshaped flow would fail every run at
 * plan time instead of failing here, once, in front of the operator.
 */
export function addPortalNote(def: AiFlowDefinition): string[] {
  if (allStepIds(def).includes(GATE_STEP_ID)) return [];

  // The guards and the templated click depend on these; verify the flow still
  // produces them before touching anything.
  const needed = ["already_claimed", "lead_first_name", "leadUrl"];
  const produced = new Set<string>();
  const collect = (steps: readonly FlowStep[]): void => {
    for (const s of steps) {
      const step = s as unknown as {
        saveAs?: string;
        fields?: Array<{ name?: string }>;
        type?: string;
        branches?: Array<{ steps?: FlowStep[] }>;
        else?: FlowStep[];
      };
      if (typeof step.saveAs === "string") produced.add(step.saveAs);
      for (const f of step.fields ?? []) if (f?.name) produced.add(f.name);
      if (step.type === "route_to_team") produced.add("claimed_agent");
      for (const arm of step.branches ?? []) collect(arm.steps ?? []);
      collect((step.else ?? []) as FlowStep[]);
    }
  };
  collect(def.steps);
  const missing = needed.filter((v) => !produced.has(v));
  if (missing.length > 0 || !produced.has("claimed_agent")) {
    throw new Error(
      `The flow no longer produces ${[...missing, ...(produced.has("claimed_agent") ? [] : ["claimed_agent"])].join(", ")}. ` +
        "The flow shape changed; re-read it before applying."
    );
  }

  const gate = {
    id: GATE_STEP_ID,
    type: "branch",
    question: "Is this referral still ours to update on the portal?",
    branches: [
      {
        id: GATE_OURS_ARM_ID,
        label: "Still ours",
        condition: { var: "already_claimed", notEquals: "yes" },
        steps: [
          {
            id: NAMED_BRANCH_ID,
            type: "branch",
            question: "Do we know the client's first name to find their row?",
            branches: [
              {
                id: NAMED_ARM_ID,
                label: "Post the portal note",
                condition: { ...NAMED_ARM_CONDITION },
                steps: [
                  {
                    id: NOTE_STEP_ID,
                    type: "browse_action",
                    when: { var: "claimed_agent", notEquals: "none" },
                    auth: { integrationLabel: AUTH_LABEL },
                    urlVar: URL_VAR,
                    actions: noteActions(),
                    expectText: NOTE_EXPECT,
                    screenshot: true
                  }
                ]
              }
            ],
            else: []
          }
        ]
      }
    ],
    else: []
  } as unknown as FlowStep;

  def.steps.push(gate);
  return [GATE_STEP_ID, GATE_OURS_ARM_ID, NAMED_BRANCH_ID, NAMED_ARM_ID, NOTE_STEP_ID];
}

/** Convenience for the applier and tests. */
export function buildPortalNote(live: AiFlowDefinition): {
  definition: AiFlowDefinition;
  added: string[];
} {
  const next = JSON.parse(JSON.stringify(live)) as AiFlowDefinition;
  return { definition: next, added: addPortalNote(next) };
}
