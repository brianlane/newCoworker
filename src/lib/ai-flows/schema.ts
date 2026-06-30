/**
 * AiFlows authoring schema + semantic validation (Next.js / Node side).
 *
 * This is the WRITE-time validator for an AiFlow `definition`: the dashboard
 * builder and the `/api/aiflows` CRUD routes parse owner input through here
 * before it lands in `ai_flows.definition`. It mirrors the runtime engine types
 * in `supabase/functions/_shared/ai_flows/types.ts` (kept in sync deliberately,
 * the same dual-runtime pattern as the chat spend cap) but adds the rich,
 * surfaceable error messages a no-code builder needs.
 *
 * Two layers:
 *   1. `aiFlowDefinitionSchema` (zod) — shape + bounds.
 *   2. `validateDefinitionSemantics` — cross-step invariants zod can't express:
 *      unique step ids, and a variable-flow check so a template never references
 *      a `{{vars.x}}` / `{{trigger.x}}` that isn't in scope at that point.
 */
import { z } from "zod";

export const TRIGGER_CONDITION_TYPES = [
  "contains",
  "regex",
  "has_url",
  "from_matches"
] as const;

export const FLOW_STEP_TYPES = [
  "extract_url",
  "browse_extract",
  "extract_text",
  "email_extract",
  "send_sms",
  "send_email",
  "approval_gate",
  "notify_owner",
  "http_call",
  "route_to_team",
  "browse_action",
  "recall_url",
  "upsert_customer",
  // Voice-channel steps (real-time call routing, executed by the Telnyx voice
  // webhook state machine — NOT the async ai-flow-worker). Only valid under a
  // `voice` trigger; see VOICE_STEP_TYPES and validateVoiceFlow.
  "ring_handoff",
  "voice_ai_intake",
  "voice_transfer",
  // Outbound origination: place a call and let the AI talk to the callee on
  // answer. Runs on the real-time call path (the origination edge function),
  // never the batch worker; only valid under an outbound voice trigger.
  "outbound_call"
] as const;

/**
 * The subset of step types that run on the real-time voice path (Telnyx call
 * control) instead of the async batch worker. A `voice` trigger uses ONLY these;
 * every other trigger uses ONLY the non-voice steps. Enforced in
 * validateDefinitionSemantics so the two execution models never mix in one flow.
 */
export const VOICE_STEP_TYPES = [
  "ring_handoff",
  "voice_ai_intake",
  "voice_transfer",
  "outbound_call"
] as const;

/** Keys available as `{{agent.x}}` inside a route_to_team step's templates. */
export const AGENT_SCOPE_KEYS = ["name", "phone"] as const;

/** Keys available as `{{offer.x}}` inside a route_to_team step's templates. */
export const OFFER_SCOPE_KEYS = ["deadline"] as const;

/**
 * Vars the ENGINE itself maintains (not produced by any step). Always in scope:
 *   - `actions_taken`: the worker appends a human description of each outbound
 *     contact (SMS / email / routing), so a later step — e.g. a browse_action
 *     timeline note — can template "what did this flow actually do".
 *   - `claimed_agent`: set by `route_to_team` to the claiming teammate's name
 *     (or "none" on owner-fallback / no claim), so LATER steps can gate on
 *     `when: { var: "claimed_agent", notEquals: "none" }` to run only after a
 *     teammate accepted the lead. Empty string before any route_to_team runs.
 */
export const ENGINE_PROVIDED_VARS = ["actions_taken", "claimed_agent"] as const;

/** The UI action kinds a browse_action step may perform. */
export const BROWSE_ACTION_KINDS = [
  "click_text",
  "click_selector",
  "fill_selector",
  "fill_placeholder",
  // Repeatedly click an element matching `target`'s visible text until it is
  // no longer present (bounded). Zero matches is success, not a failure — for
  // multi-step wizards whose "Next" button count varies between leads.
  "click_text_while_present",
  // Click by ARIA role (`target`) + accessible name (`valueTemplate`), for
  // widgets that aren't plain text buttons (e.g. a calendar day cell).
  "click_role",
  // Choose an option in a native <select>: `target` is the select's CSS
  // selector, `valueTemplate` is the option value/label.
  "select_option"
] as const;

/** browse_action kinds whose `valueTemplate` is required (name / option value). */
export const BROWSE_ACTION_KINDS_REQUIRING_VALUE = ["click_role", "select_option"] as const;

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Variable identifiers (saveAs, field names, urlVar): snake/camel, bounded. */
export const VAR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

/** Trigger-scope keys the engine always populates (see evaluateSmsTrigger). */
export const TRIGGER_SCOPE_KEYS = ["url", "windowText", "from", "to", "participants"] as const;

/**
 * Top-level keys of the `{{now.*}}` scope the worker injects each run (relative
 * dates in the business timezone; see engine.buildNowScope). Nested parts like
 * `now.tomorrow.weekday` are not enumerated — the validator only checks the
 * first scope segment.
 */
export const NOW_SCOPE_KEYS = ["today", "tomorrow", "in7Days", "afternoonTime"] as const;

const varName = z
  .string()
  .regex(VAR_NAME_PATTERN, "must start with a letter and use letters/digits/underscore");

const conditionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("contains"),
    value: z.string().min(1).max(500),
    caseInsensitive: z.boolean().optional()
  }),
  z.object({
    type: z.literal("regex"),
    value: z.string().min(1).max(500),
    caseInsensitive: z.boolean().optional()
  }),
  z.object({ type: z.literal("has_url") }),
  z.object({
    type: z.literal("from_matches"),
    value: z.string().min(1).max(100),
    caseInsensitive: z.boolean().optional()
  })
]);

/** 24h wall-clock "HH:MM" (quiet-hour boundaries, schedule times). */
const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'must be a 24h time like "21:00"');

/** IANA zone name; validity is enforced at runtime (helpers fail open). */
const timezone = z.string().min(1).max(60);

