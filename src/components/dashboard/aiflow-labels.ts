/**
 * Plain-English display labels for AiFlow building blocks.
 *
 * These are DISPLAY-ONLY. The stored definition still uses the raw enum values
 * (`step.type`, `condition.type`, `action.kind`) from the schema, so relabeling
 * here never changes what is saved or how the worker runs an existing flow.
 * Shared by the editor (AiFlowsManager) and the read-only view (AiFlowView) so
 * the wording stays identical in both places. Lives under `src/components`
 * (outside the test-coverage include) since it is pure presentation strings.
 */
import {
  summarizeDefinition,
  type AiFlowDefinition,
  type BROWSE_ACTION_KINDS,
  type FLOW_STEP_TYPES,
  type TRIGGER_CONDITION_TYPES
} from "@/lib/ai-flows/schema";

type StepType = (typeof FLOW_STEP_TYPES)[number];
type ConditionType = (typeof TRIGGER_CONDITION_TYPES)[number];
type BrowseActionKind = (typeof BROWSE_ACTION_KINDS)[number];

/** Friendly name for each step type, shown on buttons and step headers. */
export const STEP_TYPE_LABELS: Record<StepType, string> = {
  extract_url: "Get the link from the text",
  browse_extract: "Read details from a web page",
  extract_text: "Read details from the message text",
  email_extract: "Read details from an email",
  doc_extract: "Read details from a document (PDF or Word)",
  send_sms: "Send a text",
  send_whatsapp: "Send a WhatsApp message",
  reply_to_comment: "Reply to the Instagram comment",
  send_email: "Send an email",
  email_organize: "Organize an email (label / move / archive)",
  approval_gate: "Ask me to approve first",
  notify_owner: "Notify me",
  notify_lead_owner: "Notify the lead's owner",
  http_call: "Call another service (API)",
  branch: "Branch (if / else paths)",
  goal: "Goal (skip ahead when reached)",
  math: "Calculate (numbers & dates)",
  sleep: "Wait before continuing",
  wait_for_reply: "Wait for their reply",
  place_ai_call: "Call them (AI talks, can live-transfer)",
  arm_voice_transfer: "Expect a call (send it to a person)",
  voice_brief: "Brief the AI on a call in progress",
  wait_for_call: "Wait for the AI's call to end",
  route_to_team: "Hand off to team/employees",
  browse_action: "Do something on a web page (click / type)",
  recall_url: "Recall a saved link from an earlier run",
  upsert_customer: "Save / update a customer contact",
  update_contact: "Update the contact's tags (lead status)",
  classify: "Decide what the message means",
  generate_image: "Create an AI-generated image",
  share_document: "Share a business document (expiring link)",
  run_agent: "Run one of your Agents",
  ring_handoff: "Ring a person (warm transfer)",
  voice_ai_intake: "AI takes the call (capture the lead)",
  voice_transfer: "Connect the caller to a number",
  outbound_call: "Place an outbound call (AI talks)"
};

