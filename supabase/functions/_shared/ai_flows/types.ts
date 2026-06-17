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

/**
 * Manual-only trigger: the flow never starts on its own — the owner starts it
 * from the dashboard "Run now" button (optionally with input text that
 * populates {{trigger.windowText}} / {{trigger.url}}). Any flow, regardless
 * of channel, can ALSO be run manually; this channel just opts out of every
 * automatic start.
 */
export type ManualTrigger = {
  channel: "manual";
};

/**
 * Clock trigger: the worker's cron tick enqueues a run when the schedule is
 * due. Exactly one mode:
 *   - daily: `time` ("HH:MM") in `timezone`, optionally limited to
 *     `daysOfWeek` (0=Sunday..6=Saturday);
 *   - interval: `everyMinutes` (>= 15).
 * Exactly-once per occurrence via ai_flow_runs.dedupe_key, so a tick that
 * fires late or twice never double-enqueues.
 */
export type ScheduleTrigger = {
  channel: "schedule";
  /** IANA zone for `time` (required in daily mode). */
  timezone?: string;
  /** Daily wall-clock time, 24h "HH:MM". */
  time?: string;
  /** Days `time` applies (0=Sun..6=Sat). Default: every day. */
  daysOfWeek?: number[];
  /** Interval mode: run every N minutes (>= 15). */
  everyMinutes?: number;
};

/**
 * Inbound-email trigger: the app polls the owner's connected mailbox
 * (workspace_oauth_connections.id via Nango Gmail/Outlook) for recent
 * messages and evaluates the same condition set over subject + body text
 * (`from_matches` tests the sender address). Trigger scope: windowText =
 * subject + body, url = first link in it, from = sender address.
 */
export type EmailTrigger = {
  channel: "email";
  /** Mailbox to watch (workspace_oauth_connections.id). */
  connectionId: string;
  /** AND-ed conditions; empty means "match every inbound email". */
  conditions: TriggerCondition[];
};

/**
 * Inbound trigger on the AI coworker's OWN dedicated mailbox
 * (`<tenant>@<platform domain>`). Push-based (Cloudflare Email Routing ->
 * /api/email/inbound enqueues the run) so there is NO connectionId — the
 * mailbox is implicit per business. Same condition semantics as EmailTrigger.
 */
export type TenantEmailTrigger = {
  channel: "tenant_email";
  /** AND-ed conditions; empty means "match every inbound email". */
  conditions: TriggerCondition[];
};

export type FlowTrigger =
  | SmsTrigger
  | ManualTrigger
  | ScheduleTrigger
  | EmailTrigger
  | TenantEmailTrigger;

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

/**
 * Quiet hours for a `send_sms` step that texts the LEAD. Inside the
 * [noSendAfter, resumeAt) local window the worker never sends the SMS: the
 * whole run defers until `resumeAt` via ai_flow_runs.earliest_claim_at (and
 * then texts). When `emailFallbackVar` names a var holding a lead email, the
 * same body is additionally emailed right away — the lead hears back
 * overnight AND still gets the morning text.
 */
export type SendSmsQuietHours = {
  /** IANA zone, e.g. "America/Phoenix". */
  timezone: string;
  /** Last sendable local time, 24h "HH:MM" (e.g. "22:00"). */
  noSendAfter: string;
  /** Local time texting resumes, 24h "HH:MM" (e.g. "08:30"). */
  resumeAt: string;
  /** Var holding the lead's email; when non-empty the worker emails immediately while the text waits for morning. */
  emailFallbackVar?: string;
  /** Subject template for the fallback email. Default "Following up on your inquiry". */
  emailSubject?: string;
  /** Send the fallback email from this connected owner mailbox (workspace_oauth_connections.id). */
  emailFromConnectionId?: string;
};

/**
 * Quiet hours for a `route_to_team` step's agent offers. The offer SMS still
 * goes out immediately, but inside the [quietStart, quietEnd) local window the
 * claim deadline becomes quietEnd + graceMinutes (countdown starts in the
 * morning) instead of now + responseMinutes. Offer templates may render the
 * resolved deadline via `{{offer.deadline}}`.
 */
export type RouteOfferWindow = {
  timezone: string;
  /** Window start, 24h "HH:MM" (e.g. "21:00"). */
  quietStart: string;
  /** Window end / morning resume, 24h "HH:MM" (e.g. "08:30"). */
  quietEnd: string;
  /** Countdown minutes granted after quietEnd. Default 10. */
  graceMinutes?: number;
};

/**
 * One UI action a `browse_action` step performs on the (optionally logged-in)
 * page, in order. `valueTemplate` is rendered against run vars before the
 * action runs (only meaningful for fill kinds).
 */
