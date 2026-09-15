/**
 * Pure builder: stop offering a HomeLight referral the portal already lost, and
 * only race the team after a confirmed claim (text) or a connected claim call.
 *
 * INCIDENT, 2026-09-13, Sonia R. (Queen Creek AZ, $448,159), run
 * `76248380-af0f-4572-9368-04b93ddd1b1e`. HomeLight sent three SMS 16s apart:
 * the warm-transfer alert, the `hmlt.co` URL 35ms later, then "this referral
 * is no longer available". The trigger needs `has_url` AND
 * `New HomeLight (Referral|Warm Transfer)`. Each webhook evaluated BEFORE
 * inserting its inbound job, so the first two each saw only themselves and
 * neither matched. The withdrawal saw both prior jobs and started the run.
 * By page-open the overlay was already "Sonia was already claimed by another
 * agent". `claim_mode=none`, `claim_state=another agent has it`. `route_to_team`
 * had no when-guard, so we still offered Gabrielle, Dave, and Amy a press-1
 * race whose copy said both "Claim status: another agent has it" and
 * "First to reply 1 gets it." Amy replied 1. That was our roster claim, not
 * HomeLight's. `wait_hl_call` then sat on `claimed_agent notEquals none` and
 * recorded `no_call`. The voice flow never rang.
 *
 * WHAT THIS CHANGES (structure, not a net trunk add: live is at the 30-step
 * cap). Replaces trunk `route` + `brief_call` + `wait_hl_call` with `offer_gate`:
 *
 *   - claim_mode equals text: `route_text` (clone of the live offer)
 *   - claim_mode equals call: `brief_call` then `wait_hl_call` (no when),
 *     then `route` when `hl_call_outcome notEquals no_call`, then a
 *     take-a-message `notify_lead_owner` when the outcome is `no_call`
 *   - else (lost / claim_mode none): `lost_alert`, an alert, not an offer
 *
 * `card` stays on the trunk immediately BEFORE `offer_gate`, retargeted to
 * `claim_mode notEquals none`, so `brief_call` can use `lead_name` /
 * `lead_notes` from that extract. The old order was offer then card, which
 * made briefing the live transfer impossible until someone pressed 1.
 *
 * `when` is one condition on one var. Nesting the wait inside the call arm is
 * what makes `notEquals "no_call"` safe: a skipped wait leaves the var empty,
 * and an empty var PASSES `notEquals "no_call"`. Wrapping `notify_unclaimed`
 * the same way stops a lost or no-call run from also saying "Not claimed".
 *
 * Unique step ids are kept (`wait_hl_call`, `route`, `brief_call`,
 * `notify_unclaimed`) so parked runs re-anchor by `__resume_step_id`. The
 * applier refuses in-flight runs parked on a step whose meaning moved.
 *
 * Pure: no I/O. The applier reads, validates, writes, and records the ledger.
 */

import type { AiFlowDefinition } from "@/lib/ai-flows/schema";

export const OFFER_GATE_ID = "offer_gate";
export const OFFER_TEXT_ARM_ID = "offer_text";
export const OFFER_CALL_ARM_ID = "offer_call";
export const ROUTE_TEXT_ID = "route_text";
export const ROUTE_ID = "route";
export const WAIT_ID = "wait_hl_call";
export const BRIEF_ID = "brief_call";
export const NO_CALL_MSG_ID = "no_call_msg";
export const LOST_ALERT_ID = "lost_alert";
export const UNCLAIMED_NOTICE_ID = "unclaimed_notice";
export const UNCLAIMED_HAD_CLAIM_ARM_ID = "unclaimed_had_claim";
export const UNCLAIMED_NOT_NOCALL_ID = "unclaimed_not_nocall";
export const UNCLAIMED_OFFER_MISSED_ARM_ID = "unclaimed_offer_missed";
export const NOTIFY_UNCLAIMED_ID = "notify_unclaimed";
export const CLAIM_FIX_ID = "claim_fix";

/** Honest line on the CALL offer, which now runs AFTER wait_hl_call. */
export const CALL_OFFER_LINE =
  "Our AI coworker took HomeLight's claim call ({{vars.hl_call_outcome_label}}).";

/**
 * Take-a-message copy when we claimed with HomeLight and the seller never
 * joined. An ALERT: no "Reply 1", no deadline, no team race.
 */
export const NO_CALL_MESSAGE =
  "HomeLight claimed this referral but the seller was not on the call: {{vars.lead_first_name}}, {{vars.lead_type}} in {{vars.city}} (~{{vars.price}}). Take a message from the portal. This is not a live transfer.\n" +
  "Claim status: {{vars.claim_state}}.\n" +
  "Portal: {{vars.leadUrl}}";

