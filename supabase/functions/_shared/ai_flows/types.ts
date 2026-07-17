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
  // Exactly one of value / ref (validated at author time). With `ref`, the
  // sender matches when it contains ANY of the referenced person's LIVE
  // identity values (phone + aliases + email — resolved by the trigger hook
  // via resolveFromMatchesRefValues just before evaluation).
  | { type: "from_matches"; value?: string; ref?: ContactRef; caseInsensitive?: boolean };

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

/**
 * Inbound-webhook trigger: an authenticated POST to the public API
 * (`/api/public/v1/flow-events`, bearer = the tenant's `nck_` key) enqueues a
 * run for every enabled webhook flow whose conditions match. Push-based like
 * TenantEmailTrigger — the endpoint flattens the event payload into
 * windowText, so extract_text and templating work unchanged. This is how
 * external lead sources (e.g. Meta Lead Ads via a Zapier/Make bridge) start a
 * flow without a phone/email/browser trigger.
 */
export type WebhookTrigger = {
  channel: "webhook";
  /** AND-ed conditions; empty means "match every event". */
  conditions: TriggerCondition[];
};

/**
 * Calendar-event trigger: the app polls the business's connected calendar
 * (resolved Google-first like the calendar tools, so no connectionId here)
 * via /api/internal/aiflow-calendar-poll, kicked each worker tick. Fires when
 * an event is created (`on: "event_created"`) or `leadMinutes` before an
 * event's start (`on: "event_start"`). `calendar` scopes which calendar(s)
 * are watched: the account's primary, the shared NewCoworker calendar, or
 * both (default). Trigger scope: windowText = title + description + location
 * + attendees, from = organizer email. Exactly-once per event (or per
 * occurrence in event_start mode) via ai_flow_runs.dedupe_key.
 */
export type CalendarTrigger = {
  channel: "calendar";
  /** Which calendar(s) to watch. Default "both". */
  calendar?: "primary" | "shared" | "both";
  /** event_canceled fires when a watched event is cancelled/deleted. */
  on: "event_created" | "event_start" | "event_end" | "event_canceled";
  /** event_start only: run this many minutes before the event starts. */
  leadMinutes?: number;
  /**
   * event_end only: run this many minutes AFTER the event's actual end time
   * (0 / omitted = right when it ends). Anchored to the event's real end, so
   * follow-ups track the appointment's true length.
   */
  followMinutes?: number;
  /** AND-ed conditions; empty means "match every event". */
  conditions: TriggerCondition[];
};

/**
 * Inbound-voice trigger: a call FROM `fromE164` to a business voice number fires
 * this flow. Unlike every other channel it does NOT enqueue an ai_flow_run — the
 * Telnyx voice webhook resolves the matching enabled voice flow in real time and
 * drives the call-control state machine from its compiled steps. The async
 * worker never claims a voice flow (the cron/sms/email enqueue paths skip them).
 */
export type VoiceTrigger = {
  channel: "voice";
  /**
   * E.164 caller id that fires inbound routing (e.g. a partner's transfer line).
   * Inbound flows need exactly one of fromE164 / fromRef; omitted for outbound
   * (direction === "outbound").
   */
  fromE164?: string;
  /**
   * Dynamic caller match: the flow fires when the caller's number is one of the
   * referenced person's LIVE numbers (employee phone, or contact number +
   * merge aliases) — resolved by the voice webhook at call time.
   */
  fromRef?: ContactRef;
  /**
   * "outbound" marks an owner-placed call flow (a single outbound_call step) run
   * by the origination edge function. Omitted ⇒ inbound.
   */
  direction?: "outbound";
  /**
   * Optional auto-dial schedule (OUTBOUND only) — same daily/interval shape as
   * ScheduleTrigger. When set, the ai-flow-worker sweep places the call on each
   * due occurrence (exactly-once via voice_outbound_dial_log). Omitted ⇒ manual.
   */
  timezone?: string;
  time?: string;
  daysOfWeek?: number[];
  everyMinutes?: number;
};

/**
 * Contact-event trigger: a NEW contact landed on the Contacts page (created
 * from the dashboard, a CSV/lead import, or a flow's upsert_customer step).
 * Push-based: the write sites call enqueueContactEventRuns (see
 * _shared/ai_flows/contact_events.ts). Conditions evaluate over a "key:
 * value" text of the contact's fields; `from` is the contact's phone.
 */
export type ContactCreatedTrigger = {
  channel: "contact_created";
  conditions: TriggerCondition[];
};