export type BrowseActionItem = {
  kind:
    | "click_text"
    | "click_selector"
    | "fill_selector"
    | "fill_placeholder"
    | "click_text_while_present"
    // Click by ARIA role + accessible name: `target` is the role (e.g. "option",
    // "button"), `valueTemplate` renders the name (e.g. a calendar day cell's
    // "Choose Thursday, June 18th, 2026"). For widgets that aren't plain buttons.
    | "click_role"
    // Choose an <option> in a native <select>: `target` is the select's CSS
    // selector, `valueTemplate` renders the option value/label (e.g. "No").
    | "select_option";
  /** Visible text / placeholder, a CSS selector (_selector / select_option), or an ARIA role (click_role). */
  target: string;
  /** Fill/select/role-name value template, e.g. "AI assistant: {{vars.actions_taken}}". */
  valueTemplate?: string;
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
  | {
      id: string;
      /**
       * Browser-free extraction: run the SAME Gemini structured extraction as
       * browse_extract, but over the inbound message text
       * ({{trigger.windowText}}) instead of a fetched page. Produces
       * {{vars.<field>}} for each field. No URL/auth/screenshot — use when the
       * triggering message already contains the lead details.
       */
      type: "extract_text";
      fields: ExtractField[];
      when?: StepCondition;
    }
  | {
      id: string;
      type: "send_sms";
      /** Recipient (templatable). Optional when `replyToGroup` supplies recipients. */
      to?: string;
      body: string;
      /** Lead-contact quiet hours; see SendSmsQuietHours. */
      quietHours?: SendSmsQuietHours;
      /**
       * Reply into the inbound group MMS thread: the worker sends ONE group MMS
       * to every trigger participant except our own business number, ignoring
       * `to`. SMS-triggered flows only.
       */
      replyToGroup?: boolean;
      when?: StepCondition;
    }
  | {
      id: string;
      type: "send_email";
      /** Recipient address (templatable, e.g. a fixed owner address). */
      to: string;
      /** Optional cc recipients (templatable; empty entries dropped at render). */
      cc?: string[];
      /** Optional bcc recipients (templatable; empty entries dropped at render). */
      bcc?: string[];
      /** Subject template, e.g. "{{vars.lead_name}} BS RE". */
      subject: string;
      /** Plain-text body template. */
      body: string;
      /**
       * Attach the screenshot captured by an earlier `browse_extract` with
       * `screenshot: true`. Silently sends without an attachment when no
       * screenshot was captured. Platform (Resend) sends only — not combinable
       * with `fromConnectionId` (the owner-mailbox path is plain text).
       */
      attachScreenshot?: boolean;
      /**
       * Send from the owner's connected mailbox (workspace_oauth_connections.id,
       * via Nango Gmail/Outlook) instead of the platform Resend sender. The
       * worker calls back into the app's /api/aiflows/send-owner-email, which
       * verifies the connection belongs to this business.
       */
      fromConnectionId?: string;
      when?: StepCondition;
    }
  | { id: string; type: "approval_gate"; prompt: string; when?: StepCondition }
  | { id: string; type: "notify_owner"; message: string; when?: StepCondition }
  | {
      id: string;
      type: "route_to_team";
      /**
       * SMS sent to the chosen team agent. Templated against run vars plus the
       * resolved agent (`{{agent.name}}`) and `{{offer.deadline}}`. Should tell
       * them to reply 1 to claim or 2 to reject within `responseMinutes`, or it
       * goes to the next agent.
       */
      offerTemplate: string;
      /** Minutes an agent has to claim before the offer escalates. Default 10. */
      responseMinutes?: number;
      /** SMS sent to the owner when every agent has rejected / timed out. */
      ownerFallbackTemplate: string;
      /** Optional SMS sent to the owner once an agent claims the lead. */
      claimedNotifyTemplate?: string;
      /**
       * Pin the offer to the single roster member with this name (e.g. all
       * seller leads go straight to one agent). Falls back to the owner when
       * that member is missing/opted out — never silently to someone else.
       */
      agentName?: string;
      /** After-hours claim-deadline extension; see RouteOfferWindow. */
      offerWindow?: RouteOfferWindow;
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
      type: "browse_action";
      /** Var holding the page URL (usually the same lead URL a browse used). */
      urlVar: string;
      /** Credentialed session config (required for login-gated pages). */
      auth?: BrowseAuth;
      /** UI actions performed in order; the FIRST failure fails the step. */
      actions: BrowseActionItem[];
      /**
       * Optional structured fields to extract from the page text AFTER the
       * actions run (same Gemini extraction as browse_extract), so one
       * credentialed pass can accept a lead AND capture its details. Produces
       * {{vars.<field>}} for each field. Omit to only perform the actions.
       */
      fields?: ExtractField[];
      /** Capture a screenshot AFTER the actions complete (audit trail). */
      screenshot?: boolean;
      /**
       * Persist this step's final URL keyed by the (normalized) phone value held
       * in this var, so a LATER flow run triggered by the same person can recall
       * the same page via a `recall_url` step. Skipped when the var is empty or
       * not a phone number.
       */
      rememberUrlKeyedByVar?: string;
      when?: StepCondition;
    }
  | {
      id: string;
      /**
       * Recall a URL a PRIOR flow run persisted (via browse_action
       * `rememberUrlKeyedByVar`) for the same person, into {{vars.<saveAs>}}.
       * Keys are gathered from the inbound group thread participants
       * (`keyFromTrigger: "participants"`) and/or vars naming phone numbers
       * (`keyVars`). Saves "" when nothing matches — guard the consuming step
       * with a `when` so it skips on a miss.
       */
      type: "recall_url";
      keyFromTrigger?: "participants";
      keyVars?: string[];
      saveAs: string;
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
  trigger: FlowTrigger;
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
