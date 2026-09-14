/**
 * Pure builder: after a HomeLight text claim, do not call our own claim
 * "another agent", and do not tell Amy the contact never arrived when the
 * portal card already shows it.
 *
 * INCIDENT, 2026-09-14, Vince N. (85140, ~$428K), run
 * `e09b3f18-b071-4d4f-9a97-68d6b297568b`. `claim_text` completed. The portal
 * card (Claimed By Amy Laidlaw, phone, email, street address) was visible to
 * Amy. `claim_verify` still wrote `claim_state=another agent has it` because
 * that field's prompt said "Taken by another agent" and did not name our
 * team. `already_claimed` already names the team and correctly said `no`.
 * `card` had been gated on roster `claimed_agent`, so it never read the
 * phone. Three mailbox reads (`unclaimed_email_read`, `late_read`,
 * `late2_read`) all returned `{found:false}`. `late2_never_notify` then said
 * HomeLight never sent the contact, claimed by none.
 *
 * `already_claimed` was taught this lesson on Kevin Duford (Aug 11, run
 * `85d1bd1f`). `claim_state` never got the same sentence. Text claims reveal
 * details on the portal after Send message; the late ladder only re-reads
 * email, which is the call-claim path.
 *
 * WHAT THIS CHANGES (no net trunk add):
 *   - `claim_verify` / `claim_verify2` `claim_state` copy: Claimed By this
 *     team is `claim message sent`, not `another agent has it`.
 *   - On the late2 missing arm, `late2_portal` re-reads the portal card
 *     (`fillOnlyEmpty`) before the never-sent alerts.
 *   - Those alerts only fire when `lead_phone` is still `none`. If the
 *     portal had the number, `late2_portal_alert` tells the team instead.
 *
 * Unique step ids kept. `when` stays one condition on one var.
 *
 * Pure: no I/O. The applier reads, validates, writes, and records the ledger.
 */

import type { AiFlowDefinition } from "@/lib/ai-flows/schema";
import { CLAIM_STATE_FIELD } from "./homelight-verified-claim";

export const PORTAL_ID = "late2_portal";
export const PHONE_MISS_ID = "late2_phone_miss";
export const PHONE_MISS_ARM_ID = "late2_phone_none";
export const PORTAL_ALERT_ID = "late2_portal_alert";
export const NEVER_AGENT_ID = "late2_never_agent";
export const NEVER_NOTIFY_ID = "late2_never_notify";
export const CARD_ID = "card";
export const VERIFY_ID = "claim_verify";
export const VERIFY2_ID = "claim_verify2";

export const PORTAL_ALERT_MESSAGE =
  "HomeLight has {{vars.lead_first_name}}'s contact on the portal " +
  "({{vars.lead_type}} in {{vars.city}}, ~{{vars.price}}). The mailbox read " +
  "missed it, so no outreach went out from the email ladder.\n" +
  "Phone: {{vars.lead_phone}}\nEmail: {{vars.lead_email}}\n" +
  "Address: {{vars.lead_address}}\n" +
  "Roster claim: {{vars.claimed_agent}}.\nPortal: {{vars.leadUrl}}";

/** Replaces the live-transfer-only lie. Text claims reveal on the portal. */
export const NEVER_AGENT_BODY =
  "HomeLight still has not sent {{vars.lead_first_name}}'s contact info " +
  "({{vars.lead_type}} in {{vars.city}}, ~{{vars.price}}). The portal card " +
  "also has no phone. Nothing to call yet.\nCheck the portal: {{vars.leadUrl}}";

export const NEVER_NOTIFY_MESSAGE =
  "HomeLight never sent {{vars.lead_first_name}}'s contact info " +
  "({{vars.lead_type}} in {{vars.city}}, ~{{vars.price}}), claimed by " +
  "{{vars.claimed_agent}}. No phone on the portal or in email, so no " +
  "outreach went out.\nPortal: {{vars.leadUrl}}";

