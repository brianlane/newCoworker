/**
 * AiFlow test runs ("Test with a contact", GHL's Test Workflow).
 *
 * A test run executes the REAL engine — trigger scope, templating,
 * extraction, branching, goals — but never touches the outside world or the
 * CRM: every side-effecting action is SIMULATED (its fully-rendered output
 * recorded as the step result) and every wait resolves instantly, so the
 * whole flow plays out in seconds on the runs page.
 *
 * The flag rides on the run's trigger scope (`trigger.test_mode: true`)
 * because the trigger is persisted verbatim across every park/resume;
 * enqueued only by the owner-facing test-run route.
 *
 * Simulated (side effects): send_sms, send_email, notify_owner, http_call,
 * route_to_team, approval gates (auto-approved), browse_action (clicks/typing
 * on real pages), generate_image (spends budget), upsert_customer /
 * update_contact (would pollute the CRM), sleep and wait_for_reply (instant).
 *
 * Real (read-only / pure): set_vars, browse (page read), extract_text,
 * email_extract, classify, recall_url, goal checkpoints.
 */
import { NO_REPLY_SENTINEL, type StepAction } from "./steps.ts";

/** Key on the run's trigger scope marking a test run. */
export const TEST_MODE_TRIGGER_KEY = "test_mode";

/** What a simulated wait_for_reply saves as the "reply". */
export const TEST_REPLY_TEXT = "test_reply";

/** True when a run's persisted trigger scope marks it as a test run. */
export function isTestModeTrigger(trigger: Record<string, unknown> | undefined): boolean {
  return trigger?.[TEST_MODE_TRIGGER_KEY] === true;
}

/**
 * Simulate one planned action for a test run. Returns the step result to
 * record (already fully rendered — exactly what the live run would have
 * sent/done), or null when the action is safe to execute for real. May stamp
 * scope vars the same way the live path would (wait markers, saveAs values)
 * so downstream steps and branches behave identically.
 */
export function simulateTestAction(
  action: StepAction,
  scope: { vars: Record<string, unknown> }
): Record<string, unknown> | null {
  switch (action.kind) {
    case "send_sms":
      // A planner skip (templated recipient resolved to nothing usable) must
      // read as the SKIP the live run would record — not as a successful
      // send to the "(group thread)" display fallback.
      if (action.skipReason) {
        return { simulated: "send_sms", skipped: action.skipReason };
      }
      return {
        simulated: "send_sms",
        to: action.toAgentName || action.toRef?.label || action.to || "(group thread)",
        body: action.body
      };
    case "send_email":
      return {
        simulated: "send_email",
        to: action.to,
        subject: action.subject,
        body: action.body
      };
    case "share_document": {
      // Same skip semantics as send_sms: a live run never mints a link for a
      // missing recipient, so the test run must not report one (or stamp the
      // saveAs var with a placeholder link that was never "sent").
      if (action.skipReason) {
        return { simulated: "share_document", skipped: action.skipReason };
      }
      // No link is minted (a real share row would be a live capability URL);
      // the saveAs var gets a placeholder so later templates render visibly.
      const placeholder = "https://example.invalid/test-share-link";
      if (action.saveAs) scope.vars[action.saveAs] = placeholder;
      return {
        simulated: "share_document",
        documentId: action.documentId,
        via: action.via,
        to: action.to || "(no recipient)",
        message: action.message
      };
    }
    case "run_agent": {
      // No model call is made (budget-metered); the saveAs var gets a visible
      // placeholder so later templates render distinguishably.
      if (action.skipReason) {
        // Live skips stamp the var "" — mirror that so later when-guards and
        // templates behave identically in test and production.
        scope.vars[action.saveAs] = "";
        return { simulated: "run_agent", skipped: action.skipReason };
      }
      scope.vars[action.saveAs] = "(test run: agent output placeholder)";
      return {
        simulated: "run_agent",
        agentId: action.agentId,
        ...(action.agentName ? { agentName: action.agentName } : {}),
        input: action.input
      };
    }
    case "notify_owner":
      return { simulated: "notify_owner", message: action.message };
    case "http_call":
      return {
        simulated: "http_call",
        label: action.label,
        method: action.method,
        path: action.path,
        body: action.body
      };
    case "await_approval":
      // Auto-approve so the flow keeps playing; the result says so.
      return { simulated: "approval_gate", decision: "auto_approved_test", prompt: action.prompt };
    case "route_to_team": {
      // No offer goes out; the claim sentinel stays "none" so claim-gated
      // later steps show their real (skipped) behavior.
      return { simulated: "route_to_team", offer: action.offerTemplate };
    }
    case "browse_action":
      return {
        simulated: "browse_action",
        url: action.url,
        actions: action.actions.map((a) => `${a.kind}: ${a.target}`)
      };
    case "generate_image":
      // No image is generated (budget-metered); the saveAs var stays empty so
      // a later MMS attachment degrades to plain text exactly like a live
      // failed generation would.
      scope.vars[action.saveAs] = "";
      return { simulated: "generate_image", prompt: action.prompt };
    case "upsert_customer":
      return { simulated: "upsert_customer", customer_e164: action.e164, name: action.name };
    case "update_contact":
      return {
        simulated: "update_contact",
        customer_e164: action.e164,
        addTags: action.addTags,
        removeTags: action.removeTags
      };
    case "sleep":
      // Resolve instantly; the marker keeps the step a no-op on re-entry.
      scope.vars[action.marker] = "1";
      return { simulated: "sleep", skipped_wait: true };
    case "wait_for_reply":
      // Pretend the lead replied immediately so the replied branch plays out;
      // authors can flip the branch by testing against NO_REPLY_SENTINEL.
      scope.vars[action.saveAs] = TEST_REPLY_TEXT;
      scope.vars[action.marker] = "1";
      return {
        simulated: "wait_for_reply",
        saved: { [action.saveAs]: TEST_REPLY_TEXT },
        no_reply_sentinel: NO_REPLY_SENTINEL
      };
    case "place_ai_call": {
      // No call is placed (voice minutes are metered). Resolve instantly with
      // the outcome the configured happy path would produce — "transferred"
      // when a live transfer is configured, else "answered" — so the
      // follow-up gating downstream plays out its success branch. A planner
      // skip (no usable callee phone) mirrors the live not_placed sentinel.
      if (action.skipReason) {
        scope.vars[action.saveAs] = "not_placed";
        scope.vars[action.marker] = "1";
        return { simulated: "place_ai_call", skipped: action.skipReason };
      }
      const outcome = action.transferToE164 || action.transferToRef ? "transferred" : "answered";
      scope.vars[action.saveAs] = outcome;
      scope.vars[action.marker] = "1";
      return {
        simulated: "place_ai_call",
        to: action.to,
        persona: action.persona,
        ...(action.preSmsBody ? { pre_alert: action.preSmsBody } : {}),
        saved: { [action.saveAs]: outcome }
      };
    }
    default:
      return null;
  }
}
