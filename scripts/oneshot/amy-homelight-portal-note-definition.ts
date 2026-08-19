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
 * WHY `click_text "{{vars.lead_name}}"` AND NOT A SEARCH FILL. Action targets
 * render {{vars.*}} at plan time (steps.ts), so the click waits for the one
 * row carrying the lead's name. Filling the list's search box and clicking
 * "the first row" was tried and RACES the re-render: the click landed on the
 * stale first row of the unfiltered list (a terminal `Failed` referral, which
 * does not even carry the note button).
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
 *   - inner arm  `lead_name` != "none": the click needs the client's real
 *     name, and the card extraction answers "none" when the portal never
 *     showed one;
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
/** Inner branch + arm: we know the client's portal name. */
export const NAMED_BRANCH_ID = "hl_note_named";
export const NAMED_ARM_ID = "hl_note_go";
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

/** The six actions that post the note, from the claim page the run holds. */
export function noteActions(): Array<Record<string, string>> {
  return [
    // The claim page's own header nav carries the Referrals link (present on
    // every one of the 48 stored captures of this flow's pages).
    { kind: "click_text", target: "Referrals" },
    // Rendered at plan time to the client's name; clicks their row.
    { kind: "click_text", target: "{{vars.lead_name}}" },
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
  const needed = ["already_claimed", "lead_name", "leadUrl"];
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
            question: "Do we know the client's portal name to post an update under?",
            branches: [
              {
                id: NAMED_ARM_ID,
                label: "Post the portal note",
                condition: { var: "lead_name", notEquals: "none" },
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
