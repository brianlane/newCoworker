/**
 * Pure builder for Amy Laidlaw's unclaimed-lead reminder ladder (Aug 2026).
 *
 * Her ask: when nobody claims a lead, stop handing it straight back to her.
 * Nudge the team three more times, twenty minutes apart, and only then let it
 * fall to her. Applies to EVERY step that routes or broadcasts to the team,
 * across all of her lead flows.
 *
 * No env, no I/O, no `main()`: every export is a pure function over a
 * definition object, exactly like amy-speed-to-lead-definition.ts, so the
 * tests pin exact output and the applier stays plumbing.
 */
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";

type Definition = AiFlowDefinition;
type Step = Definition["steps"][number];

/** Amy's ask, verbatim: three rounds, twenty minutes apart. */
export const AMY_REMINDER_ROUNDS = 3;
export const AMY_REMINDER_INTERVAL_MINUTES = 20;

/**
 * Compact context each reminder repeats. Deliberately short: reminders do not
 * re-send the offer body, and on this account that body is the whole Clever
 * referral blob (about 1,500 characters, roughly ten billed segments). The
 * vars used here exist on every flow this patch touches; a missing one
 * renders empty and costs a blank line, never a broken send.
 */
export const AMY_REMINDER_DETAILS = "Address: {{vars.lead_address}}";

/** Walk every step in the tree, including branch arms and elses. */
function walkSteps(steps: readonly Step[], visit: (s: Record<string, unknown>) => void): void {
  for (const st of steps as unknown as Record<string, unknown>[]) {
    visit(st);
    if (st.type === "branch") {
      for (const arm of (st.branches as { steps: Step[] }[]) ?? []) walkSteps(arm.steps, visit);
      walkSteps((st.else as Step[]) ?? [], visit);
    }
  }
}

export type ReminderPatchOptions = {
  rounds?: number;
  intervalMinutes?: number;
  /** Omit to leave the details line off (used where no address var exists). */
  detailsTemplate?: string;
};

/**
 * Turn the ladder on for every route_to_team step in a definition.
 *
 * Idempotent: a step already carrying the exact ladder is left untouched and
 * not reported as changed, so re-running the applier converges. Returns the
 * ids of the steps it changed, which the applier prints and ledgers.
 */
export function addUnclaimedReminders(
  def: Definition,
  opts: ReminderPatchOptions = {}
): string[] {
  const rounds = opts.rounds ?? AMY_REMINDER_ROUNDS;
  const intervalMinutes = opts.intervalMinutes ?? AMY_REMINDER_INTERVAL_MINUTES;
  const detailsTemplate = opts.detailsTemplate;
  const changed: string[] = [];
  walkSteps(def.steps as Step[], (st) => {
    if (st.type !== "route_to_team" || typeof st.id !== "string") return;
    const current = st.unclaimedReminders as Record<string, unknown> | undefined;
    const same =
      current?.rounds === rounds &&
      current?.intervalMinutes === intervalMinutes &&
      (current?.detailsTemplate ?? undefined) === detailsTemplate;
    if (same) return;
    st.unclaimedReminders = {
      rounds,
      intervalMinutes,
      ...(detailsTemplate ? { detailsTemplate } : {})
    };
    changed.push(st.id);
  });
  return changed;
}

/**
 * Turn on "show the team what the lead has already said" for every
 * route_to_team step in a definition (Amy's ask, 2026-08-10: the person taking
 * the lead should see what the lead told us, the same way the claim alerts
 * already reach them).
 *
 * Idempotent, same convention as the reminder ladder: returns the ids of the
 * steps it changed, empty when everything is already in the desired state.
 */
export function addShareContactHistory(def: Definition, enabled = true): string[] {
  const changed: string[] = [];
  walkSteps(def.steps as Step[], (st) => {
    if (st.type !== "route_to_team" || typeof st.id !== "string") return;
    const current = st.shareContactHistory === true;
    if (current === enabled) return;
    if (enabled) st.shareContactHistory = true;
    else delete st.shareContactHistory;
    changed.push(st.id);
  });
  return changed;
}

/**
 * Which flows get the ladder, and what each one repeats in its reminders.
 *
 * `detailsTemplate` is per flow because the vars differ: the lead flows all
 * carry `lead_address`, the spoke check carries the Clever cash offers too,
 * and the follow-up flow's whole point is the requested follow-up, so that is
 * what its reminders should show.
 */
export const AMY_REMINDER_FLOWS: ReadonlyArray<{ name: string; detailsTemplate?: string }> = [
  { name: "Clever Lead - Accept", detailsTemplate: AMY_REMINDER_DETAILS },
  { name: "ReferralExchange Lead", detailsTemplate: AMY_REMINDER_DETAILS },
  { name: "HomeLight Referral", detailsTemplate: AMY_REMINDER_DETAILS },
  { name: "Realtor.com Lead", detailsTemplate: AMY_REMINDER_DETAILS },
  { name: "New Lead Intake", detailsTemplate: AMY_REMINDER_DETAILS },
  {
    name: "Clever - Spoke Check & Weekly Call Follow-Up",
    detailsTemplate: "Address: {{vars.lead_address}}\nCash offers: {{vars.cash_offers}}"
  },
  {
    name: "Follow Up Requested (Unclaimed Leads)",
    detailsTemplate:
      "Lead type: {{vars.route_lead_type}}\nWhat they asked for: {{vars.followup_note}}"
  }
];