/** E.164 phone (voice routing): leading "+", country digit, 6-15 more digits. */
const e164 = z
  .string()
  .regex(/^\+[1-9]\d{6,15}$/, 'must be an E.164 number like "+14155551234"');

const smsTriggerSchema = z.object({
  channel: z.literal("sms"),
  correlationWindowMinutes: z.number().int().min(0).max(1440).optional(),
  conditions: z.array(conditionSchema).max(20)
});

/** Manual-only: never starts automatically, only via the "Run now" button. */
const manualTriggerSchema = z.object({ channel: z.literal("manual") });

/**
 * Clock trigger. Exactly one mode: daily (`time` + `timezone`, optional
 * `daysOfWeek` 0=Sun..6=Sat) or interval (`everyMinutes` >= 15). The worker's
 * cron sweep enqueues each occurrence exactly once (dedupe_key).
 */
const scheduleTriggerSchema = z
  .object({
    channel: z.literal("schedule"),
    timezone: timezone.optional(),
    time: hhmm.optional(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    everyMinutes: z.number().int().min(15).max(10080).optional()
  })
  .superRefine((t, ctx) => {
    const interval = t.everyMinutes !== undefined;
    const dailyFields = t.time !== undefined || t.timezone !== undefined || t.daysOfWeek !== undefined;
    if (interval && dailyFields) {
      ctx.addIssue({
        code: "custom",
        message: "use either a daily time or everyMinutes, not both"
      });
    } else if (!interval && (t.time === undefined || t.timezone === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "daily mode needs both time and timezone (or set everyMinutes)"
      });
    }
  });

/**
 * Inbound-email trigger: poll the owner's connected mailbox (the same Nango
 * connections the send_email "From" dropdown offers) and match conditions
 * over subject + body (`from_matches` tests the sender address).
 */
const emailTriggerSchema = z.object({
  channel: z.literal("email"),
  connectionId: z.string().uuid(),
  conditions: z.array(conditionSchema).max(20)
});

/**
 * Inbound trigger on the AI coworker's OWN dedicated mailbox
 * (`<tenant>@<platform domain>`). Unlike the `email` channel this is push-based
 * (Cloudflare Email Routing -> /api/email/inbound) and needs NO `connectionId`:
 * the mailbox is implicit per business. Same condition semantics over subject +
 * body, `from_matches` tests the sender.
 */
const tenantEmailTriggerSchema = z.object({
  channel: z.literal("tenant_email"),
  conditions: z.array(conditionSchema).max(20)
});

/**
 * Inbound-voice trigger: a call FROM `fromE164` to one of the business's voice
 * numbers fires this flow. Unlike every other channel this does NOT enqueue an
 * ai_flow_run — the Telnyx voice webhook (telnyx-voice-inbound) resolves the
 * matching enabled voice flow in real time and drives the call-control state
 * machine directly from its compiled steps. The flow row exists purely so the
 * routing is authored/visible/CRUD-able in the AiFlows UI like any other flow.
 */
const voiceTriggerSchema = z
  .object({
    channel: z.literal("voice"),
    // Inbound flows: a call FROM `fromE164` fires the flow (resolved by
    // telnyx-voice-inbound). Required for inbound, omitted for outbound — enforced
    // by direction in validateVoiceFlow.
    fromE164: e164.optional(),
    // "outbound" marks an owner-placed call flow whose single `outbound_call` step
    // is run on demand by the origination edge function (not by an inbound caller
    // and not by the batch worker). Omitted ⇒ inbound, preserving existing rows.
    direction: z.literal("outbound").optional(),
    // Optional auto-dial schedule (OUTBOUND only). Same daily/interval shape as
    // the `schedule` channel: the ai-flow-worker sweep places the call on each
    // due occurrence (exactly-once via the voice_outbound_dial_log ledger).
    // Omitted ⇒ manual-only ("Place call" button).
    timezone: timezone.optional(),
    time: hhmm.optional(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    everyMinutes: z.number().int().min(15).max(10080).optional()
  })
  .superRefine((t, ctx) => {
    const interval = t.everyMinutes !== undefined;
    const dailyFields =
      t.time !== undefined || t.timezone !== undefined || t.daysOfWeek !== undefined;
    const hasSchedule = interval || dailyFields;
    if (!hasSchedule) return;
    if (t.direction !== "outbound") {
      ctx.addIssue({ code: "custom", message: "Only outbound voice flows can be scheduled." });
      return;
    }
    // Same exclusivity as scheduleTriggerSchema: exactly one mode.
    if (interval && dailyFields) {
      ctx.addIssue({ code: "custom", message: "use either a daily time or everyMinutes, not both" });
    } else if (!interval && (t.time === undefined || t.timezone === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "daily mode needs both time and timezone (or set everyMinutes)"
      });
    }
  });

const triggerSchema = z.discriminatedUnion("channel", [
  smsTriggerSchema,
  manualTriggerSchema,
  scheduleTriggerSchema,
  emailTriggerSchema,
  tenantEmailTriggerSchema,
  voiceTriggerSchema
]);

const extractFieldSchema = z.object({
  name: varName,
  description: z.string().max(300).optional()
});

/**
 * A browse_extract link capture: find the first `<a>` on the page whose visible
 * text contains `matchText` and save its resolved href as `{{vars.<name>}}`
 * (empty string if no match). Used to grab a button's destination URL — e.g.
 * HomeLight's "Call me to claim referral" link — which plain text extraction
 * loses.
 */
const extractLinkSchema = z.object({
  name: varName,
  matchText: z.string().min(1).max(200)
});

/**
 * Optional credentialed-browse config. `integrationLabel` names a stored custom
 * integration whose credentials the render service uses to log in before reading
 * the page (so a flow can read a login-gated lead). The selector overrides are
 * for non-standard login forms; sensible email/password defaults apply otherwise.
 */
const browseAuthSchema = z.object({
  integrationLabel: z.string().min(1).max(80),
  login: z
    .object({
      usernameSelector: z.string().min(1).max(300).optional(),
      passwordSelector: z.string().min(1).max(300).optional(),
      submitSelector: z.string().min(1).max(300).optional()
    })
    .optional()
});