/** One-line explanation of what each step does, shown under the step header. */
export const STEP_TYPE_HELP: Record<StepType, string> = {
  extract_url: "Pulls the first link out of the incoming message and saves it for later steps.",
  browse_extract: "Opens a saved link and reads the details you ask for (like a phone number).",
  extract_text:
    "Reads the details you ask for (like a name or phone number) straight from the incoming message - no link needed.",
  email_extract:
    "Reads details from a recent email in a connected mailbox - used to backfill lead info (like a phone or address) from an alert email when a web page was slow or empty.",
  doc_extract:
    "Reads the details you ask for (like a premium, a renewal date, or a policy number) out of the document attached to the triggering email - PDFs included. Optionally files the document into your Documents - and can file it as a record ON the customer's contact, with the extracted fields and renewal date attached, so renewal reminders fire automatically. If the email has no document, the step is skipped. Uses your monthly AI budget.",
  send_sms: "Sends a text message. You can reuse details earlier steps found.",
  send_whatsapp:
    "Sends a WhatsApp message from your connected WhatsApp Business number. If the person hasn't messaged you in the last 24 hours, an approved template carries the message (Meta bills per template message).",
  reply_to_comment:
    "Answers the Instagram comment that started this automation. \"Publicly\" posts a reply on the comment thread, where everyone reading the post sees it. \"Privately\" sends the commenter a direct message in their Instagram inbox - Instagram allows only ONE of those per comment, and only within 7 days of the comment.",
  send_email:
    "Sends an email. You can reuse details earlier steps found, and attach a business document - including a PDF a \"Run an agent\" step just generated.",
  email_organize:
    "Files the triggering email: apply labels, move it to a folder, archive it, and/or mark it read or unread. Works on a connected Gmail/Outlook mailbox or your AI coworker's in-app mailbox. Pair with Classify + Branch for inbox triage.",
  approval_gate: "Pauses and texts you to approve before continuing.",
  notify_owner: "Sends you a quick update without pausing the workflow.",
  notify_lead_owner:
    "Texts whoever the lead belongs to: the teammate who owns the contact (e.g. because they claimed the lead), or you when no one does. Great for forwarding a lead's reply to the right person.",
  http_call: "Sends data to another connected service through its API.",
  sleep:
    "Pauses the workflow (for a number of minutes, or until a time of day) and then continues with the next step. Nothing is sent while waiting.",
  wait_for_reply:
    "Pauses until the person texts back (or the wait times out). Their reply is saved so later steps can branch on it - if they don't reply in time, the saved reply is empty, which lets you send a follow-up nudge.",
  place_ai_call:
    "Places a phone call to a number an earlier step found; the AI opens with your script and, if you configure a transfer, connects them live to a person (texting that person a heads-up first). The workflow pauses until the call ends and saves the outcome (transferred / answered / no_answer) so later steps can branch on it. Uses your voice minutes.",
  arm_voice_transfer:
    "For a short window after this step runs, the next incoming call that doesn't match your per-caller call routing is connected straight to the person you pick instead of the AI answering. Use it when a referral service texts you a cue and then calls from an unpredictable number minutes later (one window connects one call).",
  voice_brief:
    "Hands what this workflow just found to the AI that is on a call right now, so it can use those details and tell the customer their information came through instead of asking them to repeat it. Does nothing when no call from that number is live, which is the normal case.",
  wait_for_call:
    "Pauses until the AI's call with that number hangs up, then carries on with whatever the AI learned on it (their name, the best number to reach them, the address). Use it when the details only exist in the conversation, for example a referral service that will not release the customer's phone number until after the call. If there is no call, the workflow just keeps going.",
  branch:
    "Splits the workflow into paths: each path has a condition (checked top to bottom, first match wins) and its own steps; no match runs the \"none matched\" path.",
  goal:
    "A checkpoint tied to a milestone (they reply, an appointment is booked, a tag is added, or a teammate claims the lead). The moment the milestone happens, the workflow jumps straight here - skipping any follow-ups in between - so people who already converted stop getting nudges.",
  math:
    "Does arithmetic on numbers and dates from earlier steps (add, subtract, multiply, divide, round, date math) and saves the result - use it for lead scoring or \"renewal within 30 days\" style branching.",
  route_to_team: "Offers the lead to a teammate to claim, and falls back to you if no one does.",
  browse_action: "Clicks buttons or types into fields on a web page on your behalf.",
  recall_url:
    "Looks up a link a previous run saved for this same person (by phone) so this run can reuse it.",
  upsert_customer:
    "Creates or updates a customer on your Customers page from details earlier steps found (phone, name, email).",
  update_contact:
    "Adds/removes tags on the contact (matched by phone) so your Contacts page always shows each lead's current status - e.g. remove \"New Lead\", add \"Contacted\".",
  classify:
    "Reads a message (like their reply) and sorts it into ONE of your categories - e.g. wants_a_call / has_a_question / not_interested - so a Branch step can take the right path on meaning, not exact words.",
  generate_image:
    "Creates an image from your description and saves a link to it. Attach it to a later \"Send a text\" step (goes out as a picture message) or include the link in an email. Uses your monthly AI budget.",
  share_document:
    "Texts or emails the person an expiring link to one of your uploaded documents (price sheet, policy, contract). Only client-facing, unexpired documents can be shared - an expired document fails the step and notifies you instead of sending a stale copy.",
  run_agent:
    "Runs one of your saved Agents (from the Agents page) on text from this workflow or on the document attached to the triggering email (PDFs included) - e.g. compare the quotes in an emailed PDF - and saves the result for later steps to send or reference. Can also file the result into your Documents. Uses your monthly AI budget.",
  ring_handoff:
    "Warm-transfers the live caller to a person and rings them. If they don't answer, the next ring step (or AI takeover) runs.",
  voice_ai_intake:
    "After everyone misses the call, a person presses 1 to hand it to the AI, which talks to the caller, captures the lead, and texts you a summary.",
  voice_transfer:
    "Connects the caller straight to one number (optionally saying a short message first). Use this alone for a simple forward.",
  outbound_call:
    "Places a call to a number you choose; when they answer, the AI talks to them, captures the details, and texts you a summary. Use the Place call button to start it (budget is checked first)."
};

