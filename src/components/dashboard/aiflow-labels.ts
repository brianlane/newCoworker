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
import type {
  BROWSE_ACTION_KINDS,
  FLOW_STEP_TYPES,
  TRIGGER_CONDITION_TYPES
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
  send_sms: "Send a text",
  send_email: "Send an email",
  approval_gate: "Ask me to approve first",
  notify_owner: "Notify me",
  http_call: "Call another service (API)",
  route_to_team: "Hand off to team/employees",
  browse_action: "Do something on a web page (click / type)",
  recall_url: "Recall a saved link from an earlier run",
  upsert_customer: "Save / update a customer contact",
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
  send_sms: "Sends a text message. You can reuse details earlier steps found.",
  send_email: "Sends an email. You can reuse details earlier steps found.",
  approval_gate: "Pauses and texts you to approve before continuing.",
  notify_owner: "Sends you a quick update without pausing the workflow.",
  http_call: "Sends data to another connected service through its API.",
  route_to_team: "Offers the lead to a teammate to claim, and falls back to you if no one does.",
  browse_action: "Clicks buttons or types into fields on a web page on your behalf.",
  recall_url:
    "Looks up a link a previous run saved for this same person (by phone) so this run can reuse it.",
  upsert_customer:
    "Creates or updates a customer on your Customers page from details earlier steps found (phone, name, email).",
  ring_handoff:
    "Warm-transfers the live caller to a person and rings them. If they don't answer, the next ring step (or AI takeover) runs.",
  voice_ai_intake:
    "After everyone misses the call, a person presses 1 to hand it to the AI, which talks to the caller, captures the lead, and texts you a summary.",
  voice_transfer:
    "Connects the caller straight to one number (optionally saying a short message first). Use this alone for a simple forward.",
  outbound_call:
    "Places a call to a number you choose; when they answer, the AI talks to them, captures the details, and texts you a summary. Use the Place call button to start it (budget is checked first)."
};

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