const stepId = z.string().min(1).max(60);

/**
 * Lead-contact quiet hours on a send_sms step: never text inside
 * [noSendAfter, resumeAt) local time — the run defers to resumeAt and texts
 * then; when the flow extracted a lead email into `emailFallbackVar` the same
 * body is also emailed immediately.
 */
const sendSmsQuietHoursSchema = z.object({
  timezone,
  noSendAfter: hhmm,
  resumeAt: hhmm,
  emailFallbackVar: varName.optional(),
  emailSubject: z.string().min(1).max(300).optional(),
  emailFromConnectionId: z.string().uuid().optional()
});

/**
 * After-hours agent-offer window on a route_to_team step: offers inside
 * [quietStart, quietEnd) still send immediately but their claim deadline is
 * quietEnd + graceMinutes (the countdown starts in the morning).
 */
const routeOfferWindowSchema = z.object({
  timezone,
  quietStart: hhmm,
  quietEnd: hhmm,
  graceMinutes: z.number().int().min(0).max(720).optional()
});

const VALUE_REQUIRING_KINDS = new Set<string>(BROWSE_ACTION_KINDS_REQUIRING_VALUE);

const browseActionItemSchema = z
  .object({
    kind: z.enum(BROWSE_ACTION_KINDS),
    target: z.string().min(1).max(300),
    valueTemplate: z.string().max(2000).optional()
  })
  .refine(
    (a) => !VALUE_REQUIRING_KINDS.has(a.kind) || (a.valueTemplate ?? "").length > 0,
    { message: "this action kind needs a value (the option to choose or the name to click)" }
  );

/**
 * Optional per-step guard. The step only runs when the condition holds against a
 * var produced by an EARLIER step; otherwise the worker skips it. Exactly one of
 * `equals`/`contains`/`notEquals` must be set, so two gated steps give simple
 * branching (e.g. a buyer vs. seller `send_sms`, or `equals none` vs.
 * `notEquals none` for an exhaustive either/or). MUST be part of the schema so
 * the dashboard editor's save round-trips it instead of zod stripping it.
 */
const whenSchema = z
  .object({
    var: varName,
    equals: z.string().min(1).max(200).optional(),
    contains: z.string().min(1).max(200).optional(),
    notEquals: z.string().min(1).max(200).optional(),
    caseInsensitive: z.boolean().optional()
  })
  .refine(
    (w) => [w.equals, w.contains, w.notEquals].filter((v) => v !== undefined).length === 1,
    { message: "set exactly one of equals/contains/notEquals" }
  );