export type Step = Record<string, unknown> & {
  id?: string;
  type?: string;
  body?: string;
  message?: string;
  when?: { var?: string; equals?: string; notEquals?: string; contains?: string };
  fields?: Array<{ name?: string; description?: string }>;
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

export const SHIFT_UNSAFE_RESUME_IDS = [
  PORTAL_ID,
  PHONE_MISS_ID,
  PORTAL_ALERT_ID,
  NEVER_AGENT_ID,
  NEVER_NOTIFY_ID
] as const;

function walkSteps(steps: unknown, visit: (s: Step, parent: Step[] | undefined) => void): void {
  if (!Array.isArray(steps)) return;
  const list = steps as Step[];
  for (const step of list) {
    if (!step || typeof step !== "object") continue;
    visit(step, list);
    if (Array.isArray(step.branches)) {
      for (const arm of step.branches) walkSteps(arm?.steps, visit);
    }
    walkSteps(step.else, visit);
  }
}

export function findStep(def: Definition, id: string): Step | null {
  let found: Step | null = null;
  walkSteps(def.steps, (s) => {
    if (found === null && s.id === id) found = s;
  });
  return found;
}

function parentListOf(def: Definition, id: string): Step[] | null {
  let parent: Step[] | null = null;
  walkSteps(def.steps, (s, list) => {
    if (parent === null && s.id === id && list) parent = list;
  });
  return parent;
}

function contactFieldsFromCard(def: Definition): Array<{ name?: string; description?: string }> {
  const card = findStep(def, CARD_ID);
  if (!card) throw new Error(`no step "${CARD_ID}"`);
  const wanted = new Set(["lead_name", "lead_phone", "lead_email", "lead_address"]);
  const fields = (card.fields ?? []).filter((f) => f?.name && wanted.has(f.name));
  if (fields.length < 4) throw new Error(`"${CARD_ID}" is missing contact fields`);
  return fields.map((f) => ({ ...f }));
}

function portalStep(def: Definition): Step {
  const card = findStep(def, CARD_ID);
  if (!card) throw new Error(`no step "${CARD_ID}"`);
  return {
    id: PORTAL_ID,
    type: "browse_extract",
    urlVar: card.urlVar,
    ...(card.auth ? { auth: card.auth } : {}),
    fillOnlyEmpty: true,
    screenshot: true,
    when: { var: "late2_contact_status", notEquals: "found" },
    fields: contactFieldsFromCard(def)
  };
}

function sameClaimState(fields: unknown): boolean {
  if (!Array.isArray(fields) || fields.length !== 1) return false;
  const f = fields[0] as { name?: string; description?: string };
  return f?.name === CLAIM_STATE_FIELD.name && f.description === CLAIM_STATE_FIELD.description;
}

export function patchDefinition(def: Definition): string[] {
  const edits: string[] = [];
  const trunk = def.steps;
  if (!Array.isArray(trunk)) throw new Error("definition has no steps array");

  for (const id of [VERIFY_ID, VERIFY2_ID]) {
    const step = findStep(def, id);
    if (!step) throw new Error(`no step "${id}"`);
    if (step.type !== "browse_extract") throw new Error(`"${id}" is not browse_extract`);
    if (!sameClaimState(step.fields)) {
      step.fields = [{ ...CLAIM_STATE_FIELD }];
      edits.push(`"${id}".claim_state: our team is not another agent`);
    }
  }

  const neverNotify = findStep(def, NEVER_NOTIFY_ID);
  if (!neverNotify) throw new Error(`no step "${NEVER_NOTIFY_ID}"`);
  const neverAgent = findStep(def, NEVER_AGENT_ID);
  if (!neverAgent) throw new Error(`no step "${NEVER_AGENT_ID}"`);

  const parent = parentListOf(def, NEVER_NOTIFY_ID);
  if (!parent) throw new Error(`"${NEVER_NOTIFY_ID}" has no parent list`);

  if (!findStep(def, PORTAL_ID)) {
    const agentAt = parent.findIndex((s) => s.id === NEVER_AGENT_ID);
    if (agentAt < 0) throw new Error(`"${NEVER_AGENT_ID}" is not a sibling of "${NEVER_NOTIFY_ID}"`);
    parent.splice(agentAt, 0, portalStep(def));
    edits.push(`insert "${PORTAL_ID}" before "${NEVER_AGENT_ID}"`);
  }

  if (!findStep(def, PHONE_MISS_ID)) {
    const agentAt = parent.findIndex((s) => s.id === NEVER_AGENT_ID);
    const notifyAt = parent.findIndex((s) => s.id === NEVER_NOTIFY_ID);
    if (agentAt < 0 || notifyAt !== agentAt + 1) {
      throw new Error(`"${NEVER_AGENT_ID}" / "${NEVER_NOTIFY_ID}" are not adjacent`);
    }
    const agent = parent[agentAt]!;
    const notify = parent[notifyAt]!;
    const wrappedAgent = JSON.parse(JSON.stringify(agent)) as Step;
    const wrappedNotify = JSON.parse(JSON.stringify(notify)) as Step;
    delete wrappedAgent.when;
    delete wrappedNotify.when;
    parent.splice(agentAt, 2, {
      id: PHONE_MISS_ID,
      type: "branch",
      question: "Did the portal card have a phone number after the mailbox miss?",
      when: { var: "late2_contact_status", notEquals: "found" },
      branches: [
        {
          id: PHONE_MISS_ARM_ID,
          label: "Still no phone",
          condition: { var: "lead_phone", equals: "none" },
          steps: [wrappedAgent, wrappedNotify]
        }
      ],
      else: [
        {
          id: PORTAL_ALERT_ID,
          type: "notify_owner",
          message: PORTAL_ALERT_MESSAGE
        }
      ]
    });
    edits.push(`wrap never-sent alerts in "${PHONE_MISS_ID}" (portal phone skips them)`);
  }

  const agent = findStep(def, NEVER_AGENT_ID);
  if (agent && agent.body !== NEVER_AGENT_BODY) {
    agent.body = NEVER_AGENT_BODY;
    edits.push(`"${NEVER_AGENT_ID}" body: portal can reveal a text claim`);
  }
  const notify = findStep(def, NEVER_NOTIFY_ID);
  if (notify && notify.message !== NEVER_NOTIFY_MESSAGE) {
    notify.message = NEVER_NOTIFY_MESSAGE;
    edits.push(`"${NEVER_NOTIFY_ID}" message: never-sent means portal and email both missed`);
  }

  return edits;
}

export type { AiFlowDefinition };
