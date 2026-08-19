/**
 * Pure builder: make ReferralExchange remind Amy weekly, using RE's own
 * reminder scheduler.
 *
 * THE PROBLEM. `re_update` posts to a referral's timeline once, on arrival day,
 * and never again. A lead that arrives on the 1st shows one entry and then
 * silence, which is exactly the "no recent update" state RE penalises.
 *
 * WHY NOT A SCHEDULED FLOW. A `schedule` trigger produces no trigger text and
 * no URL, and `browse_action.urlVar` takes a VAR name with no literal-URL
 * field, so nothing can point a scheduled run at a referral page. Every portal
 * write has to be driven by a message that carries its own link. RE does not
 * send a periodic nudge we could hang one on.
 *
 * WHAT IT DOES SEND is a reminder it schedules for you. Step 3 of the same
 * "Leave an update" modal the flow already drives is "Schedule text reminder
 * (optional)", and its markup (read live 2026-08-18) is refreshingly plain:
 *
 *   <button id="reminder-selector" class="reminder-button" value="pickADate">
 *     Pick date & time</button>
 *   <div class="datetime-container">
 *     <input name="reminderDate" type="date" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}">
 *     <select name="reminderHour">   -- , 1..12
 *     <select name="reminderMinutes"> -- , 00, 15, 30, 45
 *     <select name="reminderAmPm">    AM, PM
 *   </div>
 *
 * A native date input and three selects, no calendar widget to walk. The other
 * two presets ("Tomorrow morning", "Tomorrow afternoon") are single clicks but
 * would text Amy about every open referral EVERY DAY. Seven days out is one
 * text per referral per week, which is Brian's call and matches the cadence RE
 * actually asks for.
 *
 * This is deliberately a BOOTSTRAP. Scheduling the reminder is what causes RE
 * to send a text we have never seen, and that text is the trigger a recurring
 * update flow needs. We cannot author that trigger against wording nobody has
 * read: this repo has gone dead for weeks twice by matching on guessed vendor
 * copy. So this ships the half that generates the evidence, and the flow that
 * consumes it is authored once a real reminder lands in `sms_inbound_jobs`.
 *
 * Pure: no I/O. The applier reads, validates, writes and records the ledger.
 */
import type { AiFlowDefinition, FlowStep } from "@/lib/ai-flows/schema";

/** RE's own reminder controls, verbatim from the live modal. */
export const REMINDER_PICK_BUTTON = "#reminder-selector";
export const REMINDER_DATE_INPUT = 'input[name="reminderDate"]';
export const REMINDER_HOUR_SELECT = 'select[name="reminderHour"]';
export const REMINDER_MINUTES_SELECT = 'select[name="reminderMinutes"]';
export const REMINDER_AMPM_SELECT = 'select[name="reminderAmPm"]';

/**
 * 9:00 AM, seven days out. `{{now.in7Days.iso}}` renders YYYY-MM-DD in the
 * business timezone, which is exactly the `pattern` the date input declares.
 */
export const REMINDER_DATE_TEMPLATE = "{{now.in7Days.iso}}";
export const REMINDER_HOUR = "9";
export const REMINDER_MINUTES = "00";
export const REMINDER_AMPM = "AM";

/** The submit the reminder actions must stay in front of. */
const SUBMIT_SELECTOR = ".update-status-container .submit.action-details button";

type Action = Record<string, string>;

/** The five actions that schedule RE's reminder for a week out. */
export function reminderActions(): Action[] {
  return [
    { kind: "click_selector", target: REMINDER_PICK_BUTTON },
    { kind: "fill_selector", target: REMINDER_DATE_INPUT, valueTemplate: REMINDER_DATE_TEMPLATE },
    { kind: "select_option", target: REMINDER_HOUR_SELECT, valueTemplate: REMINDER_HOUR },
    { kind: "select_option", target: REMINDER_MINUTES_SELECT, valueTemplate: REMINDER_MINUTES },
    { kind: "select_option", target: REMINDER_AMPM_SELECT, valueTemplate: REMINDER_AMPM }
  ];
}

function actionsOf(step: FlowStep): Action[] | null {
  const a = (step as { actions?: unknown }).actions;
  return Array.isArray(a) ? (a as Action[]) : null;
}

/** Walk trunk, branch arms and else lists. */
function walk(steps: readonly FlowStep[], visit: (s: FlowStep) => void): void {
  for (const s of steps) {
    visit(s);
    const b = s as unknown as { branches?: Array<{ steps?: FlowStep[] }>; else?: FlowStep[] };
    for (const arm of b.branches ?? []) walk(arm.steps ?? [], visit);
    walk(b.else ?? [], visit);
  }
}

/**
 * Insert the reminder actions immediately BEFORE the submit, on every step that
 * drives RE's update modal. Returns the step ids changed.
 *
 * Before the submit because RE's modal is ordered (status, note, reminder) and
 * the submit is what commits all three. Appending after it would schedule
 * nothing and click into a closed modal.
 *
 * Idempotent: a step that already carries the pick button is left alone.
 */
export function addWeeklyReminder(def: AiFlowDefinition): string[] {
  const changed: string[] = [];
  walk(def.steps, (step) => {
    const actions = actionsOf(step);
    if (!actions) return;
    const submitAt = actions.findIndex(
      (a) => a.kind === "click_selector" && a.target === SUBMIT_SELECTOR
    );
    if (submitAt < 0) return;
    if (actions.some((a) => a.target === REMINDER_PICK_BUTTON)) return;
    actions.splice(submitAt, 0, ...reminderActions());
    changed.push(step.id);
  });
  return changed;
}

/** Convenience for the applier and tests. */
export function buildWithReminder(live: AiFlowDefinition): {
  definition: AiFlowDefinition;
  changed: string[];
} {
  const next = JSON.parse(JSON.stringify(live)) as AiFlowDefinition;
  return { definition: next, changed: addWeeklyReminder(next) };
}