const stepSchema = z.discriminatedUnion("type", [
  z.object({ id: stepId, type: z.literal("extract_url"), saveAs: varName, when: whenSchema.optional() }),
  z
    .object({
      id: stepId,
      type: z.literal("browse_extract"),
      urlVar: varName,
      // Either pull structured text fields, capture link hrefs by button text,
      // or both — but the step must do at least one (refined below).
      fields: z.array(extractFieldSchema).min(1).max(15).optional(),
      extractLinks: z.array(extractLinkSchema).min(1).max(10).optional(),
      auth: browseAuthSchema.optional(),
      screenshot: z.boolean().optional(),
      when: whenSchema.optional()
    })
    .refine((s) => (s.fields?.length ?? 0) > 0 || (s.extractLinks?.length ?? 0) > 0, {
      message: "browse_extract needs at least one of fields or extractLinks"
    }),
  // Browser-free sibling of browse_extract: pull the same structured fields out
  // of the inbound message text ({{trigger.windowText}}) instead of a fetched
  // page. No urlVar/auth/screenshot — the worker runs the SAME Gemini
  // extraction on the trigger text. Produces {{vars.<field>}} like browse_extract.
  z.object({
    id: stepId,
    type: z.literal("extract_text"),
    fields: z.array(extractFieldSchema).min(1).max(15),
    when: whenSchema.optional()
  }),
  // Read a recent message from a connected mailbox (the same Nango Gmail/Outlook
  // connections the email trigger + send_email "From" dropdown use) and run the
  // SAME Gemini extraction over it as extract_text — for pulling lead details out
  // of an alert email mid-flow (e.g. HomeLight's "Client Details" email as a
  // fallback when the portal contact card is delayed). The worker finds the most
  // recent inbox message whose sender contains `fromContains` AND whose text
  // contains EVERY rendered `matchTemplates` term (so e.g. first name AND city
  // both must appear — this disambiguates two leads who share a first name within
  // the window), within `lookbackMinutes`. With `fillOnlyEmpty`, a field is
  // written only when its var is currently empty/"none" — so an earlier
  // browse_extract's values win and the email merely backfills the gaps. Produces
  // {{vars.<field>}} like extract_text.
  z.object({
    id: stepId,
    type: z.literal("email_extract"),
    connectionId: z.string().uuid(),
    fromContains: z.string().min(1).max(200).optional(),
    // Each entry is a template rendered then required (case-insensitive substring)
    // in the email; ALL must match. More terms = tighter lead disambiguation.
    matchTemplates: z.array(z.string().min(1).max(200)).min(1).max(5).optional(),
    lookbackMinutes: z.number().int().min(1).max(1440).optional(),
    fields: z.array(extractFieldSchema).min(1).max(15),
    fillOnlyEmpty: z.boolean().optional(),
    when: whenSchema.optional()
  }),
  z.object({
    id: stepId,
    type: z.literal("send_sms"),
    // Optional when `replyToGroup` or `toAgentName` supplies the recipient
    // instead of a templated address. Exactly one recipient source is required;
    // the "set exactly one of to / toAgentName / replyToGroup" rule is enforced
    // in validateDefinitionSemantics (a discriminatedUnion can't hold a refine).
    to: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(1600),
    quietHours: sendSmsQuietHoursSchema.optional(),
    /**
     * Reply into the inbound group MMS thread: the worker sends ONE group MMS
     * to every trigger participant except our own business number, ignoring
     * `to`. Only meaningful for SMS-triggered flows where the inbound was a
     * group message.
     */
    replyToGroup: z.boolean().optional(),
    /**
     * Send to a single named roster member (ai_flow_team_members) instead of a
     * templated address — the worker resolves their current phone at run time,
     * so the number stays correct as the roster changes. When set, the body may
     * reference {{agent.name}}/{{agent.phone}} (the resolved member).
     */
    toAgentName: z.string().min(1).max(120).optional(),
    when: whenSchema.optional()
  }),
  z.object({
    id: stepId,
    type: z.literal("send_email"),
    to: z.string().min(3).max(320),
    // cc/bcc are optional extra recipients. Bounded like `to` (not strict
    // .email()) so they can carry a {{vars.x}} template; capped so a flow
    // can't blast an unbounded recipient list. Empty entries dropped at render.
    cc: z.array(z.string().min(3).max(320)).max(10).optional(),
    bcc: z.array(z.string().min(3).max(320)).max(10).optional(),
    subject: z.string().min(1).max(300),
    body: z.string().min(1).max(8000),
    attachScreenshot: z.boolean().optional(),
    fromConnectionId: z.string().uuid().optional(),
    when: whenSchema.optional()
  }),
  z.object({
    id: stepId,
    type: z.literal("approval_gate"),
    prompt: z.string().min(1).max(500),
    when: whenSchema.optional()
  }),
  z.object({
    id: stepId,
    type: z.literal("notify_owner"),
    message: z.string().min(1).max(1000),
    when: whenSchema.optional()
  }),
  z.object({
    id: stepId,
    type: z.literal("http_call"),
    label: z.string().min(1).max(80),
    method: z.enum(HTTP_METHODS).optional(),
    path: z.string().max(500).optional(),
    bodyTemplate: z.string().max(4000).optional(),
    saveAs: varName.optional(),
    when: whenSchema.optional()
  }),
  z.object({
    id: stepId,
    type: z.literal("route_to_team"),
    offerTemplate: z.string().min(1).max(1600),
    responseMinutes: z.number().int().min(1).max(1440).optional(),
    ownerFallbackTemplate: z.string().min(1).max(1600),
    claimedNotifyTemplate: z.string().min(1).max(1600).optional(),
    agentName: z.string().min(1).max(120).optional(),
    offerWindow: routeOfferWindowSchema.optional(),
    attachScreenshot: z.boolean().optional(),
    // The reply digit that means "accept WITH a timeframe" (e.g. 2 or 3). A
    // teammate replies "<digit>, <eta>" to claim and state when they'll reach
    // out. The inbound webhook only treats the comma form as a claim when the
    // digit is "1" (plain accept) or this option, so a flow whose "2" means PASS
    // (round-robin) never mis-records a "2, can't take it" reply as a claim.
    claimTimeframeOption: z.number().int().min(1).max(9).optional(),
    // The reply digit that means "claim a lead AFTER its offer window lapsed"
    // (retroactive/late claim) WITH a timeframe — a teammate replies
    // "<digit>, <eta>" to re-open a lapsed offer and state when they'll reach
    // out. Distinct from claimTimeframeOption (the live option) so a lapsed
    // lead has its own numbered affordance instead of the old magic "86" (which
    // is now reserved for retroactive UNCLAIM). Must differ from
    // claimTimeframeOption (enforced in validateDefinitionSemantics).
    lateClaimOption: z.number().int().min(1).max(9).optional(),
    when: whenSchema.optional()
  }),
  z.object({
    id: stepId,
    type: z.literal("browse_action"),
    urlVar: varName,
    auth: browseAuthSchema.optional(),
    actions: z.array(browseActionItemSchema).min(1).max(15),
    // Optional same-pass extraction: pull these fields from the page text AFTER
    // the actions run (e.g. accept a lead then read its name/phone/email in one
    // credentialed session). Produces {{vars.<field>}} like browse_extract.
    fields: z.array(extractFieldSchema).min(1).max(15).optional(),
    screenshot: z.boolean().optional(),
    // Persist this step's final URL keyed by the (normalized) phone in this var,
    // so a later run for the same person can recall it via a recall_url step.
    rememberUrlKeyedByVar: varName.optional(),
    // Loop-over-list: a CSS selector for link rows on the urlVar page. The render
    // service visits each match's href and runs `actions` on every one. Per-item,
    // so it's incompatible with fields/screenshot/rememberUrlKeyedByVar (enforced
    // in validateDefinitionSemantics).
    forEachLink: z.string().min(1).max(200).optional(),
    // Restrict the forEachLink loop to rows whose text contains one of the names
    // in this earlier-produced var (split on commas/newlines/semicolons). Only
    // valid alongside forEachLink (enforced in validateDefinitionSemantics).
    forEachLinkMatchVar: varName.optional(),
    // Terminal-state guard: when an action fails AND the page contains this
    // marker text (case-insensitive), the goal is already met (e.g. a lead
    // another agent already claimed) so the run ENDS gracefully — the step is
    // recorded "skipped" and the run finishes as done — instead of failing.
    skipWhenText: z.string().min(1).max(200).optional(),
    when: whenSchema.optional()
  }),
  // Recall a URL a PRIOR run persisted (browse_action.rememberUrlKeyedByVar) for
  // the same person into {{vars.<saveAs>}}. Keys come from the inbound group
  // participants and/or vars naming phone numbers. Saves "" on a miss.
  z.object({
    id: stepId,
    type: z.literal("recall_url"),
    keyFromTrigger: z.literal("participants").optional(),
    keyVars: z.array(varName).max(10).optional(),
    saveAs: varName,
    when: whenSchema.optional()
  }),
  // Create/enrich a customer profile from vars an earlier step produced: the
  // phone (phoneVar) keys the record; name/email fill it in. Lets an extracting
  // flow build the contact even when it never texts the lead. No templates.
  z.object({
    id: stepId,
    type: z.literal("upsert_customer"),
    phoneVar: varName,
    nameVar: varName.optional(),
    emailVar: varName.optional(),
    when: whenSchema.optional()
  }),
  // ── Voice steps (real-time call routing; see VOICE_STEP_TYPES) ──
  // Ring a human and wait for them to answer. The voice webhook warm-transfers
  // the live caller to `toE164` and rings for `ringSeconds`; on no-answer it
  // advances to the next ring_handoff, then the voice_ai_intake (if any). Order
  // in `steps` is the ring order.
  z.object({
    id: stepId,
    type: z.literal("ring_handoff"),
    toE164: e164,
    ringSeconds: z.number().int().min(5).max(120).optional(),
    when: whenSchema.optional()
  }),
  // AI takeover after every ring_handoff missed: a human presses 1 to hand the
  // live caller to the AI worker, which captures the lead and texts a summary
  // (+ transcript) to `notifyE164`. At most one per flow, and it must come AFTER
  // the ring_handoff steps (enforced in validateVoiceFlow).
  z.object({
    id: stepId,
    type: z.literal("voice_ai_intake"),
    notifyE164: e164,
    persona: z.string().min(1).max(500).optional(),
    captureFields: z.array(z.string().min(1).max(60)).min(1).max(15).optional(),
    when: whenSchema.optional()
  }),
  // Single blind warm transfer (e.g. a known partner line that should connect
  // straight to a person, bypassing the AI). Optional `whisper` is spoken to the
  // caller before the bridge. A voice_transfer flow has exactly one step and no
  // ring_handoff/voice_ai_intake (enforced in validateVoiceFlow).
  z.object({
    id: stepId,
    type: z.literal("voice_transfer"),
    toE164: e164,
    whisper: z.string().min(1).max(300).optional(),
    when: whenSchema.optional()
  }),
  // Outbound origination: place a call and, when the callee answers, let the AI
  // bridge talk to them (mirrors voice_ai_intake but on a dialed-out leg). The
  // origination edge function reserves voice budget BEFORE the AI media attaches
  // (so an over-budget account can't place AI calls) and texts the captured
  // summary + transcript to `notifyE164`. `toE164` is the default callee; the
  // "Place call" entry point may override it per call. Only valid as the single
  // step of an outbound voice flow (enforced in validateVoiceFlow).
  z.object({
    id: stepId,
    type: z.literal("outbound_call"),
    toE164: e164.optional(),
    notifyE164: e164,
    persona: z.string().min(1).max(500).optional(),
    captureFields: z.array(z.string().min(1).max(60)).min(1).max(15).optional(),
    when: whenSchema.optional()
  })
]);