/** "1 rule" / "3 rules", because "1 condition(s)" is nobody's first language. */
function ruleCount(n: number): string {
  return `${n} rule${n === 1 ? "" : "s"}`;
}

/**
 * When this flow runs, in the words an owner would use.
 *
 * `summarizeDefinition` in the schema also describes a trigger, and it stays as
 * it is: it feeds debug CLIs and tests, where "When a webhook event matches 1
 * condition(s)" is precise and fine. On the dashboard it is jargon plus an
 * awkward plural, and an owner reading their own flow list should not have to
 * know what a webhook is. So the owner-facing wording lives here beside the step
 * labels, which were already written this way.
 *
 * The channels this does not re-word (calendar, tags, birthdays, voice) already
 * read as English in the schema, so they fall through to it rather than being
 * duplicated and left to drift.
 */
export function friendlyTriggerLabel(def: AiFlowDefinition): string {
  const t = def.trigger;
  const conditions = "conditions" in t ? t.conditions.length : 0;
  switch (t.channel) {
    case "sms":
      return conditions === 0
        ? "When anyone texts you"
        : `When a text matches your ${ruleCount(conditions)}`;
    case "manual":
      return "When you ask for it";
    case "email":
      return conditions === 0
        ? "When any email arrives"
        : `When an email matches your ${ruleCount(conditions)}`;
    case "tenant_email":
      return conditions === 0
        ? "When your coworker's mailbox gets an email"
        : `When your coworker's mailbox gets an email matching your ${ruleCount(conditions)}`;
    case "webhook":
      return conditions === 0
        ? "When another system sends something in"
        : `When another system sends something in matching your ${ruleCount(conditions)}`;
    case "contact_created":
      return conditions === 0
        ? "When a new contact is added"
        : `When a new contact is added matching your ${ruleCount(conditions)}`;
    default:
      // Steps and extra triggers are both dropped from the input rather than
      // trimmed off the output: summarizeDefinition appends its own "(or N
      // other triggers)" tail, and friendlyFlowSummary adds that itself, so
      // asking for the bare trigger is what keeps it from appearing twice.
      // The trailing ": " is what summarizeDefinition leaves with no steps.
      return summarizeDefinition({ ...def, steps: [], triggers: undefined }).replace(/:\s*$/, "");
  }
}

/**
 * Owner-facing one-line summary of a flow: when it runs, then what it does, as
 * friendly labels rather than raw step types. "When anyone texts you: Read
 * details from the message text → Send a text → Notify me".
 *
 * Display-only. The stored definition and the `summarizeDefinition` string used
 * by scripts and tests are both untouched.
 */
export function friendlyFlowSummary(def: AiFlowDefinition): string {
  const trigPart = friendlyTriggerLabel(def);
  const extra = def.triggers?.length ?? 0;
  const withExtras =
    extra > 0 ? `${trigPart} (or ${extra} other trigger${extra === 1 ? "" : "s"})` : trigPart;
  if (def.steps.length === 0) return withExtras;
  const stepPart = def.steps.map((s) => STEP_TYPE_LABELS[s.type]).join(" → ");
  return `${withExtras}: ${stepPart}`;
}

/** Friendly name for each inbound trigger condition. */
export const CONDITION_LABELS: Record<ConditionType, string> = {
  contains: "Message contains text",
  regex: "Message matches a pattern (advanced)",
  has_url: "Message contains a link",
  from_matches: "Comes from a specific sender"
};

/** Friendly name for each browse_action kind. */
export const BROWSE_ACTION_LABELS: Record<BrowseActionKind, string> = {
  click_text: "Click a button or link by its text",
  click_selector: "Click an element (CSS selector)",
  fill_selector: "Type into a field (CSS selector)",
  fill_placeholder: "Type into a field (by its placeholder)",
  click_text_while_present: "Keep clicking a button until it's gone (e.g. \"Next\")",
  click_role: "Click a control by its role + name (e.g. a calendar day)",
  select_option: "Choose an option from a dropdown"
};