/**
 * Contact-event trigger: a tag was added to / removed from a contact —
 * dashboard edits and update_contact flow steps both fire it. `tag` narrows
 * to one tag (case-insensitive); omitted matches any tag. `change` defaults
 * to "added". Loop-guarded: the flow whose own update_contact step wrote the
 * tag never retriggers itself.
 */
export type TagChangedTrigger = {
  channel: "tag_changed";
  tag?: string;
  change?: "added" | "removed";
  conditions: TriggerCondition[];
};

/**
 * Contact-event trigger: a roster member became the contact's owner (a
 * route_to_team claim auto-assigned it, or a manual assignment from the
 * contact page).
 */
export type OwnerAssignedTrigger = {
  channel: "owner_assigned";
  conditions: TriggerCondition[];
};

/**
 * Birthday trigger: fires once per year per contact whose stored birthday
 * (contacts.birthday) is today in `timezone` (default: the business
 * timezone), at/after local `time` (default 09:00). Swept by the worker's
 * cron tick; exactly-once via dedupe key `bday:<contactId>:<year>`.
 */
export type BirthdayTrigger = {
  channel: "birthday";
  /** Local send time, 24h "HH:MM". Default "09:00". */
  time?: string;
  /** IANA zone for `time`. Default: the business timezone. */
  timezone?: string;
  conditions: TriggerCondition[];
};

export type FlowTrigger =
  | SmsTrigger
  | ManualTrigger
  | ScheduleTrigger
  | EmailTrigger
  | TenantEmailTrigger
  | WebhookTrigger
  | CalendarTrigger
  | ContactCreatedTrigger
  | TagChangedTrigger
  | OwnerAssignedTrigger
  | BirthdayTrigger
  | VoiceTrigger;

export type ExtractField = {
  name: string;
  description?: string;
};

/**
 * A browse_extract link capture: the worker finds the first `<a>` whose visible
 * text contains `matchText` and saves its resolved href as `{{vars.<name>}}`
 * (empty string if not found). Captures a button's destination URL that plain
 * text extraction drops (e.g. HomeLight's "Call me to claim referral" link).
 */