export const aiFlowDefinitionSchema = z.object({
  version: z.literal(1),
  trigger: triggerSchema,
  steps: z.array(stepSchema).min(1).max(25),
  options: z
    .object({
      suppressDefaultReply: z.boolean().optional(),
      // Per-flow opt-in: capture a screenshot on every browse step (and a
      // before/at-failure pair when a browse_action breaks) for the run
      // "investigate" view. Default off so most flows pay no extra latency.
      captureStepScreenshots: z.boolean().optional()
    })
    .optional()
});

export type TriggerCondition = z.infer<typeof conditionSchema>;
export type FlowTrigger = z.infer<typeof triggerSchema>;
export type FlowStep = z.infer<typeof stepSchema>;
export type StepCondition = z.infer<typeof whenSchema>;
export type AiFlowDefinition = z.infer<typeof aiFlowDefinitionSchema>;

/** The trigger channels the builder offers. */
export const TRIGGER_CHANNELS = ["sms", "manual", "schedule", "email", "tenant_email", "voice"] as const;

export class AiFlowValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: string[]
  ) {
    super(message);
    this.name = "AiFlowValidationError";
  }
}

const TEMPLATE_REF_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Parse `{{scope.key}}` references out of a template string. */
export function collectTemplateRefs(text: string): { scope: string; key: string }[] {
  const refs: { scope: string; key: string }[] = [];
  let m: RegExpExecArray | null;
  TEMPLATE_REF_RE.lastIndex = 0;
  while ((m = TEMPLATE_REF_RE.exec(text)) !== null) {
    const parts = m[1].split(".");
    if (parts.length >= 2) refs.push({ scope: parts[0], key: parts[1] });
    else refs.push({ scope: parts[0], key: "" });
  }
  return refs;
}

/** The template-bearing strings of a step (where `{{vars.x}}` can appear). */
function templateStringsForStep(step: FlowStep): string[] {
  switch (step.type) {
    case "send_sms":
      return [step.to ?? "", step.body, step.quietHours?.emailSubject ?? ""];
    case "send_email":
      return [step.to, ...(step.cc ?? []), ...(step.bcc ?? []), step.subject, step.body];
    case "notify_owner":
      return [step.message];
    case "approval_gate":
      return [step.prompt];
    case "http_call":
      return [step.path ?? "", step.bodyTemplate ?? ""];
    case "route_to_team":
      return [step.offerTemplate, step.ownerFallbackTemplate, step.claimedNotifyTemplate ?? ""];
    case "browse_action":
      return step.actions.map((a) => a.valueTemplate ?? "");
    case "email_extract":
      return step.matchTemplates ?? [];
    case "extract_url":
    case "browse_extract":
    case "extract_text":
    case "recall_url":
    case "upsert_customer":
    // Voice steps carry no `{{vars.x}}` templates (phone numbers + a persona
    // string captured live), so there is nothing to scope-check here.
    case "ring_handoff":
    case "voice_ai_intake":
    case "voice_transfer":
    case "outbound_call":
      return [];
  }
}

const TRIGGER_KEYS = new Set<string>(TRIGGER_SCOPE_KEYS);
const AGENT_KEYS = new Set<string>(AGENT_SCOPE_KEYS);
const OFFER_KEYS = new Set<string>(OFFER_SCOPE_KEYS);
const ENGINE_VARS = new Set<string>(ENGINE_PROVIDED_VARS);
const NOW_KEYS = new Set<string>(NOW_SCOPE_KEYS);
const VOICE_STEPS = new Set<string>(VOICE_STEP_TYPES);