/**
 * Lost-referral copy. Same alert shape: nobody is asked to reply 1.
 */
export const LOST_ALERT_MESSAGE =
  "HomeLight already gave this referral to another agent: {{vars.lead_first_name}}, {{vars.lead_type}} in {{vars.city}} (~{{vars.price}}). There is nothing to claim.\n" +
  "Claim status: {{vars.claim_state}}.\n" +
  "Portal: {{vars.leadUrl}}";

/**
 * Later portal / mailbox reads that used to wait for a teammate to press 1.
 * After this patch they run whenever WE claimed with HomeLight (call or text),
 * so a no-call take-a-message still gathers details. `to_agent` stays gated
 * on `claimed_agent` because it texts `claimed_agent_phone`.
 */
export const RETARGET_IDS = [
  "card",
  "recheck1_wait",
  "recheck1",
  "final_read",
  "email_card",
  "hl_portal_note"
] as const;

/**
 * In-flight resume ids whose step moved (or is new). Applying while a run is
 * parked on one of these would re-offer or re-wait. `card` and later trunk
 * ids stay put, so those runs re-anchor safely.
 */
export const SHIFT_UNSAFE_RESUME_IDS = [
  ROUTE_ID,
  WAIT_ID,
  BRIEF_ID,
  ROUTE_TEXT_ID,
  OFFER_GATE_ID,
  NO_CALL_MSG_ID,
  LOST_ALERT_ID,
  NOTIFY_UNCLAIMED_ID,
  UNCLAIMED_NOTICE_ID
] as const;

type Step = Record<string, unknown> & {
  id?: string;
  type?: string;
  when?: { var?: string; equals?: string; notEquals?: string; contains?: string };
  offerTemplate?: string;
  message?: string;
  branches?: Array<
    Record<string, unknown> & {
      id?: string;
      condition?: { var?: string; equals?: string; notEquals?: string; contains?: string };
      steps?: Step[];
    }
  >;
  else?: Step[];
};

export type Definition = { steps?: Step[] } & Record<string, unknown>;

/** Depth-first walk over trunk steps, branch arms and else arms. */
export function* walkSteps(steps: unknown): Generator<Step> {
  if (!Array.isArray(steps)) return;
  for (const step of steps as Step[]) {
    if (!step || typeof step !== "object") continue;
    yield step;
    for (const arm of Array.isArray(step.branches) ? step.branches : []) {
      yield* walkSteps(arm?.steps);
    }
    yield* walkSteps(step.else);
  }
}

export function findStep(def: Definition, id: string): Step | undefined {
  return [...walkSteps(def.steps)].find((s) => s.id === id);
}

