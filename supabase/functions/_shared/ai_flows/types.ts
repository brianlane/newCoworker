/**
 * AiFlows shared type definitions (the JSONB `definition` shape stored on
 * `ai_flows.definition`).
 *
 * This is the single canonical description of an automation. The Deno engine
 * (engine.ts, consumed by the ai-flow-worker + telnyx-sms-inbound trigger hook)
 * imports these types; the Next.js authoring side mirrors them with a zod
 * schema in src/lib/ai-flows/schema.ts (kept in sync deliberately, the same way
 * the Deno chat_spend_cap mirrors the Node chat-worker fuse).
 *
 * Pure type-only module: no runtime statements, so it contributes nothing to
 * coverage.
 */

export const AI_FLOW_DEFINITION_VERSION = 1 as const;

/** A single trigger condition. All conditions on a trigger are AND-ed. */
export type TriggerCondition =
  | { type: "contains"; value: string; caseInsensitive?: boolean }
  | { type: "regex"; value: string; caseInsensitive?: boolean }
  | { type: "has_url" }
  | { type: "from_matches"; value: string; caseInsensitive?: boolean };

/**
 * Inbound-SMS trigger. Conditions are evaluated against a CORRELATION WINDOW:
 * the inbound message plus the recent prior messages from the same sender
 * within `correlationWindowMinutes`, so a lead that arrives as "text" then
 * "link" in two separate SMS still matches.
 */
export type SmsTrigger = {
  channel: "sms";
  /** Look back this many minutes of the sender's messages. Default 10. */
  correlationWindowMinutes?: number;
  /** AND-ed conditions; empty means "match every inbound SMS". */
  conditions: TriggerCondition[];
};

export type ExtractField = {
  name: string;
  description?: string;
};

/**
 * Optional credentialed-browse config for a `browse_extract` step. When set, the
 * worker routes the fetch through the headless render service, which logs in with
 * the named custom integration's stored credentials before reading the page. This
 * is what lets a flow read a login-gated lead page (e.g. a ReferralExchange match
 * behind the agent's account). Requires the per-tenant render service
 * (AIFLOW_RENDER_URL_TEMPLATE) — a static fetch cannot perform a login. The
 * render service only READS the page; it never clicks accept/confirm-style actions.
 */
export type BrowseAuth = {
  /** Custom-integration label whose stored credentials are used to log in. */
  integrationLabel: string;
  /** Optional CSS selector overrides; defaults suit a standard email/password form. */
  login?: {
    usernameSelector?: string;
    passwordSelector?: string;
    submitSelector?: string;
  };
};

/**
 * Optional per-step guard. When present, the step only runs if the condition
 * holds against the current run vars (a var produced by an EARLIER step);
 * otherwise the worker SKIPS the step (records "skipped") and continues. Two
 * gated steps give simple branching (e.g. a buyer vs. seller `send_sms`) without
 * nested control flow. Exactly one of `equals`/`contains` is set; matching is
 * case-insensitive unless `caseInsensitive` is false.
 */
export type StepCondition = {
  /** Name of a var produced by an earlier step (e.g. "lead_type"). */
  var: string;
  /** Whole-value (case-insensitive) equality. */
  equals?: string;
  /** Substring match. */
  contains?: string;
  /** Default true. Set false for case-sensitive matching. */
  caseInsensitive?: boolean;
};

export type FlowStep =
  | { id: string; type: "extract_url"; saveAs: string; when?: StepCondition }
  | {
      id: string;
      type: "browse_extract";
      urlVar: string;
      fields: ExtractField[];
      auth?: BrowseAuth;
      /**
       * When true, the render service also captures a screenshot of the page.
       * The worker uploads it to private storage; later steps attach it via
       * `route_to_team.attachScreenshot` (MMS) or `send_email.attachScreenshot`.
       * Requires the render service — a static fetch cannot screenshot.
       */
      screenshot?: boolean;
      when?: StepCondition;
    }
  | { id: string; type: "send_sms"; to: string; body: string; when?: StepCondition }
  | {
      id: string;
      type: "send_email";
      /** Recipient address (templatable, e.g. a fixed owner address). */
      to: string;
      /** Subject template, e.g. "{{vars.lead_name}} BS RX". */
      subject: string;
      /** Plain-text body template. */
      body: string;
      /**
       * Attach the screenshot captured by an earlier `browse_extract` with
       * `screenshot: true`. Silently sends without an attachment when no
       * screenshot was captured.
       */
      attachScreenshot?: boolean;
      when?: StepCondition;
    }
  | { id: string; type: "approval_gate"; prompt: string; when?: StepCondition }
  | { id: string; type: "notify_owner"; message: string; when?: StepCondition }
  | {
      id: string;
      type: "route_to_team";
      /**
       * SMS sent to the chosen team agent. Templated against run vars plus the
       * resolved agent (`{{agent.name}}`). Should tell them to reply 1 to claim
       * or 2 to reject within `responseMinutes`, or it goes to the next agent.
       */
      offerTemplate: string;
      /** Minutes an agent has to claim before the offer escalates. Default 10. */
      responseMinutes?: number;
      /** SMS sent to the owner when every agent has rejected / timed out. */
      ownerFallbackTemplate: string;
      /** Optional SMS sent to the owner once an agent claims the lead. */
      claimedNotifyTemplate?: string;
      /**
       * Attach the screenshot captured by an earlier `browse_extract` with
       * `screenshot: true` to each agent offer as MMS media. Silently offers
       * without media when no screenshot was captured.
       */
      attachScreenshot?: boolean;
      when?: StepCondition;
    }
  | {
      id: string;
      type: "http_call";
      label: string;
      method?: string;
      path?: string;
      bodyTemplate?: string;
      saveAs?: string;
      when?: StepCondition;
    };

export type FlowStepType = FlowStep["type"];

export type AiFlowOptions = {
  /**
   * When true, an inbound SMS that fires this flow does NOT also get the normal
   * Coworker AI reply (e.g. a ReferralExchange lead-source number we only want
   * to act on, not chat back to).
   */
  suppressDefaultReply?: boolean;
};

export type AiFlowDefinition = {
  version: typeof AI_FLOW_DEFINITION_VERSION;
  trigger: SmsTrigger;
  steps: FlowStep[];
  options?: AiFlowOptions;
};

/** A message in the correlation window the trigger evaluates over. */
export type CorrelationMessage = {
  text: string;
  from: string;
  /** Epoch milliseconds the message was received. */
  atMs: number;
};

export type TriggerContext = {
  /** Most-recent-last messages from the same sender (incl. the current one). */
  messages: CorrelationMessage[];
  /** Evaluation time (epoch ms). Defaults to Date.now() in the evaluator. */
  nowMs?: number;
};

export type TriggerResult = {
  matched: boolean;
  /** Combined text of the in-window messages (newest last), for step use. */
  windowText: string;
  /** First URL seen in the window, if any. */
  url: string | null;
};