/**
 * Cross-step invariants for a `voice`-triggered flow (real-time call routing).
 * Voice flows have no vars/templates, so they get their own rules instead of the
 * scope checks below:
 *   - every step must be a voice step (ring_handoff/voice_ai_intake/voice_transfer);
 *   - a flow is EITHER a single blind transfer (exactly one voice_transfer, nothing
 *     else) OR a handoff chain (>= 1 ring_handoff, then an OPTIONAL single trailing
 *     voice_ai_intake) — the two shapes never mix;
 *   - voice_ai_intake must be the LAST step and needs a preceding ring_handoff
 *     (the product always rings a human before the AI takes over).
 * Returns human-readable issues (step-id uniqueness is checked by the caller).
 */
export function validateVoiceFlow(def: AiFlowDefinition): string[] {
  const issues: string[] = [];
  const steps = def.steps;
  const nonVoice = steps.filter((s) => !VOICE_STEPS.has(s.type));
  for (const s of nonVoice) {
    issues.push(
      `Step "${s.id}" is a "${s.type}" step but this is a voice flow — voice flows use only ring_handoff, voice_ai_intake, voice_transfer, or outbound_call.`
    );
  }
  // If any non-voice step slipped in, the shape rules below would be misleading.
  if (nonVoice.length > 0) return issues;

  const trigger = def.trigger as Extract<FlowTrigger, { channel: "voice" }>;
  const outboundCalls = steps.filter((s) => s.type === "outbound_call");

  // Outbound origination flow: triggered on demand (the "Place call" entry), not
  // by an inbound caller. Exactly one outbound_call step, nothing else.
  if (trigger.direction === "outbound") {
    if (steps.length !== 1 || outboundCalls.length !== 1) {
      issues.push(
        "An outbound voice flow must contain exactly one outbound_call step (and no inbound voice steps)."
      );
    }
    return issues;
  }

  // Inbound voice flow. outbound_call is outbound-only; and an inbound flow needs
  // a caller number to match against.
  if (outboundCalls.length > 0) {
    issues.push(
      'outbound_call is only valid in an outbound voice flow (set the trigger direction to "outbound").'
    );
    return issues;
  }
  if (!trigger.fromE164) {
    issues.push(
      "An inbound voice flow needs a caller number (fromE164) on its trigger."
    );
  }

  const transfers = steps.filter((s) => s.type === "voice_transfer");
  const rings = steps.filter((s) => s.type === "ring_handoff");
  const intakes = steps.filter((s) => s.type === "voice_ai_intake");

  if (transfers.length > 0) {
    // Blind-transfer flow: it must be the ONLY step.
    if (steps.length !== 1) {
      issues.push(
        "A voice_transfer flow connects the caller straight to one number — it must be the only step (no ring_handoff/voice_ai_intake)."
      );
    }
    return issues;
  }

  // Otherwise it's a handoff chain: at least one ring_handoff.
  if (rings.length === 0) {
    issues.push(
      "A voice flow needs at least one ring_handoff (or a single voice_transfer)."
    );
  }
  if (intakes.length > 1) {
    issues.push("A voice flow can have at most one voice_ai_intake.");
  }
  if (intakes.length === 1) {
    const last = steps[steps.length - 1];
    if (last.type !== "voice_ai_intake") {
      issues.push(
        "voice_ai_intake must be the last step — it only takes over after every ring_handoff missed."
      );
    }
    if (rings.length === 0) {
      issues.push("voice_ai_intake needs a preceding ring_handoff (ring a human first).");
    }
  }
  return issues;
}

/**
 * Cross-step invariants zod cannot express:
 *   - step ids are unique;
 *   - every `{{vars.x}}` a step references was produced by an EARLIER step;
 *   - every `{{trigger.x}}` references a real trigger-scope key;
 *   - a `browse_extract.urlVar` is in scope (produced earlier);
 *   - any other template scope is unknown → error.
 * Returns a (possibly empty) list of human-readable issues.
 */