function requireStep(def: Definition, id: string, type?: string): Step {
  const matches = [...walkSteps(def.steps)].filter((s) => s.id === id);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one step "${id}", found ${matches.length}`);
  }
  const step = matches[0]!;
  if (type && step.type !== type) {
    throw new Error(`step "${id}" is a ${String(step.type)}, not a ${type}`);
  }
  return step;
}

function cloneStep<T>(step: T): T {
  return JSON.parse(JSON.stringify(step)) as T;
}

function insertAfterLine(text: string, anchor: string, line: string): string {
  const idx = text.indexOf(anchor);
  if (idx < 0) throw new Error(`anchor line "${anchor}" not found`);
  const lineEnd = text.indexOf("\n", idx);
  if (lineEnd < 0) return `${text}\n${line}`;
  return `${text.slice(0, lineEnd)}\n${line}${text.slice(lineEnd)}`;
}

function looksPatched(def: Definition): boolean {
  const trunk = def.steps;
  if (!Array.isArray(trunk)) return false;
  return trunk.some((s) => s.id === OFFER_GATE_ID);
}

function assertPatchedShape(def: Definition): void {
  const gate = requireStep(def, OFFER_GATE_ID, "branch");
  const textArm = (gate.branches ?? []).find((b) => b.id === OFFER_TEXT_ARM_ID);
  const callArm = (gate.branches ?? []).find((b) => b.id === OFFER_CALL_ARM_ID);
  if (!textArm || !callArm) {
    throw new Error(`${OFFER_GATE_ID} is missing the text or call arm`);
  }
  const textIds = (textArm.steps ?? []).map((s) => s.id);
  const callIds = (callArm.steps ?? []).map((s) => s.id);
  if (textIds[0] !== ROUTE_TEXT_ID) {
    throw new Error(`text arm should start with "${ROUTE_TEXT_ID}", found ${textIds.join(",")}`);
  }
  if (callIds[0] !== BRIEF_ID || callIds[1] !== WAIT_ID) {
    throw new Error(
      `call arm should start with ${BRIEF_ID}, ${WAIT_ID}; found ${callIds.join(",")}`
    );
  }
  if (callIds[callIds.length - 2] !== ROUTE_ID || callIds[callIds.length - 1] !== NO_CALL_MSG_ID) {
    throw new Error(
      `call arm should end with ${ROUTE_ID}, ${NO_CALL_MSG_ID}; found ${callIds.join(",")}`
    );
  }
  const elseIds = (gate.else ?? []).map((s) => s.id);
  if (elseIds[0] !== LOST_ALERT_ID) {
    throw new Error(`${OFFER_GATE_ID} else should start with "${LOST_ALERT_ID}"`);
  }
  const wait = requireStep(def, WAIT_ID, "wait_for_call");
  if (wait.when) {
    throw new Error(`${WAIT_ID} still carries a when-guard; the call arm is the gate`);
  }
  const route = requireStep(def, ROUTE_ID, "route_to_team");
  if (route.when?.var !== "hl_call_outcome" || route.when.notEquals !== "no_call") {
    throw new Error(`${ROUTE_ID}.when should be hl_call_outcome notEquals no_call`);
  }
  for (const id of [LOST_ALERT_ID, NO_CALL_MSG_ID]) {
    const step = requireStep(def, id, "notify_lead_owner");
    const copy = typeof step.message === "string" ? step.message : "";
    if (/reply\s*1/i.test(copy) || /first to reply/i.test(copy)) {
      throw new Error(`step "${id}" is an alert and must not ask anyone to reply 1`);
    }
  }
}

function makeLostOrNoCallAlert(id: string, message: string, when?: Step["when"]): Step {
  const step: Step = {
    id,
    type: "notify_lead_owner",
    message,
    nameVar: "lead_name",
    phoneVar: "lead_phone",
    unownedFallback: "team",
    teamTagTemplate: "{{vars.lead_type}}"
  };
  if (when) step.when = when;
  return step;
}

/**
 * Apply every edit. Returns what changed so an already-patched flow reports
 * "nothing to do". Throws when the live copy is not what this was written
 * against: silently reverting someone else's edit is worse than refusing.
 */
export function patchDefinition(def: Definition): string[] {
  const edits: string[] = [];
  const trunk = def.steps;
  if (!Array.isArray(trunk)) throw new Error("definition has no steps array");

  if (looksPatched(def)) {
    assertPatchedShape(def);
    return [];
  }

  const claimFixIdx = trunk.findIndex((s) => s.id === CLAIM_FIX_ID);
  const routeIdx = trunk.findIndex((s) => s.id === ROUTE_ID);
  const cardIdx = trunk.findIndex((s) => s.id === "card");
  const briefIdx = trunk.findIndex((s) => s.id === BRIEF_ID);
  const waitIdx = trunk.findIndex((s) => s.id === WAIT_ID);
  const unclaimedIdx = trunk.findIndex((s) => s.id === NOTIFY_UNCLAIMED_ID);
  if (claimFixIdx < 0) throw new Error(`no trunk step "${CLAIM_FIX_ID}"`);
  if (routeIdx < 0) throw new Error(`no trunk step "${ROUTE_ID}"`);
  if (cardIdx < 0) throw new Error('no trunk step "card"');
  if (briefIdx < 0) throw new Error(`no trunk step "${BRIEF_ID}"`);
  if (waitIdx < 0) throw new Error(`no trunk step "${WAIT_ID}"`);
  if (unclaimedIdx < 0) throw new Error(`no trunk step "${NOTIFY_UNCLAIMED_ID}"`);
  if (routeIdx !== claimFixIdx + 1) {
    throw new Error(`"${ROUTE_ID}" is not immediately after "${CLAIM_FIX_ID}"`);
  }
  if (cardIdx !== routeIdx + 1) {
    throw new Error('"card" is not immediately after "route"');
  }
  if (waitIdx <= briefIdx) {
    throw new Error(`"${WAIT_ID}" should sit after "${BRIEF_ID}" on the live trunk`);
  }

  const route = requireStep(def, ROUTE_ID, "route_to_team");
  const brief = requireStep(def, BRIEF_ID, "voice_brief");
  const wait = requireStep(def, WAIT_ID, "wait_for_call");
  const notifyUnclaimed = requireStep(def, NOTIFY_UNCLAIMED_ID, "notify_owner");

  const routeText = cloneStep(route);
  routeText.id = ROUTE_TEXT_ID;
  delete routeText.when;

  const routeCall = cloneStep(route);
  routeCall.id = ROUTE_ID;
  routeCall.when = { var: "hl_call_outcome", notEquals: "no_call" };
  const offerCopy = typeof routeCall.offerTemplate === "string" ? routeCall.offerTemplate : "";
  if (!offerCopy.includes("Reply 1") || !offerCopy.includes("First to reply 1 gets it.")) {
    throw new Error(`${ROUTE_ID}.offerTemplate is not the live press-1 offer this was written against`);
  }
  if (!offerCopy.includes(CALL_OFFER_LINE)) {
    routeCall.offerTemplate = insertAfterLine(
      offerCopy,
      "Address: {{vars.lead_address}}",
      CALL_OFFER_LINE
    );
  }

  const briefCall = cloneStep(brief);
  delete briefCall.when;

  const waitCall = cloneStep(wait);
  delete waitCall.when;

  const offerGate: Step = {
    id: OFFER_GATE_ID,
    type: "branch",
    question: "Did we claim this HomeLight referral, and is it a call or a text claim?",
    branches: [
      {
        id: OFFER_TEXT_ARM_ID,
        label: "Text-mode claim: offer after the message is sent",
        condition: { var: "claim_mode", equals: "text" },
        steps: [routeText]
      },
      {
        id: OFFER_CALL_ARM_ID,
        label: "Call-mode claim: wait for the seller, then offer only if they were on the line",
        condition: { var: "claim_mode", equals: "call" },
        steps: [
          briefCall,
          waitCall,
          routeCall,
          makeLostOrNoCallAlert(NO_CALL_MSG_ID, NO_CALL_MESSAGE, {
            var: "hl_call_outcome",
            equals: "no_call"
          })
        ]
      }
    ],
    else: [makeLostOrNoCallAlert(LOST_ALERT_ID, LOST_ALERT_MESSAGE)]
  };

  const unclaimedNotice: Step = {
    id: UNCLAIMED_NOTICE_ID,
    type: "branch",
    question: "Did we have a claimable referral that the team never took?",
    branches: [
      {
        id: UNCLAIMED_HAD_CLAIM_ARM_ID,
        label: "We claimed it with HomeLight",
        condition: { var: "claim_mode", notEquals: "none" },
        steps: [
          {
            id: UNCLAIMED_NOT_NOCALL_ID,
            type: "branch",
            question: "Was this a live call that never connected?",
            branches: [
              {
                id: UNCLAIMED_OFFER_MISSED_ARM_ID,
                label: "Offer went out and nobody claimed",
                condition: { var: "hl_call_outcome", notEquals: "no_call" },
                steps: [notifyUnclaimed]
              }
            ],
            else: []
          }
        ]
      }
    ],
    else: []
  };

  const next = trunk.filter(
    (s) => s.id !== ROUTE_ID && s.id !== BRIEF_ID && s.id !== WAIT_ID
  );
  // card must run BEFORE offer_gate so brief_call can use lead_name / lead_notes.
  const insertAt = next.findIndex((s) => s.id === "card");
  if (insertAt < 0) throw new Error('lost "card" while rebuilding the trunk');
  next.splice(insertAt + 1, 0, offerGate);
  const noticeAt = next.findIndex((s) => s.id === NOTIFY_UNCLAIMED_ID);
  if (noticeAt < 0) throw new Error(`lost "${NOTIFY_UNCLAIMED_ID}" while rebuilding the trunk`);
  next[noticeAt] = unclaimedNotice;
  def.steps = next;
  edits.push(
    `replace trunk "${ROUTE_ID}" + "${BRIEF_ID}" + "${WAIT_ID}" with "${OFFER_GATE_ID}"`
  );
  edits.push(`wrap "${NOTIFY_UNCLAIMED_ID}" so lost and no-call leads are not told "not claimed"`);

  for (const id of RETARGET_IDS) {
    const step = requireStep(def, id);
    const when = step.when;
    if (when?.var === "claim_mode" && when.notEquals === "none") continue;
    if (when?.var !== "claimed_agent" || when.notEquals !== "none") {
      throw new Error(
        `"${id}".when is ${JSON.stringify(when)}, expected claimed_agent notEquals none`
      );
    }
    step.when = { var: "claim_mode", notEquals: "none" };
    edits.push(`"${id}".when: claimed_agent notEquals none -> claim_mode notEquals none`);
  }

  const save = requireStep(def, "save_contact", "upsert_customer");
  if (save.when) {
    if (save.when.var !== "claimed_agent" || save.when.notEquals !== "none") {
      throw new Error(
        `save_contact.when is ${JSON.stringify(save.when)}, expected claimed_agent notEquals none`
      );
    }
    delete save.when;
    edits.push('save_contact: drop claimed_agent when (still_ours arm is enough)');
  }

  if (next.length > 30) {
    throw new Error(`patched trunk is ${next.length} steps; the cap is 30`);
  }

  assertPatchedShape(def);
  return edits;
}

export function patchAiFlowDefinition(def: AiFlowDefinition): string[] {
  return patchDefinition(def as unknown as Definition);
}