export type ExtractLink = {
  name: string;
  matchText: string;
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
 * nested control flow. Exactly one of `equals`/`contains`/`notEquals` is set;
 * matching is case-insensitive unless `caseInsensitive` is false.
 */
export type StepCondition = {
  /** Name of a var produced by an earlier step (e.g. "lead_type"). */
  var: string;
  /** Whole-value (case-insensitive) equality. */
  equals?: string;
  /** Substring match. */
  contains?: string;
  /** Whole-value (case-insensitive) inequality — the inverse of `equals`. */
  notEquals?: string;
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
 * One arm of a `branch` step: a labeled condition plus the steps that run when
 * it is the FIRST arm whose condition matches. Arms are evaluated top to
 * bottom; no match → the branch's `else` steps run.
 */
export type BranchArm = {
  /** Stable id (unique within the branch step) recorded as the chosen arm. */
  id: string;
  /** Display label, e.g. "Auto" / "Home" / "They replied". */
  label: string;
  /** Same shape as a per-step `when` guard, evaluated against run vars. */
  condition: StepCondition;
  steps: FlowStep[];
};

/**
 * Flow-level time window: communication steps (send_sms / send_email /
 * notify_owner / route_to_team) may only execute while the local time in
 * `timezone` is inside [start, end) on an allowed day; outside it the run
 * defers via earliest_claim_at until the next open slot (identical mechanics
 * to send_sms quiet hours, which still apply on top per step).
 */
export type FlowTimeWindow = {
  /** IANA zone the window is defined in. */
  timezone: string;
  /** Window opens, 24h "HH:MM" (e.g. "09:00"). */
  start: string;
  /** Window closes, 24h "HH:MM" (e.g. "17:00"). */
  end: string;
  /** Days the window is open (0=Sun..6=Sat). Default: every day. */
  daysOfWeek?: number[];
};

/**
 * A dynamic reference to a saved person whose phone number is resolved LIVE at
 * run time, instead of a hardcoded number. `source` selects the table:
 *   - "employee": ai_flow_team_members (roster) → {name, phone_e164}
 *   - "contact":  contacts (unified directory)  → {display_name, customer_e164}
 * `id` is that row's primary key. `label` is an editor-only display hint (the
 * name captured when the ref was picked); the worker always re-reads the live
 * row, so a rename / renumber / contact-merge after authoring is reflected
 * automatically (a stale hardcoded number would not be).
 */
export type ContactRef = {
  source: "employee" | "contact";
  id: string;
  label?: string;
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

/**
 * The external milestones a `goal` step can watch for (GHL-style Goal Events):
 *   - replied:             the lead texted back (any inbound SMS from them);
 *   - appointment_booked:  a calendar booking landed for the lead;
 *   - tag_added:           the named tag was added to the lead's contact;
 *   - claimed:             a teammate claimed the lead via route_to_team.
 */
export type GoalEventKind = "replied" | "appointment_booked" | "tag_added" | "claimed";

/** One watched milestone on a `goal` step. `tag` is set for tag_added only. */
export type GoalEvent = {
  kind: GoalEventKind;
  tag?: string;
};

/**
 * Live-transfer config on a `place_ai_call` step: when the callee confirms
 * it's a good time to talk, the AI texts the transfer target the pre-alert
 * (rendered `preSmsTemplate`) and warm-transfers the live call to them.
 * Exactly one of toE164 / toRef (validated at author time).
 */
export type PlaceCallTransfer = {
  toE164?: string;
  /** Dynamic transfer target (usually an employee) resolved at run time. */
  toRef?: ContactRef;
  /**
   * Pre-alert SMS template texted to the transfer target the moment the AI
   * initiates the transfer ("LIVE TRANSFER incoming — pick up!"). Rendered
   * against run vars when the call is placed.
   */
  preSmsTemplate?: string;
};

export type FlowStep =
  | { id: string; type: "extract_url"; saveAs: string; when?: StepCondition }
  | {
      id: string;
      type: "browse_extract";
      urlVar: string;
      /** Structured text fields (Gemini extraction). Optional when only capturing links. */
      fields?: ExtractField[];
      /**
       * Capture link hrefs by their visible button text (parsed from the page
       * HTML). At least one of `fields`/`extractLinks` is present.
       */
      extractLinks?: ExtractLink[];
      auth?: BrowseAuth;
      /**
       * When true, the render service also captures a screenshot of the page.
       * The worker uploads it to private storage; later steps attach it via
       * `route_to_team.attachScreenshot` (MMS) or `send_email.attachScreenshot`.
       * Requires the render service — a static fetch cannot screenshot.
       */
      screenshot?: boolean;
      /**
       * Terminal-state guard (mirrors browse_action.skipWhenText): when the
       * fetched page contains this marker text (case-insensitive substring of
       * the page text/source), there is nothing to read — e.g. a lead another
       * agent already claimed shows an "already been claimed" banner instead of
       * the contact card. The run then ENDS gracefully — the step is recorded
       * "skipped" and the run finishes as done — instead of extracting empty
       * fields and failing a downstream step.
       */
      skipWhenText?: string;
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
      /**
       * Read a recent message from a connected mailbox (workspace_oauth_connections.id
       * via Nango Gmail/Outlook — the same connections the email trigger uses) and
       * run the SAME Gemini extraction as extract_text over it. The worker calls
       * back into the app (/api/internal/aiflow-email-fetch, which holds the Nango
       * client) to find the most recent inbox message whose sender contains
       * `fromContains` AND whose text contains EVERY rendered `matchTemplates`
       * term, within `lookbackMinutes`. Used to backfill lead details from an alert
       * email when a portal/browse extraction was delayed or empty. Produces
       * {{vars.<field>}}.
       */
      type: "email_extract";
      /** Mailbox to read (workspace_oauth_connections.id). */
      connectionId: string;
      /** Only consider mail whose sender address contains this (case-insensitive). */
      fromContains?: string;
      /**
       * Templates the message text must ALL contain to be THIS lead's email (e.g.
       * ["{{vars.lead_first_name}}", "{{vars.city}}"]). All required → tighter
       * disambiguation when leads share a first name.
       */
      matchTemplates?: string[];
      /** How far back to look. Default 60. */
      lookbackMinutes?: number;
      fields: ExtractField[];
      /** When true, a field is written only if its var is currently empty/"none" (backfill, never clobber). */
      fillOnlyEmpty?: boolean;
      when?: StepCondition;
    }
  | {
      /**
       * Read typed fields out of a DOCUMENT — the triggering email's PDF/text
       * attachment ({{trigger.document}}, the plan-time default) — via the
       * platform's Gemini document pipeline (the worker proxies to
       * /api/internal/aiflow-doc-extract). Produces {{vars.<field>}}; a
       * trigger carrying no document SKIPS the step. `fileAs` additionally
       * files the source into Business Documents (knowledge + share_document
       * ready).
       */
      id: string;
      type: "doc_extract";
      /** Template resolving to a document ref. Omitted = {{trigger.document}}. */
      sourceTemplate?: string;
      fields: ExtractField[];
      fileAs?: { titleTemplate: string; audience?: "clients" | "staff" | "both" };
      when?: StepCondition;
    }
  | {
      id: string;
      type: "send_sms";
      /** Recipient (templatable). Optional when `replyToGroup`/`toAgentName` supplies recipients. */
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
      /**
       * Send to a single named roster member; the worker resolves their phone at
       * run time and exposes {{agent.*}} to the body. Mutually exclusive with
       * `to`/`replyToGroup`.
       */
      toAgentName?: string;
      /**
       * Dynamic recipient: resolve a saved employee/contact's CURRENT phone at
       * run time (see ContactRef). Mutually exclusive with to/toAgentName/
       * replyToGroup. An employee ref is treated like `toAgentName` (internal
       * teammate text: {{agent.*}} in scope, no quiet-hours deferral, not filed
       * as a lead); a contact ref is a normal 1:1 lead recipient.
       */
      toRef?: ContactRef;
      /**
       * Attach the image URL held in this var (an earlier generate_image
       * step's saveAs) so the text goes out as MMS. An empty/unset var at run
       * time degrades to a plain text send.
       */
      mediaUrlVar?: string;
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
  | {
      id: string;
      /**
       * Share a business document with the lead: mint an expiring tokenized
       * link (business_document_shares) for `documentId` and deliver it via
       * SMS or email. The worker re-checks at execution that the document is
       * ready, client-audience, and NOT expired — the AiFlow-side half of
       * the document-expiration guarantee (an expired doc fails the step
       * loudly, never silently sends a stale link).
       */
      type: "share_document";
      /** business_documents row id. */
      documentId: string;
      /** Editor display hint captured when the document was picked. */
      documentTitle?: string;
      /** Recipient template: phone for via "sms", email for via "email". */
      to: string;
      /** Delivery channel; defaults to "sms". */
      via?: "sms" | "email";
      /**
       * Message sent with the link; the literal `{{share_url}}` token marks
       * where the minted link goes (substituted by the worker AFTER var
       * rendering). Without the token the link is appended.
       */
      messageTemplate?: string;
      /** Save the minted link into {{vars.<saveAs>}} for later steps. */
      saveAs?: string;
      when?: StepCondition;
    }
  | {
      id: string;
      /**
       * Run a saved Agent (business_agents — a reusable AI instruction set
       * the owner authored on /dashboard/agents) against flow content:
       * either the rendered `input` template (text) or a DOCUMENT
       * (`documentTemplate` — an email-attachments:<path> / business-docs:
       * <id> ref, usually {{trigger.document}}) is transformed per the
       * agent's instructions on central Gemini (via the platform's
       * gateway-guarded run-agent endpoint) and the artifact lands in
       * {{vars.<saveAs>}}. Exactly one of input/documentTemplate.
       * `saveDocument` files the artifact into Business Documents
       * (staff-only). The endpoint re-checks the agent exists + is enabled
       * at execution.
       */
      type: "run_agent";
      /** business_agents row id. */
      agentId: string;
      /** Editor display hint captured when the agent was picked. */
      agentName?: string;
      /** Template rendered into the agent's input (text mode). */
      input?: string;
      /** Template resolving to a document ref (document mode). */
      documentTemplate?: string;
      /** File the artifact into Business Documents (title template). */
      saveDocument?: { titleTemplate: string };
      /** The artifact lands in {{vars.<saveAs>}}. */
      saveAs: string;
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
      /**
       * Pin the offer to a saved roster member by reference (resolved to their
       * CURRENT name at run time, then routed exactly like `agentName`). Employee
       * source only (a contact is not on the roster). Mutually exclusive with
       * agentName. An unresolved ref falls through to the owner fallback, never
       * silently to a different teammate.
       */
      agentRef?: ContactRef;
      /** After-hours claim-deadline extension; see RouteOfferWindow. */
      offerWindow?: RouteOfferWindow;
      /**
       * Attach the screenshot captured by an earlier `browse_extract` with
       * `screenshot: true` to each agent offer as MMS media. Silently offers
       * without media when no screenshot was captured.
       */
      attachScreenshot?: boolean;
      /**
       * First to claim (ON when undefined; false opts out): while the offer is
       * live with one teammate, any teammate offered EARLIER can take it with
       * a bare "1". "1, <eta>" never preempts an active countdown.
       */
      firstToClaim?: boolean;
      /**
       * Keep-for-owner rule: when this condition matches on FIRST entry (e.g.
       * `{ var: "price_band", equals: "over_1m" }` for $1M+ leads), the step
       * offers NOBODY — it texts the owner `ownerDirectTemplate` instead and
       * sets claimed_agent="none" so claim-gated later steps skip. Evaluated
       * only before any offer goes out; a resumed run (claim/pass/timeout)
       * never re-branches.
       */
      ownerDirectWhen?: StepCondition;
      /** Owner SMS for the keep-for-owner branch. Required with ownerDirectWhen. */
      ownerDirectTemplate?: string;
      /**
       * Owner-first routing for repeat leads: when the lead's contact row
       * (matched by the inbound phone) already has an owning employee
       * (contacts.owner_employee_id, assigned by an earlier claim or manually),
       * offer that member FIRST; the normal cascade follows if they pass or
       * time out. Brand-new/unowned leads flow through claiming unchanged.
       */
      preferContactOwner?: boolean;
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
      /**
       * Loop-over-list: a CSS selector for link rows on the urlVar page. The
       * render service collects each match's href and runs `actions` on every
       * one in turn (e.g. apply a status update to every "Needs Action" lead).
       * Incompatible with fields/screenshot/rememberUrlKeyedByVar (per-item, not
       * one page).
       */
      forEachLink?: string;
      /**
       * Restrict a `forEachLink` loop to rows whose visible text contains one of
       * the names in this var (produced by an earlier step, e.g. an extract_text
       * list of lead names). Only meaningful with `forEachLink`; the var's value
       * is split on commas/newlines/semicolons into a match list, and a row is
       * acted on only when its text contains one of those names (case-insensitive).
       */
      forEachLinkMatchVar?: string;
      /**
       * Terminal-state guard: when a UI action fails AND the loaded page contains
       * this marker text (case-insensitive substring of the page source), the
       * automation's goal is already met (e.g. a lead another agent already
       * claimed, so there's no "Accept" button). The run then ENDS gracefully —
       * the step is recorded "skipped" and the run finishes as done — instead of
       * dead-lettering as a failure. Use for pages whose action can be a legitimate
       * no-op (e.g. Clever's "this referral opportunity has already been claimed").
       */
      skipWhenText?: string;
      when?: StepCondition;
    }
  | {
      id: string;
      /**
       * Create or enrich a customer profile keyed by an extracted phone var, so a
       * flow that LEARNS a lead's details (e.g. a credentialed browse_extract of
       * an accepted lead page) can file/fill the contact even when it never texts
       * them. `phoneVar` holds the lead's phone (E.164 or a North-American
       * number); `nameVar`/`emailVar` name vars an EARLIER step produced. Fill
       * behavior mirrors the SMS lead profile: the display name is set via the
       * alias-aware RPC, the email is filled only when empty, and a known
       * business contact (saved as an "other contact") is never recorded.
       */
      type: "upsert_customer";
      phoneVar: string;
      nameVar?: string;
      emailVar?: string;
      when?: StepCondition;
    }
  | {
      id: string;
      /**
       * Decisive conversation routing: classify a message into EXACTLY ONE of
       * the author's categories so a `branch` step can fork on meaning instead
       * of brittle substring matches. Reads the text in `textVar` (typically a
       * wait_for_reply's saveAs) or, when omitted, the triggering message
       * ({{trigger.windowText}}). The chosen category VALUE lands in
       * {{vars.<saveAs>}}; when the text is empty or nothing fits, the
       * reserved fallback "unclear" lands instead — so branches always have a
       * decidable value. Classification runs on the same spend-gated Gemini
       * extraction path as extract_text.
       */
      type: "classify";
      /** Var holding the text to classify; omitted = the triggering message. */
      textVar?: string;
      /** Optional context for the model, e.g. "The lead was asked why they are shopping." */
      question?: string;
      /** 2–8 categories; `value` is the token branches match on. */
      categories: { value: string; description?: string }[];
      saveAs: string;
      when?: StepCondition;
    }
  | {
      id: string;
      /**
       * Update the contact's TAGS (the dashboard's lead-state labels — "New
       * Lead", "Engaged", "Appointment Scheduled", ...) from a flow, so
       * automations can maintain the contact lifecycle without manual
       * bookkeeping. `phoneVar` identifies the contact (E.164 or a loose NANP
       * number, matched alias-aware); removals apply before additions so a
       * status transition is `removeTags: ["New Lead"], addTags: ["Contacted"]`
       * in one step. An unusable phone or a missing contact row SKIPS with a
       * note (a lead-data gap is not a flow bug). Tags are normalized like the
       * dashboard write path (trim, case-insensitive de-dup, 25-tag cap).
       */
      type: "update_contact";
      phoneVar: string;
      addTags?: string[];
      removeTags?: string[];
      when?: StepCondition;
    }
  | {
      id: string;
      /**
       * Generate an AI image from the rendered prompt template and save a
       * signed URL to the stored image into {{vars.<saveAs>}} — consumable by
       * a later send_sms (mediaUrlVar → MMS) or embedded in a send_email
       * body. Runs on the spend-gated Gemini path (flat per-image price into
       * the shared AI budget; hard-refused when the budget is exhausted).
       * AiFlow runs are exempt from the conversational per-session image
       * limit — flows are owner-authored and explicitly enabled.
       */
      type: "generate_image";
      promptTemplate: string;
      /**
       * Optional source image to EDIT: a template resolving to
       * {{trigger.image}} (photo attached to the triggering MMS/email) or an
       * earlier step's image var. Empty render → generate from scratch;
       * unusable reference → the step fails. The worker only fetches
       * platform-controlled sources (own buckets + Telnyx media CDN).
       */
      inputImageTemplate?: string;
      saveAs: string;
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
    }
  | {
      id: string;
      /**
       * Multi-way branch (GHL-style If/Else): arms are evaluated top to bottom
       * against run vars and the FIRST match wins; no match → the `else` steps
       * run. Executed by recording the chosen arm id into the engine var
       * `__branch_<id>`; the flattened steps of untaken arms are then skipped
       * (recorded "skipped" with reason branch_not_taken) exactly like a
       * when_unmet skip. Nesting is capped at 3 levels at author time.
       */
      type: "branch";
      /** Display label, e.g. "What insurance type?". */
      question: string;
      /** 1-4 arms, first match wins. */
      branches: BranchArm[];
      /** "None matched" path (may be empty). */
      else: FlowStep[];
      /**
       * Optional guard on the WHOLE branch: unmet → the branch step skips, its
       * choice var is never recorded, and every arm/else step skips as
       * branch_not_taken.
       */
      when?: StepCondition;
    }
  | {
      id: string;
      /**
       * Pause the run, then continue with the NEXT step. Exactly one mode:
       *   - minutes: relative wait (1..43200 = 30 days);
       *   - untilTime ("HH:MM") + timezone: wait until the next occurrence of
       *     that local wall-clock time;
       *   - untilDateTemplate: a template rendering to an ISO date/datetime
       *     (e.g. "{{vars.renewal_date}}") — wake then (a past/unparseable
       *     render fails OPEN: the step skips with a note);
       *   - relativeToTemplate + offsetMinutes: a template rendering to an
       *     ISO datetime plus a signed offset — negative = BEFORE it (the
       *     GHL "2 hours before the appointment" wait).
       * Implemented as an earliest_claim_at deferral (same machinery as SMS
       * quiet hours): nothing is sent, no attempt is burned, and the worker
       * re-claims the run when the time arrives. A context marker
       * (`__slept_<id>`) makes the step a no-op on re-entry so it never
       * re-defers.
       */
      type: "sleep";
      minutes?: number;
      untilTime?: string;
      timezone?: string;
      untilDateTemplate?: string;
      relativeToTemplate?: string;
      offsetMinutes?: number;
      when?: StepCondition;
    }
  | {
      id: string;
      /**
       * Arithmetic on numbers and dates: compute `left <operation> right`
       * and save the result into {{vars.<saveAs>}} — usable by later `when`
       * guards and branch conditions (lead scoring, "renewal within 30
       * days"). left/right are templates rendered against the run scope.
       * Number ops parse loose numerics ("$1,200" → 1200); date ops parse
       * ISO datetimes. An unparseable operand (or divide-by-zero) saves the
       * sentinel "not_a_number" instead of failing the run — a data gap is
       * not a flow bug, and branches can test for it.
       */
      type: "math";
      operation:
        | "add"
        | "subtract"
        | "multiply"
        | "divide"
        | "round"
        // left = ISO datetime, right = minutes → ISO datetime.
        | "date_add_minutes"
        // Whole days from left (ISO) to right (ISO); negative when right is earlier.
        | "date_diff_days";
      left: string;
      /** Unused by `round`. */
      right?: string;
      saveAs: string;
      when?: StepCondition;
    }
  | {
      id: string;
      /**
       * GHL-style Goal Event checkpoint. Reached inline it is a no-op marker;
       * its power is the JUMP: when a watched external event (reply, booking,
       * tag, claim) lands for the run's lead while the run is queued/deferred
       * or parked awaiting a reply, the run fast-forwards straight to this
       * step — every step in between is recorded "skipped" (goal_jump). This
       * is "stop nurturing people who already converted": follow-up sends
       * between here and the current step never fire once the goal is hit.
       * Trunk-only (never inside a branch arm; enforced at author time) so a
       * jump can never land on an unevaluated branch path.
       */
      type: "goal";
      /** Display label, e.g. "Booked an appointment". */
      label: string;
      /** Watched milestones (any match jumps). 1-4 entries. */
      events: GoalEvent[];
      /** Inline guard only (a jump ignores it): unmet → the checkpoint skips. */
      when?: StepCondition;
    }
  | {
      id: string;
      /**
       * Park the run until the phone number held in `phoneVar` texts back (or
       * `timeoutMinutes` elapses). The inbound webhook resumes the run with
       * the reply text in {{vars.<saveAs>}} and SUPPRESSES the default AI
       * conversational reply for that message — the flow owns the turn, like
       * options.suppressDefaultReply. On timeout the sweep resumes with
       * {{vars.<saveAs>}} = "no_reply" so later steps branch with
       * `when: { var: saveAs, equals/notEquals "no_reply" }`. An unusable
       * phone in phoneVar resolves immediately to "no_reply" — a lead-data
       * gap is not a flow bug.
       */
      type: "wait_for_reply";
      phoneVar: string;
      /** Var that receives the reply text. Default "reply_text". */
      saveAs?: string;
      /** How long to wait before the no-reply branch. Default 1440 (24h), max 43200 (30 days). */
      timeoutMinutes?: number;
      /**
       * Dynamic timeout: a template rendering to whole minutes (e.g.
       * "{{vars.report_wait_minutes}}" from a math step). A positive render
       * wins; anything else (empty, "not_a_number") falls back to
       * timeoutMinutes. Clamped to 1..43200 like the static field.
       */
      timeoutMinutesTemplate?: string;
      when?: StepCondition;
    }
  | {
      id: string;
      /**
       * BATCH-flow outbound AI call (the bridge between the run engine and the
       * real-time voice path): place a call to the phone number held in
       * `toVar`, let the AI bridge run the rendered `personaTemplate` script
       * on answer, then PARK the run (status `awaiting_call`, same machinery
       * as wait_for_reply) until the call ends. The call outcome lands in
       * {{vars.<saveAs>}} for later when/branch gating:
       *   - "transferred": the AI live-transferred the callee (see `transfer`);
       *   - "answered":    the callee answered and the AI ran, no transfer;
       *   - "no_answer":   the call rang out / was never answered (also the
       *                    timeout-sweep sentinel for a lost webhook);
       *   - "not_placed":  the callee phone was missing/unusable (lead-data
       *                    gap — skip, not a failure) or origination refused
       *                    before dialing;
       *   - "failed":      origination failed after validation.
       * Budget is enforced exactly like every outbound AI call (pre-dial probe
       * + authoritative post-dial reserve in telnyx-voice-originate); a budget
       * refusal defers the run and retries later instead of burning the step.
       */
      type: "place_ai_call";
      /** Var holding the callee's phone (same scope rule as wait_for_reply.phoneVar). */
      toVar: string;
      /** Greeting/script template the AI opens the call with (var-templated). */
      personaTemplate: string;
      /**
       * What the AI already KNOWS about the person (var-templated, e.g.
       * "Name: {{vars.lead_name}}. Property: {{vars.lead_address}}."). Injected
       * into the call's system prompt with a never-re-ask rule — without it
       * the AI asks for details the flow already extracted ("why are you
       * asking my name if you already have it?", live test Jul 15 2026).
       */
      contextTemplate?: string;
      /** Post-call summary recipient: exactly one of notifyE164 / notifyRef. */
      notifyE164?: string;
      notifyRef?: ContactRef;
      /** Optional live-transfer config (pre-alert SMS + warm transfer). */
      transfer?: PlaceCallTransfer;
      /** Optional lead fields the AI captures during the call. */
      captureFields?: string[];
      /** Outcome var name. Default "call_outcome". */
      saveAs?: string;
      when?: StepCondition;
    }
  // ── Voice steps (real-time call routing; executed by the Telnyx voice webhook
  // state machine, NOT the async ai-flow-worker). Only valid under a VoiceTrigger. ──
  | {
      id: string;
      /**
       * Ring a human and warm-transfer the live caller to them for `ringSeconds`
       * (default 20). On no-answer the voice webhook advances to the next
       * ring_handoff, then the voice_ai_intake (if any). Step order = ring order.
       */
      type: "ring_handoff";
      /** Exactly one of toE164 / toRef (validated at author time). */
      toE164?: string;
      /** Dynamic dial target resolved live just before compile; see ContactRef. */
      toRef?: ContactRef;
      ringSeconds?: number;
      when?: StepCondition;
    }
  | {
      id: string;
      /**
       * AI takeover after every ring_handoff missed: a human presses 1 to hand
       * the live caller to the AI worker, which captures the lead and texts a
       * summary (+ transcript) to `notifyE164`. At most one per flow; must be the
       * last step and preceded by a ring_handoff.
       */
      type: "voice_ai_intake";
      /** Exactly one of notifyE164 / notifyRef (validated at author time). */
      notifyE164?: string;
      /** Dynamic summary recipient resolved live just before compile. */
      notifyRef?: ContactRef;
      persona?: string;
      captureFields?: string[];
      when?: StepCondition;
    }
  | {
      id: string;
      /**
       * Single blind warm transfer: connect the caller straight to `toE164`,
       * optionally speaking `whisper` first. A voice_transfer flow has exactly
       * one step (no ring_handoff/voice_ai_intake).
       */
      type: "voice_transfer";
      /** Exactly one of toE164 / toRef (validated at author time). */
      toE164?: string;
      /** Dynamic transfer target resolved live just before compile. */
      toRef?: ContactRef;
      whisper?: string;
      when?: StepCondition;
    }
  | {
      id: string;
      /**
       * Outbound origination: place a call to `toE164` (or an entry-supplied
       * number) and let the AI bridge talk to the callee on answer. Budget is
       * reserved before the AI media attaches; the captured summary + transcript
       * text to `notifyE164`. The single step of an outbound voice flow.
       */
      type: "outbound_call";
      /** Default callee: at most one of toE164 / toRef (entry may override). */
      toE164?: string;
      toRef?: ContactRef;
      /** Exactly one of notifyE164 / notifyRef (validated at author time). */
      notifyE164?: string;
      /** Dynamic summary recipient resolved live just before compile. */
      notifyRef?: ContactRef;
      persona?: string;
      captureFields?: string[];
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
  /**
   * When true, every browse step captures a screenshot — and a browse_action
   * that fails captures a before-actions + at-failure pair — stored for the
   * dashboard run "investigate" view. Default off so flows that don't need it
   * pay no extra capture latency/storage.
   */
  captureStepScreenshots?: boolean;
  /**
   * GHL "stop on response" / FUB "pause on reply": when true, an inbound SMS
   * from the lead CANCELS their pending runs of this flow (queued /
   * awaiting_reply / awaiting_call — never the human-parked states) instead
   * of letting the remaining follow-ups fire at someone who already answered.
   * The one run whose wait_for_reply consumed that exact reply is exempt —
   * it processes the reply through its authored branch logic. Applied by
   * telnyx-sms-inbound via response_stop.ts. Default off.
   */
  stopOnResponse?: boolean;
  /**
   * GHL "allow re-entry": when EXPLICITLY false, a contact who already has a
   * run of this flow (any status, test runs excluded) is not enrolled again.
   * Enforced best-effort at the lead-keyed enqueue sites (inbound SMS
   * trigger eval, contact events, the Node enqueueAiFlowRun); enqueues with
   * no lead identity (e.g. webhook payloads before extraction) are governed
   * by their own dedupe keys instead. Default (undefined/true) = re-entry
   * allowed, today's behavior.
   */
  allowReentry?: boolean;
};

/**
 * Flow-level drip pacing (GHL "Drip"): consecutive enqueues for this flow
 * are spaced `intervalMinutes` apart via earliest_claim_at, so a bulk
 * enrollment (lead-backlog import, webhook burst) trickles through the send
 * steps instead of bursting. Applied at enqueue time by the Node-side
 * enqueueAiFlowRun (the bulk paths); a single inbound SMS is never "bulk"
 * and keeps firing immediately.
 */
export type FlowDrip = {
  /** Minutes between consecutive run starts (1..1440). */
  intervalMinutes: number;
};

export type AiFlowDefinition = {
  version: typeof AI_FLOW_DEFINITION_VERSION;
  trigger: FlowTrigger;
  /**
   * Additional triggers (OR semantics): the flow starts when ANY trigger in
   * [trigger, ...triggers] fires. Capped at 4 extras (5 total). Voice flows
   * stay single-trigger (they run on the real-time call path, not the batch
   * worker) — enforced at write time by validateDefinitionSemantics.
   */
  triggers?: FlowTrigger[];
  steps: FlowStep[];
  /** Flow-level business-hours gate on communication steps. */
  timeWindow?: FlowTimeWindow;
  /** Flow-level drip pacing for bulk enqueues. */
  drip?: FlowDrip;
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