export function validateDefinitionSemantics(def: AiFlowDefinition): string[] {
  const issues: string[] = [];
  const seenIds = new Set<string>();

  // Voice flows run on the real-time call path and have no vars/templates — they
  // get their own shape rules. We still enforce step-id uniqueness here so the
  // editor's per-step errors stay consistent across channels.
  if (def.trigger.channel === "voice") {
    for (const step of def.steps) {
      if (seenIds.has(step.id)) issues.push(`Duplicate step id "${step.id}".`);
      seenIds.add(step.id);
    }
    issues.push(...validateVoiceFlow(def));
    return issues;
  }

  // A voice step under a non-voice trigger can never execute (the batch worker
  // has no handler for it) — reject it rather than silently no-op at run time.
  for (const step of def.steps) {
    if (VOICE_STEPS.has(step.type)) {
      issues.push(
        `Step "${step.id}" is a voice step ("${step.type}") but the trigger is "${def.trigger.channel}" — voice steps need a voice trigger.`
      );
    }
  }

  const vars = new Set<string>();
  // True once an earlier browse step (browse_extract or browse_action) has
  // `screenshot: true` — the prerequisite for any later step's attachScreenshot.
  let screenshotCaptured = false;

  for (const step of def.steps) {
    if (seenIds.has(step.id)) {
      issues.push(`Duplicate step id "${step.id}".`);
    }
    seenIds.add(step.id);

    for (const tpl of templateStringsForStep(step)) {
      for (const ref of collectTemplateRefs(tpl)) {
        if (ref.scope === "trigger") {
          if (!TRIGGER_KEYS.has(ref.key)) {
            issues.push(`Step "${step.id}" references unknown trigger field "${ref.key}".`);
          }
        } else if (ref.scope === "vars") {
          if (!vars.has(ref.key) && !ENGINE_VARS.has(ref.key)) {
            issues.push(
              `Step "${step.id}" uses {{vars.${ref.key}}} before any step produces it.`
            );
          }
        } else if (ref.scope === "agent") {
          // {{agent.name}}/{{agent.phone}} is the resolved team member, known at
          // run time inside a route_to_team step (the offered agent) or a
          // send_sms { toAgentName } step (the named recipient).
          const hasAgent =
            step.type === "route_to_team" ||
            (step.type === "send_sms" && Boolean(step.toAgentName));
          if (!hasAgent) {
            issues.push(
              `Step "${step.id}" uses {{agent.${ref.key}}} but only a route_to_team or send_sms toAgentName step has an agent.`
            );
          } else if (!AGENT_KEYS.has(ref.key)) {
            issues.push(`Step "${step.id}" references unknown agent field "${ref.key}".`);
          }
        } else if (ref.scope === "offer") {
          // {{offer.deadline}} is the resolved claim deadline, only known when a
          // route_to_team step sends an offer.
          if (step.type !== "route_to_team") {
            issues.push(
              `Step "${step.id}" uses {{offer.${ref.key}}} but only a route_to_team step has an offer.`
            );
          } else if (!OFFER_KEYS.has(ref.key)) {
            issues.push(`Step "${step.id}" references unknown offer field "${ref.key}".`);
          }
        } else if (ref.scope === "now") {
          // {{now.today.*}} / {{now.tomorrow.*}} / {{now.afternoonTime}} —
          // relative dates the worker injects each run. Only the first segment
          // is validated; the date parts under today/tomorrow are open.
          if (!NOW_KEYS.has(ref.key)) {
            issues.push(`Step "${step.id}" references unknown date field "now.${ref.key}".`);
          }
        } else {
          issues.push(`Step "${step.id}" uses unknown template scope "${ref.scope}".`);
        }
      }
    }

    if ((step.type === "browse_extract" || step.type === "browse_action") && !vars.has(step.urlVar)) {
      issues.push(`Step "${step.id}" browses urlVar "${step.urlVar}" which no earlier step produces.`);
    }

    // browse_action.forEachLink loops the actions over many list rows, so the
    // single-page features (same-pass extraction, one screenshot, remembering one
    // URL) don't apply — reject the combination rather than silently ignore it.
    if (step.type === "browse_action" && step.forEachLink) {
      if (step.fields && step.fields.length > 0) {
        issues.push(
          `Step "${step.id}" can't combine forEachLink with fields — extraction has no single page in a loop.`
        );
      }
      if (step.screenshot) {
        issues.push(`Step "${step.id}" can't combine forEachLink with screenshot.`);
      }
      if (step.rememberUrlKeyedByVar) {
        issues.push(`Step "${step.id}" can't combine forEachLink with rememberUrlKeyedByVar.`);
      }
    }

    // forEachLinkMatchVar narrows a forEachLink loop to rows naming one of the
    // values in an EARLIER-produced var. It's meaningless without forEachLink,
    // and (like urlVar) the var must already be in scope.
    if (step.type === "browse_action" && step.forEachLinkMatchVar) {
      if (!step.forEachLink) {
        issues.push(
          `Step "${step.id}" sets forEachLinkMatchVar but has no forEachLink to filter.`
        );
      }
      if (!vars.has(step.forEachLinkMatchVar) && !ENGINE_VARS.has(step.forEachLinkMatchVar)) {
        issues.push(
          `Step "${step.id}" filters its forEachLink by {{vars.${step.forEachLinkMatchVar}}} which no earlier step produces.`
        );
      }
    }

    // browse_action.rememberUrlKeyedByVar persists the final URL under a phone
    // value from an EARLIER step OR a field THIS step extracts in the same pass
    // (e.g. accept a lead, read its phone, remember the page by that phone).
    if (step.type === "browse_action" && step.rememberUrlKeyedByVar) {
      const ownFields = new Set((step.fields ?? []).map((f) => f.name));
      if (
        !vars.has(step.rememberUrlKeyedByVar) &&
        !ENGINE_VARS.has(step.rememberUrlKeyedByVar) &&
        !ownFields.has(step.rememberUrlKeyedByVar)
      ) {
        issues.push(
          `Step "${step.id}" remembers its URL keyed by {{vars.${step.rememberUrlKeyedByVar}}} which no earlier step or its own extraction produces.`
        );
      }
    }

    // recall_url.keyVars name phone-holding vars an EARLIER step produced, and
    // it must have SOME key source (participants and/or keyVars) to look up.
    if (step.type === "recall_url") {
      for (const kv of step.keyVars ?? []) {
        if (!vars.has(kv) && !ENGINE_VARS.has(kv)) {
          issues.push(
            `Step "${step.id}" recalls a URL keyed by {{vars.${kv}}} which no earlier step produces.`
          );
        }
      }
      if (step.keyFromTrigger === undefined && (step.keyVars?.length ?? 0) === 0) {
        issues.push(
          `Step "${step.id}" recalls a URL but has no key source — set keyFromTrigger or keyVars.`
        );
      }
      if (step.keyFromTrigger === "participants" && def.trigger.channel !== "sms") {
        issues.push(
          `Step "${step.id}" recalls by group participants, which only works on an SMS-triggered flow.`
        );
      }
    }

    // upsert_customer keys/fills the customer from vars an EARLIER step
    // produced (the phone is required; name/email are optional fills).
    if (step.type === "upsert_customer") {
      const refs: Array<[string, string | undefined]> = [
        ["phoneVar", step.phoneVar],
        ["nameVar", step.nameVar],
        ["emailVar", step.emailVar]
      ];
      for (const [label, v] of refs) {
        if (v && !vars.has(v) && !ENGINE_VARS.has(v)) {
          issues.push(
            `Step "${step.id}" upserts a customer using ${label} {{vars.${v}}} which no earlier step produces.`
          );
        }
      }
    }

    // The owner-mailbox send path is plain text (Nango Gmail/Outlook); the
    // screenshot attachment only exists on the AI coworker's own Resend path.
    if (step.type === "send_email" && step.attachScreenshot && step.fromConnectionId) {
      issues.push(
        `Step "${step.id}" attaches a screenshot but sends from a connected mailbox — attachments are only supported when sending from your AI coworker's email.`
      );
    }

    // A send_sms needs EXACTLY ONE recipient source: a templated `to`, a named
    // roster member (`toAgentName`), or `replyToGroup` (reply into the inbound
    // group thread). replyToGroup only makes sense for an SMS-triggered flow
    // that can carry participants.
    if (step.type === "send_sms") {
      // `to` is either absent or (by schema) a non-empty string, so a truthy
      // `to` means a recipient is configured.
      const sources = [Boolean(step.to), Boolean(step.toAgentName), Boolean(step.replyToGroup)];
      const count = sources.filter(Boolean).length;
      if (count === 0) {
        issues.push(
          `Step "${step.id}" sends a text but has no recipient — set "to", "toAgentName", or turn on replyToGroup.`
        );
      } else if (count > 1) {
        issues.push(
          `Step "${step.id}" sets more than one recipient — use only one of "to", "toAgentName", or replyToGroup.`
        );
      }
      if (step.replyToGroup && def.trigger.channel !== "sms") {
        issues.push(
          `Step "${step.id}" replies to a group thread, which only works on an SMS-triggered flow.`
        );
      }
    }

    // The quiet-hours email fallback reads the lead email from a var an
    // EARLIER step must have produced (same scope rule as urlVar / when).
    if (
      step.type === "send_sms" &&
      step.quietHours?.emailFallbackVar &&
      !vars.has(step.quietHours.emailFallbackVar) &&
      !ENGINE_VARS.has(step.quietHours.emailFallbackVar)
    ) {
      issues.push(
        `Step "${step.id}" falls back to {{vars.${step.quietHours.emailFallbackVar}}} after hours, which no earlier step produces.`
      );
    }

    // attachScreenshot needs a screenshot: an EARLIER browse step with
    // `screenshot: true` (which is what stores the image the worker attaches).
    if (
      (step.type === "send_email" || step.type === "route_to_team") &&
      step.attachScreenshot &&
      !screenshotCaptured
    ) {
      issues.push(
        `Step "${step.id}" attaches a screenshot but no earlier browse step captures one.`
      );
    }

    // The live "accept with a timeframe" digit and the retroactive late-claim
    // digit must be distinct, or a single reply digit would be ambiguous
    // between claiming a live offer and re-opening a lapsed one.
    if (
      step.type === "route_to_team" &&
      step.claimTimeframeOption !== undefined &&
      step.lateClaimOption !== undefined &&
      step.claimTimeframeOption === step.lateClaimOption
    ) {
      issues.push(
        `Step "${step.id}" uses the same digit for claimTimeframeOption and lateClaimOption — they must differ.`
      );
    }

    // A `when` guard may only reference a var an EARLIER step produced (same
    // scope rule as urlVar/templates — checked before this step's own vars are
    // registered below).
    if (step.when && !vars.has(step.when.var) && !ENGINE_VARS.has(step.when.var)) {
      issues.push(
        `Step "${step.id}" has a "when" condition on {{vars.${step.when.var}}} which no earlier step produces.`
      );
    }

    // Register the vars this step produces (visible to LATER steps only).
    if (step.type === "extract_url") {
      vars.add(step.saveAs);
    } else if (step.type === "browse_extract") {
      for (const f of step.fields ?? []) vars.add(f.name);
      for (const l of step.extractLinks ?? []) vars.add(l.name);
      if (step.screenshot) screenshotCaptured = true;
    } else if (step.type === "extract_text") {
      for (const f of step.fields) vars.add(f.name);
    } else if (step.type === "email_extract") {
      for (const f of step.fields) vars.add(f.name);
    } else if (step.type === "browse_action") {
      // Same-pass extraction registers its produced vars for LATER steps, just
      // like browse_extract.
      for (const f of step.fields ?? []) vars.add(f.name);
      if (step.screenshot) screenshotCaptured = true;
    } else if (step.type === "http_call" && step.saveAs) {
      vars.add(step.saveAs);
    } else if (step.type === "recall_url") {
      vars.add(step.saveAs);
    }
  }

  return issues;
}

