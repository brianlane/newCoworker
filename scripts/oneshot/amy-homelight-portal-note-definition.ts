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
 *   which swaps in a note editor:
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
 * PLACEMENT. Appended to the `still_ours` arm of the `lost_branch` branch,
 * after the outreach sends, so `actions_taken` already names what the run
 * did. Wrapped in its own `hl_note_gate` branch to AND two guards a single
 * `when` cannot express:
 *   - `lead_name` != "none": the click needs the client's real name, and the
 *     card extraction answers "none" when the portal never showed one;
 *   - `claimed_agent` != "none" (on the step itself): matches the sibling
 *     sends, so an offer nobody took posts nothing.
 *
 * Inserting new ids is safe for parked runs; nothing here renames or removes
 * an existing id.
 *
 * IDEMPOTENCE AT THE PORTAL. `expectText` holds the page until the note text
 * shows in the drawer's activity feed and fails the step loudly when it never
 * does; an expectation miss is classified permanent, so a failed write is
 * never silently retried into a double-post.
 *
 * Pure: no I/O. The applier reads, validates, writes and records the ledger.
 */
import type { AiFlowDefinition, FlowStep } from "@/lib/ai-flows/schema";

/** The trunk branch whose `still_ours` arm holds the outreach sends. */
export const HOST_BRANCH_ID = "lost_branch";
/** The arm the note joins. */
export const HOST_ARM_ID = "still_ours";
/** The gate branch this adds (idempotence marker). */
export const GATE_STEP_ID = "hl_note_gate";
/** Its single arm. */
export const GATE_ARM_ID = "hl_note_go";
/** The browse_action that posts the note. */
export const NOTE_STEP_ID = "hl_portal_note";

/** The URL var every browse step in this flow already uses. */
export const URL_VAR = "leadUrl";
/** The integration label every browse step in this flow already uses. */
export const AUTH_LABEL = "HomeLight";

/**
 * The note itself. `actions_taken` is the engine's running log of what the
 * run actually did, which is what keeps the note honest without anyone
 * maintaining it. The leading fragment doubles as the post-submit
 * expectation: the drawer's activity feed shows the note text once the write
 * lands.
 */
export const NOTE_TEXT =
  "Update from Amy's assistant: {{vars.actions_taken}}. Will keep following up.";
export const NOTE_EXPECT = "Update from Amy's assistant";

/** Drawer controls, read live headless on 2026-08-19. */
export const ADD_NOTE_OPENER = '[data-test="referral-detail-modal-add-note-button"]';
export const NOTE_TEXTAREA = '[data-test="referral-add-note-textarea"]';
export const NOTE_SUBMIT = '[data-test="referral-add-note-btn"]';

/** The five actions that post the note, from the claim page the run holds. */
export function noteActions(): Array<Record<string, string>> {
  return [
    // The claim page's own header nav carries the Referrals link (present on
    // every one of the 48 stored captures of this flow's pages).
    { kind: "click_text", target: "Referrals" },
    // Rendered at plan time to the client's name; clicks their row.
    { kind: "click_text", target: "{{vars.lead_name}}" },
    { kind: "click_selector", target: ADD_NOTE_OPENER },
    { kind: "fill_selector", target: NOTE_TEXTAREA, valueTemplate: NOTE_TEXT },
    { kind: "click_selector", target: NOTE_SUBMIT }
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
 * Append the note gate to the `still_ours` arm. Returns the ids added, or []
 * when the gate is already there.
 *
 * Throws rather than guessing when the host branch or arm is missing: a
 * silent no-op here would read as "already applied" and leave the portal
 * update unshipped forever.
 */
export function addPortalNote(def: AiFlowDefinition): string[] {
  if (allStepIds(def).includes(GATE_STEP_ID)) return [];

  const host = def.steps.find((s) => s.id === HOST_BRANCH_ID) as unknown as
    | BranchLike
    | undefined;
  if (!host || !Array.isArray(host.branches)) {
    throw new Error(
      `No trunk branch "${HOST_BRANCH_ID}" to extend. The flow shape changed; re-read it before applying.`
    );
  }
  const arm = host.branches.find((b) => b.id === HOST_ARM_ID);
  if (!arm || !Array.isArray(arm.steps)) {
    throw new Error(
      `Branch "${HOST_BRANCH_ID}" has no arm "${HOST_ARM_ID}". The flow shape changed; re-read it before applying.`
    );
  }

  const gate = {
    id: GATE_STEP_ID,
    type: "branch",
    question: "Do we know the client's portal name to post an update under?",
    branches: [
      {
        id: GATE_ARM_ID,
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
  } as unknown as FlowStep;

  arm.steps.push(gate);
  return [GATE_STEP_ID, GATE_ARM_ID, NOTE_STEP_ID];
}

/** Convenience for the applier and tests. */
export function buildPortalNote(live: AiFlowDefinition): {
  definition: AiFlowDefinition;
  added: string[];
} {
  const next = JSON.parse(JSON.stringify(live)) as AiFlowDefinition;
  return { definition: next, added: addPortalNote(next) };
}