/**
 * Parse + fully validate an AiFlow definition. Throws `AiFlowValidationError`
 * with a flat issue list on any shape or semantic failure; returns the typed
 * definition on success.
 */
export function parseAiFlowDefinition(input: unknown): AiFlowDefinition {
  const parsed = aiFlowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
    );
    throw new AiFlowValidationError("Invalid AiFlow definition", issues);
  }
  const semanticIssues = validateDefinitionSemantics(parsed.data);
  if (semanticIssues.length > 0) {
    throw new AiFlowValidationError("Invalid AiFlow definition", semanticIssues);
  }
  return parsed.data;
}

/** A short, human summary of a definition for list/run UIs. */
export function summarizeDefinition(def: AiFlowDefinition): string {
  const t = def.trigger;
  let trigPart: string;
  switch (t.channel) {
    case "sms":
      trigPart =
        t.conditions.length === 0
          ? "When any inbound SMS"
          : `When SMS matching ${t.conditions.length} condition(s)`;
      break;
    case "manual":
      trigPart = "On demand";
      break;
    case "schedule":
      trigPart =
        t.everyMinutes !== undefined
          ? `Every ${t.everyMinutes} min`
          : `Daily at ${t.time} (${t.timezone})`;
      break;
    case "email":
      trigPart =
        t.conditions.length === 0
          ? "When any inbound email"
          : `When email matching ${t.conditions.length} condition(s)`;
      break;
    case "tenant_email":
      trigPart =
        t.conditions.length === 0
          ? "When the AI mailbox receives any email"
          : `When AI mailbox email matches ${t.conditions.length} condition(s)`;
      break;
    case "voice":
      trigPart =
        t.direction === "outbound"
          ? "When you place an outbound call"
          : `When a call comes in from ${t.fromE164}`;
      break;
  }
  const stepTypes = def.steps.map((s) => s.type).join(" -> ");
  return `${trigPart}: ${stepTypes}`;
}
