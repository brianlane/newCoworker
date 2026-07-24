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
 *   1. `aiFlowDefinitionSchema` (zod); shape + bounds.
 *   2. `validateDefinitionSemantics`; cross-step invariants zod can't express:
 *      unique step ids, and a variable-flow check so a template never references
 *      a `{{vars.x}}` / `{{trigger.x}}` that isn't in scope at that point.
 */
import { z } from "zod";
import { formatDurationMinutes } from "./duration";

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
  // Read typed fields out of a DOCUMENT (the triggering email's PDF/text
  // attachment) via Gemini's native PDF understanding, optionally filing it
  // into Business Documents — the back-office primitive (renewal review,
  // doc intake) built on the existing documents store.
  "doc_extract",
  "send_sms",
  "send_whatsapp",
  "send_email",
  "approval_gate",
  "notify_owner",
  // Notify whoever the lead BELONGS to: the contact's owning employee
  // (contacts.owner_employee_id, set when a teammate claims) when there is
  // one, else the business owner. Resolution keys on a phone var first,
  // then a name var (unique display-name match), and always falls back to
  // the owner — a forwarded message is never dropped.
  "notify_lead_owner",
  "http_call",
  "sleep",
  "wait_for_reply",
  // Batch-flow outbound AI call: dial a var-held number, run a scripted AI
  // persona, optionally live-transfer, and park until the call's outcome
  // lands. Runs on the async worker (NOT a voice-channel step) — the call
  // itself is placed through the same origination edge function as
  // outbound_call, with identical budget metering.
  "place_ai_call",
  // Arm a short-lived "expect a live-transfer call" window: while armed, an
  // inbound call that matches NO per-caller voice routing bridges straight to
  // the configured number instead of the AI (telnyx-voice-inbound consumes the
  // window). Built for referral services (e.g. Clever) whose concierges call
  // from a rotating number pool right after an SMS cue is confirmed.
  "arm_voice_transfer",
  "branch",
  "goal",
  "math",
  "route_to_team",
  "browse_action",
  "recall_url",
  "upsert_customer",
  "update_contact",
  "classify",
  "generate_image",
  "share_document",
  "run_agent",
  // Voice-channel steps (real-time call routing, executed by the Telnyx voice
  // webhook state machine; NOT the async ai-flow-worker). Only valid under a
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
 *     contact (SMS / email / routing), so a later step; e.g. a browse_action
 *     timeline note; can template "what did this flow actually do".
 *   - `claimed_agent`: set by `route_to_team` to the claiming teammate's name
 *     (or "none" on owner-fallback / no claim), so LATER steps can gate on
 *     `when: { var: "claimed_agent", notEquals: "none" }` to run only after a
 *     teammate accepted the lead. Empty string before any route_to_team runs.
 *   - `claimed_agent_phone`: the claiming teammate's E.164 phone (or "none",
 *     same lifecycle as `claimed_agent`), so a LATER `wait_for_reply` can
 *     park on the CLAIMER's next text (e.g. "that lead's number is
 *     disconnected") — not just on the lead's.
 *   - `claimed_agent_eta_minutes`: the ETA a claimer stated ("1, 20 min" →
 *     "20"), parsed to whole minutes; "0" when they claimed with a bare "1"
 *     or the ETA wasn't a parseable duration. Feed it through a `math` step
 *     to size a follow-up wait (e.g. ETA + 60).
 *   - `group_lead_phone`: on a group-text trigger, the lead's E.164 number —
 *     the one thread participant who is neither the alert's sender nor any of
 *     the business's own numbers (e.g. the seller in a referral service's
 *     intro thread, whose number appears nowhere in the message text). Only
 *     seeded when a `from_matches` trigger condition PINS the sender to a
 *     declared identity — without the pin the sender could be the lead
 *     themselves and the roster remainder would be the service. Empty for
 *     non-group triggers, unpinned senders, or when the roster leaves 0 or
 *     2+ candidates (never guess who the lead is).
 */
export const ENGINE_PROVIDED_VARS = [
  "actions_taken",
  "claimed_agent",
  "claimed_agent_phone",
  "claimed_agent_eta_minutes",
  "group_lead_phone"
] as const;

/** The UI action kinds a browse_action step may perform. */
export const BROWSE_ACTION_KINDS = [
  "click_text",
  "click_selector",
  "fill_selector",
  "fill_placeholder",
  // Repeatedly click an element matching `target`'s visible text until it is
  // no longer present (bounded). Zero matches is success, not a failure; for
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

/**
 * Trigger-scope keys templates may reference. url/windowText/from are set on
 * every channel (see evaluateSmsTrigger); to/participants are SMS-only and
 * event_id/event_title/starts_at/ends_at/calendar are calendar-only — the
 * engine renders absent keys as "", so cross-channel references degrade
 * instead of failing.
 */
export const TRIGGER_SCOPE_KEYS = [
  "url",
  "windowText",
  "from",
  "to",
  "participants",
  "event_id",
  "event_title",
  "starts_at",
  "ends_at",
  "calendar",
  // First image attached to the triggering message: an inbound MMS photo
  // (Telnyx media URL) or an inbound tenant-mailbox email attachment
  // (`email-attachments:<path>` ref). "" on every other channel — used by
  // generate_image's inputImageTemplate to edit the sender's photo.
  "image",
  // First DOCUMENT attachment (PDF / txt / markdown / csv) on an inbound
  // tenant-mailbox email, as an `email-attachments:<path>` ref ("" on every
  // other channel) — the default source of a doc_extract step. document_name
  // is its display filename for templates/notifications.
  "document",
  "document_name",
  // tenant_email only: the comma-separated attachment filenames and their
  // count — what document-receipt confirmations name back to the sender.
  // "" / absent on every other channel.
  "attachments",
  "attachment_count",
  // Contact-event channels (contact_created / tag_changed / owner_assigned;
  // see contactEventTriggerScope): the contact's identity, the changed tag,
  // the owner's name, and a free-text `note` the event source may attach
  // (the needs-human escalation passes the customer's last message). "" on
  // every other channel.
  "contact_name",
  "contact_email",
  "tag",
  "change",
  "owner_name",
  "note"
] as const;

/**
 * Top-level keys of the `{{now.*}}` scope the worker injects each run (relative
 * dates in the business timezone; see engine.buildNowScope). Nested parts like
 * `now.tomorrow.weekday` are not enumerated; the validator only checks the
 * first scope segment.
 */
export const NOW_SCOPE_KEYS = ["today", "tomorrow", "in7Days", "afternoonTime"] as const;

const varName = z
  .string()
  .regex(VAR_NAME_PATTERN, "must start with a letter and use letters/digits/underscore");

/**
 * A dynamic contact reference: a saved person whose phone is resolved LIVE at
 * run time (see ContactRef in _shared/ai_flows/types). `id` is a uuid row key in
 * ai_flow_team_members (employee) or contacts (contact). `label` is an
 * editor-only display hint captured when the ref was picked. Used as an
 * alternative to a hardcoded number on every recipient/dial field; the
 * "exactly one source" rules live in validateDefinitionSemantics (a
 * discriminatedUnion member can't hold a refine).
 */
const contactRefSchema = z.object({
  source: z.enum(["employee", "contact"]),
  id: z.string().uuid(),
  label: z.string().min(1).max(120).optional()
});

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
    // Exactly one of value / ref (enforced in validateDefinitionSemantics).
    // With `ref`, the sender matches when it contains any of the referenced
    // person's live identity values (phone + merge aliases + email).
    value: z.string().min(1).max(100).optional(),
    ref: contactRefSchema.optional(),
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
 * Inbound-webhook trigger: an authenticated POST to the public API
 * (`/api/public/v1/flow-events`, bearer = the tenant's `nck_` API key) fires
 * every enabled webhook flow whose conditions match. Push-based like
 * `tenant_email`; the endpoint flattens the JSON event payload into
 * windowText so conditions / extract_text / templates work unchanged. This is
 * the substrate for external lead sources (e.g. Meta Lead Ads via a
 * Zapier/Make bridge). `from_matches` tests the caller-supplied `source`
 * label (e.g. "facebook_lead_ads").
 */
const webhookTriggerSchema = z.object({
  channel: z.literal("webhook"),
  conditions: z.array(conditionSchema).max(20)
});

/**
 * Calendar-event trigger: the app polls the business's connected calendar
 * (resolved like the calendar tools — Google first, Microsoft fallback; no
 * connectionId stored) and fires when an event is created (`on:
 * "event_created"`) or is about to start (`on: "event_start"`, `leadMinutes`
 * before the start). `calendar` picks which calendar(s) to watch: the
 * connected account's primary, the shared NewCoworker calendar, or both
 * (default). Conditions run over the event text (title + description +
 * location + attendees); `from_matches` tests the organizer email.
 */
const calendarTriggerSchema = z
  .object({
    channel: z.literal("calendar"),
    calendar: z.enum(["primary", "shared", "both"]).optional(),
    on: z.enum(["event_created", "event_start", "event_end", "event_canceled"]),
    // min 1: the due window is [start - leadMinutes, start), so a zero lead
    // would be an empty window that can never fire.
    leadMinutes: z.number().int().min(1).max(1440).optional(),
    // event_end only: run this long AFTER the event's actual end time (0 /
    // omitted = right when it ends). Anchored to the event's real end, so a
    // 30-minute and a 2-hour appointment both follow up correctly — no
    // guessed sleep needed.
    followMinutes: z.number().int().min(0).max(1440).optional(),
    conditions: z.array(conditionSchema).max(20)
  })
  .superRefine((t, ctx) => {
    if (t.on === "event_start" && t.leadMinutes === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "event_start mode needs leadMinutes (how long before the event to run)"
      });
    } else if (t.on !== "event_start" && t.leadMinutes !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "leadMinutes only applies to event_start mode"
      });
    }
    if (t.on !== "event_end" && t.followMinutes !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "followMinutes only applies to event_end mode"
      });
    }
  });

/**
 * Inbound-voice trigger: a call FROM `fromE164` to one of the business's voice
 * numbers fires this flow. Unlike every other channel this does NOT enqueue an
 * ai_flow_run; the Telnyx voice webhook (telnyx-voice-inbound) resolves the
 * matching enabled voice flow in real time and drives the call-control state
 * machine directly from its compiled steps. The flow row exists purely so the
 * routing is authored/visible/CRUD-able in the AiFlows UI like any other flow.
 */
const voiceTriggerSchema = z
  .object({
    channel: z.literal("voice"),
    // Inbound flows: a call FROM `fromE164` fires the flow (resolved by
    // telnyx-voice-inbound). Inbound needs exactly one of fromE164 / fromRef,
    // outbound neither; enforced by direction in validateVoiceFlow.
    fromE164: e164.optional(),
    // Dynamic caller match: the flow fires when the caller is one of the
    // referenced saved person's LIVE numbers (employee phone, or contact
    // number + merge aliases), resolved by the voice webhook at call time.
    fromRef: contactRefSchema.optional(),
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

/**
 * Contact-event trigger: a NEW contact landed on the Contacts page (created
 * from the dashboard, a CSV/lead import, or a flow's upsert_customer step).
 * Conditions run over a "key: value" text of the contact's fields;
 * `from_matches` tests the contact's phone.
 */
const contactCreatedTriggerSchema = z.object({
  channel: z.literal("contact_created"),
  conditions: z.array(conditionSchema).max(20)
});

/**
 * Contact-event trigger: a tag was added to / removed from a contact
 * (dashboard edits and update_contact flow steps both fire it). `tag`
 * narrows to one tag (case-insensitive); omitted matches any. `change`
 * defaults to "added". The flow whose own update_contact step wrote the tag
 * never retriggers itself (loop guard).
 */
const tagChangedTriggerSchema = z.object({
  channel: z.literal("tag_changed"),
  tag: z.string().min(1).max(40).optional(),
  change: z.enum(["added", "removed"]).optional(),
  conditions: z.array(conditionSchema).max(20)
});

/**
 * Contact-event trigger: a roster member became the contact's owner (a
 * route_to_team claim auto-assigned it, or a manual assignment on the
 * contact page).
 */
const ownerAssignedTriggerSchema = z.object({
  channel: z.literal("owner_assigned"),
  conditions: z.array(conditionSchema).max(20)
});

/**
 * Birthday trigger: fires once per year per contact whose stored birthday is
 * today, at/after local `time` (default 09:00) in `timezone` (default: the
 * business timezone). Swept by the worker's cron tick.
 */
const birthdayTriggerSchema = z.object({
  channel: z.literal("birthday"),
  time: hhmm.optional(),
  timezone: timezone.optional(),
  conditions: z.array(conditionSchema).max(20)
});

const triggerSchema = z.discriminatedUnion("channel", [
  smsTriggerSchema,
  manualTriggerSchema,
  scheduleTriggerSchema,
  emailTriggerSchema,
  tenantEmailTriggerSchema,
  webhookTriggerSchema,
  calendarTriggerSchema,
  contactCreatedTriggerSchema,
  tagChangedTriggerSchema,
  ownerAssignedTriggerSchema,
  birthdayTriggerSchema,
  voiceTriggerSchema
]);

const extractFieldSchema = z.object({
  name: varName,
  description: z.string().max(300).optional()
});

/**
 * A browse_extract link capture: find the first `<a>` on the page whose visible
 * text contains `matchText` and save its resolved href as `{{vars.<name>}}`
 * (empty string if no match). Used to grab a button's destination URL; e.g.
 * HomeLight's "Call me to claim referral" link; which plain text extraction
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
 * [noSendAfter, resumeAt) local time; the run defers to resumeAt and texts
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

/**
 * The external milestones a `goal` step can watch for (GHL-style Goal
 * Events). Mirrors GoalEventKind in _shared/ai_flows/types.ts.
 */
export const GOAL_EVENT_KINDS = ["replied", "appointment_booked", "tag_added", "claimed"] as const;
export type GoalEventKind = (typeof GOAL_EVENT_KINDS)[number];

/** Max watched milestones on one goal step. */
export const MAX_GOAL_EVENTS = 4;

/**
 * The operations a `math` step supports. Mirrors the runtime union in
 * _shared/ai_flows/types.ts.
 */
export const MATH_OPERATIONS = [
  "add",
  "subtract",
  "multiply",
  "divide",
  "round",
  "date_add_minutes",
  "date_diff_days"
] as const;
export type MathOperation = (typeof MATH_OPERATIONS)[number];

/** Max named arms on one branch step (plus the implicit else path). */
export const MAX_BRANCH_ARMS = 4;
/** Max branch nesting depth (a branch at depth 3 may not contain another). */
export const MAX_BRANCH_DEPTH = 3;
/** Max steps a definition may hold in total (trunk + every arm + every else). */
export const MAX_TOTAL_STEPS = 150;

/**
 * Flow-level time window: communication steps (send_sms / send_email /
 * notify_owner / route_to_team) only execute while the local time in
 * `timezone` is inside [start, end) on an allowed day; outside it the run
 * defers to the next open slot (same earliest_claim_at machinery as send_sms
 * quiet hours, which still apply on top per step).
 */
const flowTimeWindowSchema = z
  .object({
    timezone,
    start: hhmm,
    end: hhmm,
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional()
  })
  .refine((w) => w.start !== w.end, {
    message: "the time window can't start and end at the same time"
  });

/**
 * Every step type EXCEPT `branch`, as a plain members tuple. The branch step
 * is appended separately below because it references the full step union
 * recursively (its arms/else contain steps), which needs an explicitly-typed
 * lazy indirection to keep TypeScript's inference non-circular.
 */
const nonBranchStepMembers = [
  z.object({ id: stepId, type: z.literal("extract_url"), saveAs: varName, when: whenSchema.optional() }),
  z
    .object({
      id: stepId,
      type: z.literal("browse_extract"),
      urlVar: varName,
      // Either pull structured text fields, capture link hrefs by button text,
      // or both; but the step must do at least one (refined below).
      fields: z.array(extractFieldSchema).min(1).max(15).optional(),
      extractLinks: z.array(extractLinkSchema).min(1).max(10).optional(),
      auth: browseAuthSchema.optional(),
      screenshot: z.boolean().optional(),
      // Terminal-state guard (mirrors browse_action.skipWhenText): when the
      // fetched page contains this marker text (case-insensitive) there is
      // nothing to read (e.g. a lead another agent already claimed shows a
      // banner instead of the contact card), so the run ENDS gracefully; the
      // step is recorded "skipped" and the run finishes as done; instead of
      // extracting empty fields and failing downstream.
      skipWhenText: z.string().min(1).max(200).optional(),
      when: whenSchema.optional()
    })
    .refine((s) => (s.fields?.length ?? 0) > 0 || (s.extractLinks?.length ?? 0) > 0, {
      message: "browse_extract needs at least one of fields or extractLinks"
    }),
  // Browser-free sibling of browse_extract: pull the same structured fields out
  // of the inbound message text ({{trigger.windowText}}) instead of a fetched
  // page. No urlVar/auth/screenshot; the worker runs the SAME Gemini
  // extraction on the trigger text. Produces {{vars.<field>}} like browse_extract.
  z.object({
    id: stepId,
    type: z.literal("extract_text"),
    fields: z.array(extractFieldSchema).min(1).max(15),
    when: whenSchema.optional()
  }),
  // Read a recent message from a connected mailbox (the same Nango Gmail/Outlook
  // connections the email trigger + send_email "From" dropdown use) and run the
  // SAME Gemini extraction over it as extract_text; for pulling lead details out
  // of an alert email mid-flow (e.g. HomeLight's "Client Details" email as a
  // fallback when the portal contact card is delayed). The worker finds the most
  // recent inbox message whose sender contains `fromContains` AND whose text
  // contains EVERY rendered `matchTemplates` term (so e.g. first name AND city
  // both must appear; this disambiguates two leads who share a first name within
  // the window), within `lookbackMinutes`. With `fillOnlyEmpty`, a field is
  // written only when its var is currently empty/"none"; so an earlier
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
  // Read typed fields out of a DOCUMENT — the triggering email's PDF/text
  // attachment ({{trigger.document}}, the plan-time default when
  // sourceTemplate is omitted) — via Gemini's native PDF understanding.
  // Produces {{vars.<field>}} like extract_text; a trigger with no document
  // SKIPS the step gracefully (all-text emails must not fail the flow).
  // `fileAs` additionally files the source into Business Documents (condensed
  // through the same ingest pipeline as dashboard uploads) so it becomes
  // retrievable via business_knowledge_lookup and shareable via
  // share_document. This is the insurance back-office primitive: "when the
  // renewal notice arrives, read premium/deductible off the PDF and file it".
  z.object({
    id: stepId,
    type: z.literal("doc_extract"),
    // Template resolving to a document ref (an `email-attachments:<path>`
    // or `business-docs:<documentId>` value). Omitted = {{trigger.document}}.
    sourceTemplate: z.string().min(1).max(300).optional(),
    fields: z.array(extractFieldSchema).min(1).max(15),
    fileAs: z
      .object({
        titleTemplate: z.string().min(1).max(200),
        // Who the filed document is retrievable by (default staff — filed
        // back-office paperwork must not leak into customer-facing answers).
        audience: z.enum(["clients", "staff", "both"]).optional(),
        // ── Record sinks (all optional): make the filed copy a structured
        // contact RECORD, not just a library document. ──
        // Link to the contact whose phone this var holds — an earlier
        // step's var OR one of THIS step's own extracted fields (the
        // document itself often carries the customer's number). Scope rule
        // enforced in validateDefinitionSemantics.
        contactPhoneVar: varName.optional(),
        // Stamp the extracted fields onto record_fields (carrier, premium,
        // deductible, ... — whatever the step extracts).
        recordFieldsFromExtraction: z.boolean().optional(),
        // Parse this extracted field (must be one of the step's own field
        // names) as the record's renewal_date, feeding the renewal sweep +
        // escalation ladder.
        renewalDateField: varName.optional()
      })
      .optional(),
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
     * Attach the image URL held in this var (produced by an earlier
     * generate_image step) so the text goes out as MMS. An empty/unset var at
     * run time degrades to a plain text send — an image hiccup must not block
     * the message.
     */
    mediaUrlVar: varName.optional(),
    /**
     * Send to a single named roster member (ai_flow_team_members) instead of a
     * templated address; the worker resolves their current phone at run time,
     * so the number stays correct as the roster changes. When set, the body may
     * reference {{agent.name}}/{{agent.phone}} (the resolved member).
     */
    toAgentName: z.string().min(1).max(120).optional(),
    // Dynamic recipient: resolve a saved employee/contact's current phone at run
    // time. Mutually exclusive with to/toAgentName/replyToGroup (enforced in
    // validateDefinitionSemantics alongside the other recipient sources).
    toRef: contactRefSchema.optional(),
    when: whenSchema.optional()
  }),
  z.object({
    id: stepId,
    // WhatsApp outbound to a contact or teammate. Delivery routes through
    // the central helper: free-form text when the recipient's 24h service
    // window is open, the approved utility template otherwise (Meta bills
    // the tenant per template message; not-yet-approved templates skip
    // with an honest note). Requires a connected WhatsApp integration.
    type: z.literal("send_whatsapp"),
    // Exactly one of to / toAgentName / toRef (same rule as send_sms,
    // enforced in validateDefinitionSemantics).
    to: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(1600),
    toAgentName: z.string().min(1).max(120).optional(),
    toRef: contactRefSchema.optional(),
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
    /**
     * Template resolving to a `business-docs:<documentId>` ref to attach to
     * the send — a picked library document, or a run_agent-generated one via
     * `business-docs:{{vars.<saveAs>_document_id}}`. A blank rendered ref
     * sends without an attachment (mirrors document-less run_agent skips);
     * a ref that resolves to a missing/oversized document fails the step
     * loudly. Resend-path only, like attachScreenshot.
     */
    attachDocumentTemplate: z.string().min(1).max(300).optional(),
    fromConnectionId: z.string().uuid().optional(),
    when: whenSchema.optional()
  }),
  z.object({
    id: stepId,
    /**
     * Share a business document with the lead: mint an expiring tokenized
     * link for `documentId` and deliver it via SMS or email. The runtime
     * re-checks the document is ready, client-audience, and not expired —
     * a stale price sheet is never sent even if the flow was authored while
     * it was fresh. `{{share_url}}` in messageTemplate marks where the link
     * goes; without it the link is appended. `saveAs` exposes the link to
     * later steps.
     */
    type: z.literal("share_document"),
    /** business_documents row id (picked in the builder / bound by AI-assist). */
    documentId: z.string().uuid(),
    /** Editor display hint captured when the document was picked. */
    documentTitle: z.string().min(1).max(200).optional(),
    /** Recipient template: phone for via "sms", email address for via "email". */
    to: z.string().min(1).max(320),
    /** Delivery channel; defaults to "sms". */
    via: z.enum(["sms", "email"]).optional(),
    /** Message sent with the link; {{share_url}} marks placement. */
    messageTemplate: z.string().min(1).max(1600).optional(),
    /** Save the minted link into {{vars.<saveAs>}} for later steps. */
    saveAs: varName.optional(),
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
  // Text whoever the lead BELONGS to (e.g. forward a realtor.com reply relay):
  // the contact's owning employee when one is on record, else the business
  // owner. phoneVar (preferred) / nameVar locate the contact; both optional —
  // with neither resolvable the message still reaches the business owner.
  z.object({
    id: stepId,
    type: z.literal("notify_lead_owner"),
    message: z.string().min(1).max(1000),
    phoneVar: varName.optional(),
    nameVar: varName.optional(),
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
  // Pause the run then continue. Exactly one mode (enforced in
  // validateDefinitionSemantics — a discriminatedUnion member can't hold a
  // superRefine): relative minutes, a next local wall-clock time, an ISO
  // date/datetime rendered from a template ("wake on {{vars.renewal_date}}"),
  // or a template datetime plus a signed offset ("2 hours before the
  // appointment": relativeToTemplate {{trigger.starts_at}}, offsetMinutes
  // -120). 43200 min = 30 days — generous, but bounded so a typo can't park
  // a run for years.
  z.object({
    id: stepId,
    type: z.literal("sleep"),
    minutes: z.number().int().min(1).max(43200).optional(),
    untilTime: hhmm.optional(),
    timezone: timezone.optional(),
    untilDateTemplate: z.string().min(1).max(300).optional(),
    relativeToTemplate: z.string().min(1).max(300).optional(),
    offsetMinutes: z.number().int().min(-43200).max(43200).optional(),
    when: whenSchema.optional()
  }),
  // Arithmetic on numbers and dates: left <operation> right → {{vars.saveAs}},
  // usable by later when/branch conditions (lead scoring, "renewal within 30
  // days"). Unparseable operands (or divide-by-zero) save the sentinel
  // "not_a_number" instead of failing the run.
  z.object({
    id: stepId,
    type: z.literal("math"),
    operation: z.enum(MATH_OPERATIONS),
    left: z.string().min(1).max(300),
    right: z.string().min(1).max(300).optional(),
    saveAs: varName,
    when: whenSchema.optional()
  }),
  // Park the run until the phone in phoneVar texts back (reply lands in
  // {{vars.<saveAs>}}, default reply_text) or timeoutMinutes elapses
  // ({{vars.<saveAs>}} = "no_reply" → the no-reply branch; a named sentinel
  // because when-conditions require non-empty values). While parked, the
  // lead's next inbound SMS is owned by the flow (default AI reply suppressed).
  z.object({
    id: stepId,
    type: z.literal("wait_for_reply"),
    phoneVar: varName,
    saveAs: varName.optional(),
    timeoutMinutes: z.number().int().min(1).max(43200).optional(),
    // Dynamic timeout: a template rendering to whole minutes (e.g.
    // "{{vars.report_wait_minutes}}" produced by a math step). When it
    // renders to a positive number it wins; otherwise (empty, not_a_number)
    // the step falls back to timeoutMinutes / the 1440 default. Clamped to
    // the same 1..43200 range at run time.
    timeoutMinutesTemplate: z.string().min(1).max(300).optional(),
    when: whenSchema.optional()
  }),
  // Batch-flow outbound AI call: dial the phone in `toVar`, run the rendered
  // `personaTemplate` script on answer, then PARK the run (status
  // awaiting_call, same machinery as wait_for_reply) until the call ends. The
  // outcome lands in {{vars.<saveAs>}} (default "call_outcome"): transferred /
  // answered / no_answer / not_placed / failed — so later steps gate the next
  // follow-up attempt on it. With `transfer` configured, the AI texts the
  // transfer target the rendered preSmsTemplate pre-alert and warm-transfers
  // the live call to them once the callee confirms it's a good time. Budget is
  // enforced exactly like every outbound AI call (pre-dial probe +
  // authoritative post-dial reserve); a budget refusal defers and retries.
  // Cross-field rules (exactly one notify source; transfer needs exactly one
  // target) live in validateDefinitionSemantics.
  z.object({
    id: stepId,
    type: z.literal("place_ai_call"),
    /** Var holding the callee's phone (same scope rule as wait_for_reply.phoneVar). */
    toVar: varName,
    /** Greeting/script template the AI opens the call with. */
    personaTemplate: z.string().min(1).max(2000),
    /**
     * What the AI already knows about the person (templated) — injected into
     * the call prompt with a never-re-ask rule, so the AI doesn't ask for
     * details the flow already extracted.
     */
    contextTemplate: z.string().min(1).max(2000).optional(),
    // Post-call summary recipient: exactly one of notifyE164 / notifyRef.
    notifyE164: e164.optional(),
    notifyRef: contactRefSchema.optional(),
    transfer: z
      .object({
        // Exactly one of toE164 / toRef (validateDefinitionSemantics).
        toE164: e164.optional(),
        toRef: contactRefSchema.optional(),
        /** Pre-alert SMS texted to the transfer target as the transfer starts. */
        preSmsTemplate: z.string().min(1).max(1600).optional()
      })
      .optional(),
    /** Optional lead fields the AI captures during the call. */
    captureFields: z.array(z.string().min(1).max(60)).min(1).max(15).optional(),
    /** Outcome var name. Default "call_outcome". */
    saveAs: varName.optional(),
    when: whenSchema.optional()
  }),
  // Arm a short-lived "expect a live-transfer call" window: the worker upserts
  // the business's voice_expected_transfers row, and while it is unexpired and
  // unconsumed, telnyx-voice-inbound bridges any inbound call that matched NO
  // per-caller voice routing straight to the target (no AI conversation), then
  // consumes the window — one arming transfers exactly one call. Built for
  // referral services (e.g. Clever) whose concierges call from a rotating
  // number pool minutes after an SMS cue is confirmed. Exactly one of
  // toE164 / toRef (enforced in validateDefinitionSemantics).
  z.object({
    id: stepId,
    type: z.literal("arm_voice_transfer"),
    /** Destination the expected call is bridged to. */
    toE164: e164.optional(),
    /** Dynamic target: a saved employee/contact resolved at execution time. */
    toRef: contactRefSchema.optional(),
    /** How long the window stays armed. Default 20 minutes. */
    windowMinutes: z.number().int().min(1).max(120).optional(),
    /** Optional short greeting spoken to the caller before the bridge. */
    whisper: z.string().min(1).max(300).optional(),
    when: whenSchema.optional()
  }),
  // GHL-style Goal Event checkpoint: when a watched external milestone lands
  // for the run's lead (replied / appointment booked / tag added / claimed),
  // the run fast-forwards to this step and everything in between is skipped
  // (goal_jump) — "stop nurturing people who already converted". Trunk-only
  // and tag-required-for-tag_added are enforced in validateDefinitionSemantics.
  z.object({
    id: stepId,
    type: z.literal("goal"),
    label: z.string().min(1).max(120),
    events: z
      .array(
        z.object({
          kind: z.enum(GOAL_EVENT_KINDS),
          tag: z.string().min(1).max(40).optional()
        })
      )
      .min(1)
      .max(MAX_GOAL_EVENTS),
    when: whenSchema.optional()
  }),
  z.object({
    id: stepId,
    type: z.literal("route_to_team"),
    offerTemplate: z.string().min(1).max(1600),
    responseMinutes: z.number().int().min(1).max(1440).optional(),
    ownerFallbackTemplate: z.string().min(1).max(1600),
    claimedNotifyTemplate: z.string().min(1).max(1600).optional(),
    // Email copy of the claim outcome, sent at CLAIM FINALIZATION (worker),
    // so it also covers LATE claims ("1" up to 24h after the window lapsed)
    // and "86" releases, which never replay post-route steps and therefore
    // can never be reported by a flow-authored send_email step. Bounded like
    // send_email.to (not strict .email()) so it can carry a {{vars.x}}
    // template; the planner validates the rendered address and degrades to
    // SMS-only when it is undeliverable.
    claimedNotifyEmail: z.string().min(3).max(320).optional(),
    agentName: z.string().min(1).max(120).optional(),
    // DYNAMIC pin: the name of an earlier-produced var whose VALUE (e.g. an
    // extracted "I want Gabby to have this" answer) is resolved against the
    // ACTIVE roster at execution time (exact full name, exact first name,
    // then unique case-insensitive prefix). Empty/"none" means un-pinned:
    // the step routes exactly as if no pin were set. A non-empty value that
    // matches nobody falls through to the owner fallback, never to an
    // unintended teammate. Mutually exclusive with agentName/agentRef/
    // agentNames/broadcastAll (validateDefinitionSemantics). Structural (a
    // var NAME, not prose), so it survives library scrubbing where static
    // agentName pins are dropped.
    agentNameVar: varName.optional(),
    // Pin the offer to a saved roster member by reference (employee source only;
    // mutually exclusive with agentName; enforced in validateDefinitionSemantics).
    agentRef: contactRefSchema.optional(),
    // BROADCAST mode: offer the lead to ALL of these roster members at once,
    // sharing one claim deadline — first "1" wins, a "2" retires just that
    // teammate, and when everyone passed (or the deadline lapsed) the lead
    // falls back to the owner. Mutually exclusive with agentName/agentRef
    // (validateDefinitionSemantics); duplicates rejected there too.
    agentNames: z.array(z.string().min(1).max(120)).min(2).max(10).optional(),
    // BROADCAST-ALL mode: offer EVERY active, available roster member at
    // once — the roster is resolved at EXECUTION time so the offer set never
    // desyncs as employees change (the worker caps the fan-out at the same
    // 10 recipients agentNames allows, rotation order). Mutually exclusive
    // with agentName/agentRef/agentNames (validateDefinitionSemantics).
    // Only the literal `true` is accepted: absence IS the off state.
    broadcastAll: z.literal(true).optional(),
    offerWindow: routeOfferWindowSchema.optional(),
    attachScreenshot: z.boolean().optional(),
    // Offer reply digits are universal, not per-flow options: "1" claims (live
    // or late; "1, <eta>" adds a timeframe), "2" passes ("2, <reason>" adds
    // why), "86" retroactively unclaims. The old claimTimeframeOption /
    // lateClaimOption fields were removed after every stored flow was migrated
    // off them (scripts/oneshot/simplify-claim-options.ts).
    //
    // First to claim (ON by default; set false to opt out): while the offer is
    // live with one teammate, any teammate it was offered EARLIER can still
    // take it with a bare "1" — the lead needs a call right away, so whoever
    // can do it first wins. Only a bare "1" yanks; "1, <eta>" from outside the
    // sender's own window never preempts the active countdown.
    firstToClaim: z.boolean().optional(),
    // Keep-for-owner rule: when ownerDirectWhen matches on first entry (e.g.
    // price_band equals over_1m for $1M+ leads), the lead is NEVER offered to
    // the team — the owner is texted ownerDirectTemplate instead and
    // claimed_agent is set to "none" so claim-gated later steps skip. The two
    // fields are both-or-neither (validateDefinitionSemantics).
    ownerDirectWhen: whenSchema.optional(),
    ownerDirectTemplate: z.string().min(1).max(1600).optional(),
    // Keep-for-owner nudges: after the ownerDirect alert, the run parks and
    // the owner gets an ALL-CAPS reminder at 10 minutes and a final one at
    // 30 minutes unless they reply "1" (which acks and stops the nudges).
    // Only meaningful alongside ownerDirectWhen (validateDefinitionSemantics).
    ownerDirectNudges: z.boolean().optional(),
    // Owner-first routing for repeat leads: when the lead's contact already
    // has an owning employee, offer them first, then the normal cascade.
    preferContactOwner: z.boolean().optional(),
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
    // another agent already claimed) so the run ENDS gracefully; the step is
    // recorded "skipped" and the run finishes as done; instead of failing.
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
  // Generate an AI image from a prompt template and save a signed URL to the
  // stored image as {{vars.<saveAs>}} — consumable by a later send_sms
  // (mediaUrlVar → MMS) or embedded in a send_email body. Metered into the
  // shared AI budget at the flat per-image price; hard-refused when the
  // budget is exhausted. AiFlow runs are exempt from the conversational
  // 3-per-session limit (flows are owner-authored and explicitly enabled).
  z.object({
    id: stepId,
    type: z.literal("generate_image"),
    promptTemplate: z.string().min(1).max(2000),
    /**
     * Optional source image to EDIT instead of generating from scratch:
     * a template resolving to {{trigger.image}} (the photo attached to the
     * triggering MMS/email) or an earlier step's image var. Renders empty →
     * the step generates from scratch; renders to an unusable reference →
     * the step fails (silently ignoring the owner's source image would be
     * worse). The worker only fetches platform-controlled sources (own
     * storage buckets + Telnyx media CDN) — never arbitrary URLs.
     */
    inputImageTemplate: z.string().min(1).max(500).optional(),
    saveAs: varName,
    when: whenSchema.optional()
  }),
  // Run a saved Agent (a reusable instruction set from /dashboard/agents)
  // against flow content: either the rendered `input` template (text) or a
  // DOCUMENT (`documentTemplate`, an email-attachments:<path> /
  // business-docs:<id> ref — default {{trigger.document}}) is handed to the
  // agent's instructions on central Gemini and the produced artifact lands
  // in {{vars.<saveAs>}} for later steps (send_email body, notify_owner,
  // extract_text, ...). Exactly one of input/documentTemplate (enforced in
  // validateDefinitionSemantics). `saveDocument` additionally files the
  // artifact into Business Documents (staff-only audience — an automated
  // run must never widen output to customer channels). Metered into the
  // shared AI budget. The write-time validator (validateRunAgentSteps)
  // checks the agent exists and is enabled; the runtime re-checks at
  // execution.
  z.object({
    id: stepId,
    type: z.literal("run_agent"),
    /** business_agents row id (picked in the builder / bound by AI-assist). */
    agentId: z.string().uuid(),
    /** Editor display hint captured when the agent was picked. */
    agentName: z.string().min(1).max(120).optional(),
    /** Template rendered into the agent's input (e.g. "{{trigger.windowText}}"). */
    input: z.string().min(1).max(8000).optional(),
    /**
     * Template resolving to a document ref the agent runs on instead of
     * text — usually {{trigger.document}} (the triggering email's PDF/text
     * attachment); a trigger with no document SKIPS the step gracefully.
     */
    documentTemplate: z.string().min(1).max(300).optional(),
    /** File the artifact into Business Documents (title template). */
    saveDocument: z
      .object({
        titleTemplate: z.string().min(1).max(200)
      })
      .optional(),
    /** The artifact lands in {{vars.<saveAs>}}. */
    saveAs: varName,
    when: whenSchema.optional()
  }),
  // Classify a message into exactly one author-defined category (or the
  // reserved "unclear" fallback) so branches fork on MEANING. Values are
  // var-name-shaped tokens so when/branch conditions match them exactly;
  // "unclear" is reserved for the fallback and can't be an authored value
  // (enforced in validateDefinitionSemantics).
  z.object({
    id: stepId,
    type: z.literal("classify"),
    textVar: varName.optional(),
    question: z.string().min(1).max(300).optional(),
    categories: z
      .array(
        z.object({
          value: varName,
          description: z.string().min(1).max(200).optional()
        })
      )
      .min(2)
      .max(8),
    saveAs: varName,
    when: whenSchema.optional()
  }),
  // Maintain the contact's lead-state tags from a flow: removals apply before
  // additions ("removeTags New Lead, addTags Contacted" = one status change).
  // At least one of addTags/removeTags is required (validateDefinitionSemantics
  // — a discriminatedUnion member can't hold a refine). Tag strings mirror the
  // dashboard limits (40 chars, 25 per list).
  z.object({
    id: stepId,
    type: z.literal("update_contact"),
    phoneVar: varName,
    addTags: z.array(z.string().min(1).max(40)).min(1).max(25).optional(),
    removeTags: z.array(z.string().min(1).max(40)).min(1).max(25).optional(),
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
    // Exactly one of toE164 / toRef supplies the number to ring (enforced in
    // validateVoiceFlow; a discriminatedUnion member can't hold a refine).
    toE164: e164.optional(),
    // Dynamic dial target: a saved employee/contact whose CURRENT number is
    // resolved just before the voice flow compiles (resolve-before-compile).
    toRef: contactRefSchema.optional(),
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
    // Exactly one of notifyE164 / notifyRef (enforced in validateVoiceFlow).
    notifyE164: e164.optional(),
    // Dynamic summary recipient (saved employee/contact, resolved live).
    notifyRef: contactRefSchema.optional(),
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
    // Exactly one of toE164 / toRef (enforced in validateVoiceFlow).
    toE164: e164.optional(),
    // Dynamic transfer target (saved employee/contact, resolved live).
    toRef: contactRefSchema.optional(),
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
    // Default callee: at most one of toE164 / toRef (both optional; the
    // "Place call" entry point may supply the callee per call).
    toE164: e164.optional(),
    toRef: contactRefSchema.optional(),
    // Exactly one of notifyE164 / notifyRef (enforced in validateVoiceFlow).
    notifyE164: e164.optional(),
    notifyRef: contactRefSchema.optional(),
    persona: z.string().min(1).max(500).optional(),
    captureFields: z.array(z.string().min(1).max(60)).min(1).max(15).optional(),
    when: whenSchema.optional()
  })
] as const;

/** The non-branch step union — everything the flat (pre-branch) engine ran. */
const nonBranchStepSchema = z.discriminatedUnion("type", [...nonBranchStepMembers]);

export type StepCondition = z.infer<typeof whenSchema>;
type NonBranchStep = z.infer<typeof nonBranchStepSchema>;

/**
 * Branch types are declared BY HAND (mirroring the runtime types in
 * supabase/functions/_shared/ai_flows/types.ts) because they reference the
 * full step union recursively — TypeScript cannot infer a type that circularly
 * references itself through zod's generics, so the schema below is checked
 * against these declarations via the annotated lazy indirection instead.
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
 * Multi-way branch (GHL-style If/Else): arms are evaluated top to bottom
 * against run vars, the FIRST match wins, and no match runs the `else` steps.
 * Nesting/total-step caps and arm-id uniqueness live in
 * validateDefinitionSemantics (they need the whole tree). A `when` guard on
 * the branch itself skips the WHOLE branch (choice never recorded, so every
 * arm and the else are skipped as branch_not_taken).
 */
export type BranchStep = {
  id: string;
  type: "branch";
  question: string;
  branches: BranchArm[];
  else: FlowStep[];
  when?: StepCondition;
};

export type FlowStep = NonBranchStep | BranchStep;

/** Lazy, explicitly-typed recursion point: a nested step list inside a branch. */
const nestedStepListSchema: z.ZodType<FlowStep[]> = z.lazy(() => z.array(stepSchema).max(25));

const branchArmSchema: z.ZodType<BranchArm> = z.object({
  id: stepId,
  label: z.string().min(1).max(80),
  condition: whenSchema,
  steps: nestedStepListSchema
});

const branchStepSchema = z.object({
  id: stepId,
  type: z.literal("branch"),
  question: z.string().min(1).max(200),
  branches: z.array(branchArmSchema).min(1).max(MAX_BRANCH_ARMS),
  else: nestedStepListSchema,
  when: whenSchema.optional()
});

const stepSchema: z.ZodType<FlowStep> = z.discriminatedUnion("type", [
  ...nonBranchStepMembers,
  branchStepSchema
]);

export const aiFlowDefinitionSchema = z.object({
  version: z.literal(1),
  trigger: triggerSchema,
  // Additional triggers (OR semantics): the flow starts when ANY of
  // [trigger, ...triggers] fires. Capped at 4 extras (5 total). Voice is
  // excluded from the set (single-trigger; enforced in semantics).
  triggers: z.array(triggerSchema).max(4).optional(),
  steps: z.array(stepSchema).min(1).max(25),
  timeWindow: flowTimeWindowSchema.optional(),
  // Drip pacing for bulk enqueues: consecutive runs start at least
  // intervalMinutes apart (earliest_claim_at stagger at enqueue time).
  drip: z
    .object({
      intervalMinutes: z.number().int().min(1).max(1440)
    })
    .optional(),
  options: z
    .object({
      suppressDefaultReply: z.boolean().optional(),
      // Per-flow opt-in: capture a screenshot on every browse step (and a
      // before/at-failure pair when a browse_action breaks) for the run
      // "investigate" view. Default off so most flows pay no extra latency.
      captureStepScreenshots: z.boolean().optional(),
      // GHL "stop on response": an inbound SMS from the lead cancels their
      // pending runs of this flow (the run whose wait_for_reply consumed the
      // reply is exempt). Default off.
      stopOnResponse: z.boolean().optional(),
      // GHL "allow re-entry": explicitly false blocks enrolling a contact
      // who already has a run of this flow. Default (undefined) = allowed.
      allowReentry: z.boolean().optional(),
      // Post-extraction lead dedupe: when true, a run whose extracted lead
      // identity (vars.lead_phone / vars.lead_email, contact-expanded) plus
      // property (vars.lead_address, when both runs have one) matches an
      // earlier non-failed run of this flow is canceled BEFORE its first
      // communication step. Complements allowReentry, which keys on the
      // trigger SENDER and can't see relay texts (e.g. realtor.com's
      // notifications arrive with an empty/shared sender). Default off.
      dedupeLeadRuns: z.boolean().optional(),
      // Owner opt-in for the texting coworker's start_aiflow_for_contact
      // tool: when true, the SMS model may enroll the CURRENT texter into
      // this flow. Default off — the customer-facing surface stays barred
      // from every flow the owner has not explicitly flagged.
      agentInvocable: z.boolean().optional()
    })
    .optional()
});

export type TriggerCondition = z.infer<typeof conditionSchema>;
export type FlowTrigger = z.infer<typeof triggerSchema>;
export type FlowTimeWindow = z.infer<typeof flowTimeWindowSchema>;
export type AiFlowDefinition = z.infer<typeof aiFlowDefinitionSchema>;

/** The trigger channels the builder offers. */
export const TRIGGER_CHANNELS = [
  "sms",
  "manual",
  "schedule",
  "email",
  "tenant_email",
  "webhook",
  "calendar",
  "contact_created",
  "tag_changed",
  "owner_assigned",
  "birthday",
  "voice"
] as const;

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

/**
 * The literal token a share_document messageTemplate uses to place the
 * minted link. NOT a scope reference — the worker substitutes it after
 * template rendering — so the scope checker strips it first (and the
 * runtime planner shares this regex).
 */
export const SHARE_URL_TOKEN_RE = /\{\{\s*share_url\s*\}\}/g;

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
    case "send_whatsapp":
      return [step.to ?? "", step.body];
    case "send_email":
      return [
        step.to,
        ...(step.cc ?? []),
        ...(step.bcc ?? []),
        step.subject,
        step.body,
        step.attachDocumentTemplate ?? ""
      ];
    // The {{share_url}} placement token is substituted by the worker after
    // rendering (it is not a scope reference), so strip it before the
    // scope check; everything else in the message is a normal template.
    case "share_document":
      return [step.to, (step.messageTemplate ?? "").replace(SHARE_URL_TOKEN_RE, "")];
    case "notify_owner":
      return [step.message];
    case "notify_lead_owner":
      return [step.message];
    case "approval_gate":
      return [step.prompt];
    case "http_call":
      return [step.path ?? "", step.bodyTemplate ?? ""];
    case "route_to_team":
      return [
        step.offerTemplate,
        step.ownerFallbackTemplate,
        step.claimedNotifyTemplate ?? "",
        step.claimedNotifyEmail ?? "",
        step.ownerDirectTemplate ?? ""
      ];
    case "browse_action":
      return step.actions.map((a) => a.valueTemplate ?? "");
    case "email_extract":
      return step.matchTemplates ?? [];
    // The document source and the filing title are ordinary templates (the
    // source usually references {{trigger.document}}).
    case "doc_extract":
      return [step.sourceTemplate ?? "", step.fileAs?.titleTemplate ?? ""];
    // math operands and sleep's date templates reference vars/trigger fields,
    // so they get the same scope checking as any other template.
    case "math":
      return [step.left, step.right ?? ""];
    case "sleep":
      return [step.untilDateTemplate ?? "", step.relativeToTemplate ?? ""];
    case "generate_image":
      return [step.promptTemplate, step.inputImageTemplate ?? ""];
    case "run_agent":
      return [step.input ?? "", step.documentTemplate ?? "", step.saveDocument?.titleTemplate ?? ""];
    // The call script, known-details note, and transfer pre-alert all render
    // against run vars.
    case "place_ai_call":
      return [step.personaTemplate, step.contextTemplate ?? "", step.transfer?.preSmsTemplate ?? ""];
    // wait_for_reply's dynamic timeout template references vars (e.g. a math
    // step's output), so it gets the same scope checking as any other template.
    case "wait_for_reply":
      return [step.timeoutMinutesTemplate ?? ""];
    case "extract_url":
    case "browse_extract":
    case "extract_text":
    case "recall_url":
    case "upsert_customer":
    // update_contact carries literal tag strings and a var NAME — no templates.
    case "update_contact":
    // classify carries var NAMES, category tokens, and a plain-text question.
    case "classify":
    // goal carries a display label and literal event kinds/tags — no templates.
    case "goal":
    // branch: the question/labels are display copy and the conditions are
    // var-name references (scope-checked in validateDefinitionSemantics), so
    // there is nothing to template-check on the step itself. Nested arm steps
    // are walked separately.
    case "branch":
    // arm_voice_transfer carries literal numbers/refs and a whisper string —
    // no templates.
    case "arm_voice_transfer":
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
 *     voice_ai_intake); the two shapes never mix;
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
      `Step "${s.id}" is a "${s.type}" step but this is a voice flow; voice flows use only ring_handoff, voice_ai_intake, voice_transfer, or outbound_call.`
    );
  }
  // If any non-voice step slipped in, the shape rules below would be misleading.
  if (nonVoice.length > 0) return issues;

  // Per-step number sources: each dial/notify target is EITHER a hardcoded
  // E.164 OR a dynamic contact reference (resolved live just before the call
  // routes), never both and never neither; a step with no resolvable number
  // would strand the caller. Checked before the shape rules (which have early
  // returns) so every step gets a source check regardless of flow shape.
  for (const s of steps) {
    if (s.type === "ring_handoff" || s.type === "voice_transfer") {
      const sources = [Boolean(s.toE164), Boolean(s.toRef)].filter(Boolean).length;
      if (sources !== 1) {
        issues.push(
          sources === 0
            ? `Step "${s.id}" has no number to ring; set toE164 or pick a saved contact (toRef).`
            : `Step "${s.id}" sets both toE164 and toRef; use only one.`
        );
      }
    }
    if (s.type === "voice_ai_intake" || s.type === "outbound_call") {
      const notifySources = [Boolean(s.notifyE164), Boolean(s.notifyRef)].filter(Boolean).length;
      if (notifySources !== 1) {
        issues.push(
          notifySources === 0
            ? `Step "${s.id}" has nowhere to send the call summary; set notifyE164 or pick a saved contact (notifyRef).`
            : `Step "${s.id}" sets both notifyE164 and notifyRef; use only one.`
        );
      }
      // outbound_call's default callee is optional (the "Place call" entry may
      // supply it per call) but still at most ONE source.
      if (s.type === "outbound_call" && s.toE164 && s.toRef) {
        issues.push(`Step "${s.id}" sets both toE164 and toRef; use only one.`);
      }
    }
  }

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
  if (!trigger.fromE164 && !trigger.fromRef) {
    issues.push(
      "An inbound voice flow needs a caller; set fromE164 or pick a saved contact (fromRef) on its trigger."
    );
  } else if (trigger.fromE164 && trigger.fromRef) {
    issues.push("The trigger sets both fromE164 and fromRef; use only one.");
  }

  const transfers = steps.filter((s) => s.type === "voice_transfer");
  const rings = steps.filter((s) => s.type === "ring_handoff");
  const intakes = steps.filter((s) => s.type === "voice_ai_intake");

  if (transfers.length > 0) {
    // Blind-transfer flow: it must be the ONLY step.
    if (steps.length !== 1) {
      issues.push(
        "A voice_transfer flow connects the caller straight to one number; it must be the only step (no ring_handoff/voice_ai_intake)."
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
        "voice_ai_intake must be the last step; it only takes over after every ring_handoff missed."
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

  // A from_matches trigger condition needs EXACTLY ONE sender source: a
  // literal `value` or a saved-contact `ref` (the discriminatedUnion member
  // can't hold a refine). Applies to every condition-bearing channel, across
  // the whole trigger set.
  const allTriggers = [def.trigger, ...(def.triggers ?? [])];
  for (const trig of allTriggers) {
    const trigConditions = (trig as { conditions?: TriggerCondition[] }).conditions ?? [];
    for (const c of trigConditions) {
      if (c.type !== "from_matches") continue;
      if (!c.value && !c.ref) {
        issues.push(
          'A "from matches" condition needs a sender; enter text or pick a saved contact.'
        );
      } else if (c.value && c.ref) {
        issues.push(
          'A "from matches" condition sets both a text value and a saved contact; use only one.'
        );
      }
    }
  }

  // Voice stays single-trigger: it runs on the real-time call path (the
  // telnyx-voice-inbound webhook), not the batch worker, so it can neither
  // join an OR set nor carry one.
  if (def.triggers && def.triggers.length > 0) {
    if (def.trigger.channel === "voice" || def.triggers.some((t) => t.channel === "voice")) {
      issues.push(
        "A voice flow uses exactly one trigger; remove the additional triggers (voice runs on the live call path)."
      );
    }
  }

  // Voice flows run on the real-time call path and have no vars/templates; they
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

  const vars = new Set<string>();
  // True once an earlier browse step (browse_extract or browse_action) has
  // `screenshot: true`; the prerequisite for any later step's attachScreenshot.
  let screenshotCaptured = false;
  // Every step in the tree (trunk + every branch arm + every else), for the
  // definition-wide total cap.
  let totalSteps = 0;

  // Walk one step, then (for a branch) its arms and else — the same
  // depth-first order the worker flattens to, so "an EARLIER step" means the
  // same thing at author time and run time. Var registration is deliberately
  // PERMISSIVE across arms: a var produced inside one arm is legal for any
  // later step (at run time an untaken arm's var resolves to "" and the
  // consuming step degrades/skips, same as any missing extraction).
  const visitStep = (step: FlowStep, depth: number): void => {
    totalSteps += 1;
    if (seenIds.has(step.id)) {
      issues.push(`Duplicate step id "${step.id}".`);
    }
    seenIds.add(step.id);

    // A voice step under a non-voice trigger can never execute (the batch
    // worker has no handler for it); reject rather than silently no-op.
    if (VOICE_STEPS.has(step.type)) {
      issues.push(
        `Step "${step.id}" is a voice step ("${step.type}") but the trigger is "${def.trigger.channel}"; voice steps need a voice trigger.`
      );
    }

    if (step.type === "branch") {
      if (depth >= MAX_BRANCH_DEPTH) {
        issues.push(
          `Step "${step.id}" nests branches more than ${MAX_BRANCH_DEPTH} levels deep; flatten the flow instead.`
        );
      }
      const armIds = new Set<string>();
      for (const arm of step.branches) {
        if (armIds.has(arm.id) || arm.id === "else") {
          issues.push(
            arm.id === "else"
              ? `Step "${step.id}" names a branch "else", which is reserved for the none-matched path.`
              : `Step "${step.id}" has two branches with the id "${arm.id}".`
          );
        }
        armIds.add(arm.id);
        // Same scope rule as a `when` guard: the arm condition may only test a
        // var an EARLIER step produced.
        if (!vars.has(arm.condition.var) && !ENGINE_VARS.has(arm.condition.var)) {
          issues.push(
            `Step "${step.id}" branch "${arm.label}" tests {{vars.${arm.condition.var}}} which no earlier step produces.`
          );
        }
      }
      if (step.when && !vars.has(step.when.var) && !ENGINE_VARS.has(step.when.var)) {
        issues.push(
          `Step "${step.id}" has a "when" condition on {{vars.${step.when.var}}} which no earlier step produces.`
        );
      }
      for (const arm of step.branches) walkSteps(arm.steps, depth + 1);
      walkSteps(step.else, depth + 1);
      return;
    }

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
            ((step.type === "send_sms" || step.type === "send_whatsapp") &&
              (Boolean(step.toAgentName) || step.toRef?.source === "employee"));
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
    // URL) don't apply; reject the combination rather than silently ignore it.
    if (step.type === "browse_action" && step.forEachLink) {
      if (step.fields && step.fields.length > 0) {
        issues.push(
          `Step "${step.id}" can't combine forEachLink with fields; extraction has no single page in a loop.`
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
          `Step "${step.id}" recalls a URL but has no key source; set keyFromTrigger or keyVars.`
        );
      }
      if (step.keyFromTrigger === "participants" && def.trigger.channel !== "sms") {
        issues.push(
          `Step "${step.id}" recalls by group participants, which only works on an SMS-triggered flow.`
        );
      }
    }

    // sleep: exactly one wait mode — relative minutes, untilTime (+ its
    // timezone), an untilDate template, or a relativeTo template (+ its
    // offset). Mixing modes (or half a mode) would silently pick one at run
    // time, so reject at author time instead.
    if (step.type === "sleep") {
      const relative = step.minutes !== undefined;
      const daily = step.untilTime !== undefined || step.timezone !== undefined;
      const untilDate = step.untilDateTemplate !== undefined;
      const relativeTo =
        step.relativeToTemplate !== undefined || step.offsetMinutes !== undefined;
      const modes = [relative, daily, untilDate, relativeTo].filter(Boolean).length;
      if (modes > 1) {
        issues.push(
          `Step "${step.id}" mixes wait modes; use exactly one of minutes, untilTime, untilDateTemplate, or relativeToTemplate.`
        );
      } else if (modes === 0) {
        issues.push(
          `Step "${step.id}" needs a wait: set minutes, untilTime + timezone, untilDateTemplate, or relativeToTemplate + offsetMinutes.`
        );
      } else if (daily && (step.untilTime === undefined || step.timezone === undefined)) {
        issues.push(`Step "${step.id}" needs both untilTime and timezone for a time-of-day wait.`);
      } else if (relativeTo && step.relativeToTemplate === undefined) {
        issues.push(
          `Step "${step.id}" sets offsetMinutes but no relativeToTemplate to offset from.`
        );
      } else if (relativeTo && step.offsetMinutes === undefined) {
        issues.push(
          `Step "${step.id}" needs offsetMinutes with relativeToTemplate (negative = before it).`
        );
      }
    }

    // math: every operation except `round` needs its right operand.
    if (step.type === "math") {
      if (step.operation === "round" && step.right !== undefined) {
        issues.push(`Step "${step.id}" rounds its left value; remove the unused right operand.`);
      }
      if (step.operation !== "round" && step.right === undefined) {
        issues.push(
          `Step "${step.id}" needs a right operand for "${step.operation}".`
        );
      }
    }

    // wait_for_reply watches the phone an EARLIER step produced (same scope
    // rule as upsert_customer.phoneVar).
    if (
      step.type === "wait_for_reply" &&
      !vars.has(step.phoneVar) &&
      !ENGINE_VARS.has(step.phoneVar)
    ) {
      issues.push(
        `Step "${step.id}" waits for a reply from {{vars.${step.phoneVar}}} which no earlier step produces.`
      );
    }

    // notify_lead_owner locates the contact via vars an EARLIER step produced.
    if (step.type === "notify_lead_owner") {
      for (const [field, varRef] of [
        ["phoneVar", step.phoneVar],
        ["nameVar", step.nameVar]
      ] as const) {
        if (varRef && !vars.has(varRef) && !ENGINE_VARS.has(varRef)) {
          issues.push(
            `Step "${step.id}" ${field} references {{vars.${varRef}}} which no earlier step produces.`
          );
        }
      }
    }

    // place_ai_call: the callee var must exist (same scope rule as
    // wait_for_reply.phoneVar); the post-call summary needs exactly one
    // recipient source; a transfer needs exactly one target source.
    if (step.type === "place_ai_call") {
      if (!vars.has(step.toVar) && !ENGINE_VARS.has(step.toVar)) {
        issues.push(
          `Step "${step.id}" calls {{vars.${step.toVar}}} which no earlier step produces.`
        );
      }
      const notifySources = [Boolean(step.notifyE164), Boolean(step.notifyRef)].filter(
        Boolean
      ).length;
      if (notifySources !== 1) {
        issues.push(
          notifySources === 0
            ? `Step "${step.id}" has nowhere to send the call summary; set notifyE164 or pick a saved contact (notifyRef).`
            : `Step "${step.id}" sets both notifyE164 and notifyRef; use only one.`
        );
      }
      if (step.transfer) {
        const targets = [Boolean(step.transfer.toE164), Boolean(step.transfer.toRef)].filter(
          Boolean
        ).length;
        if (targets !== 1) {
          issues.push(
            targets === 0
              ? `Step "${step.id}" configures a live transfer with no target; set transfer.toE164 or pick a saved contact (transfer.toRef).`
              : `Step "${step.id}" sets both transfer.toE164 and transfer.toRef; use only one.`
          );
        }
      }
    }

    // arm_voice_transfer: the expected call needs exactly one target source.
    if (step.type === "arm_voice_transfer") {
      const targets = [Boolean(step.toE164), Boolean(step.toRef)].filter(Boolean).length;
      if (targets !== 1) {
        issues.push(
          targets === 0
            ? `Step "${step.id}" arms a transfer window with no target; set toE164 or pick a saved contact (toRef).`
            : `Step "${step.id}" sets both toE164 and toRef; use only one.`
        );
      }
    }

    // classify: the text var (when set) must exist, category values must be
    // unique, and "unclear" is reserved for the nothing-fits fallback.
    if (step.type === "classify") {
      if (step.textVar && !vars.has(step.textVar) && !ENGINE_VARS.has(step.textVar)) {
        issues.push(
          `Step "${step.id}" classifies {{vars.${step.textVar}}} which no earlier step produces.`
        );
      }
      const seenValues = new Set<string>();
      for (const c of step.categories) {
        const key = c.value.toLowerCase();
        if (key === "unclear") {
          issues.push(
            `Step "${step.id}" uses the reserved category "unclear" (it's the automatic nothing-fits fallback); pick another value.`
          );
        }
        if (seenValues.has(key)) {
          issues.push(`Step "${step.id}" lists the category "${c.value}" more than once.`);
        }
        seenValues.add(key);
      }
    }

    // goal: trunk-only (a jump onto an unevaluated branch path would be
    // unsafe), and each watched event must be fully specified — tag_added
    // needs its tag, and a tag on any other kind is a config mistake.
    if (step.type === "goal") {
      if (depth > 0) {
        issues.push(
          `Step "${step.id}" is a goal checkpoint inside a branch; goals must sit on the main path.`
        );
      }
      for (const ev of step.events) {
        if (ev.kind === "tag_added" && !(ev.tag ?? "").trim()) {
          issues.push(
            `Step "${step.id}" watches for a tag being added but names no tag; set the tag.`
          );
        }
        if (ev.kind !== "tag_added" && ev.tag !== undefined) {
          issues.push(
            `Step "${step.id}" sets a tag on a "${ev.kind}" goal event; tags only apply to "tag_added".`
          );
        }
        // Contradiction guard: a "replied" goal wants the run to CONTINUE at
        // the checkpoint when the lead replies, while stopOnResponse wants
        // that same reply to CANCEL the run. Refuse the combination so the
        // runtime never has to pick one silently.
        if (ev.kind === "replied" && def.options?.stopOnResponse === true) {
          issues.push(
            `Step "${step.id}" watches for a reply, but this flow is set to stop when the contact replies; turn off "stop on response" or remove the replied goal.`
          );
        }
      }
    }

    // update_contact: the phone var must exist, and the step must actually
    // change something (at least one of addTags/removeTags — the union member
    // can't hold that refine).
    if (step.type === "update_contact") {
      if (!vars.has(step.phoneVar) && !ENGINE_VARS.has(step.phoneVar)) {
        issues.push(
          `Step "${step.id}" updates a contact using {{vars.${step.phoneVar}}} which no earlier step produces.`
        );
      }
      if (!step.addTags && !step.removeTags) {
        issues.push(
          `Step "${step.id}" updates a contact but changes nothing; set addTags and/or removeTags.`
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

    // The owner-mailbox send path is plain text (Nango Gmail/Outlook);
    // attachments (screenshot or document) only exist on the AI coworker's
    // own Resend path.
    if (
      step.type === "send_email" &&
      (step.attachScreenshot || step.attachDocumentTemplate) &&
      step.fromConnectionId
    ) {
      issues.push(
        `Step "${step.id}" attaches a file but sends from a connected mailbox; attachments are only supported when sending from your AI coworker's email.`
      );
    }

    // A send_sms needs EXACTLY ONE recipient source: a templated `to`, a named
    // roster member (`toAgentName`), or `replyToGroup` (reply into the inbound
    // group thread). replyToGroup only makes sense for an SMS-triggered flow
    // that can carry participants.
    if (step.type === "send_sms") {
      // `to` is either absent or (by schema) a non-empty string, so a truthy
      // `to` means a recipient is configured. `toRef` is a fourth source (a
      // saved employee/contact resolved to a number at run time).
      const sources = [
        Boolean(step.to),
        Boolean(step.toAgentName),
        Boolean(step.replyToGroup),
        Boolean(step.toRef)
      ];
      const count = sources.filter(Boolean).length;
      if (count === 0) {
        issues.push(
          `Step "${step.id}" sends a text but has no recipient; set "to", "toAgentName", "toRef", or turn on replyToGroup.`
        );
      } else if (count > 1) {
        issues.push(
          `Step "${step.id}" sets more than one recipient; use only one of "to", "toAgentName", "toRef", or replyToGroup.`
        );
      }
      if (step.replyToGroup && def.trigger.channel !== "sms") {
        issues.push(
          `Step "${step.id}" replies to a group thread, which only works on an SMS-triggered flow.`
        );
      }
    }

    // A send_whatsapp needs EXACTLY ONE recipient source (same rule as
    // send_sms, minus replyToGroup — WhatsApp has no group-MMS reply path).
    if (step.type === "send_whatsapp") {
      const waSources = [Boolean(step.to), Boolean(step.toAgentName), Boolean(step.toRef)];
      const waCount = waSources.filter(Boolean).length;
      if (waCount === 0) {
        issues.push(
          `Step "${step.id}" sends a WhatsApp message but has no recipient; set "to", "toAgentName", or "toRef".`
        );
      } else if (waCount > 1) {
        issues.push(
          `Step "${step.id}" sets more than one recipient; use only one of "to", "toAgentName", or "toRef".`
        );
      }
    }

    // A run_agent needs EXACTLY ONE input source: rendered text (`input`)
    // or a document ref (`documentTemplate`). Enforced here because a
    // discriminatedUnion member can't hold a refine.
    if (step.type === "run_agent") {
      if (!step.input && !step.documentTemplate) {
        issues.push(
          `Step "${step.id}" runs an agent but has nothing to run it on; set "input" (text) or "documentTemplate" (a document).`
        );
      } else if (step.input && step.documentTemplate) {
        issues.push(
          `Step "${step.id}" sets both "input" and "documentTemplate"; use only one.`
        );
      }
    }

    // doc_extract record sinks: the contact phone may come from an earlier
    // step's var OR from one of THIS step's own extracted fields (the
    // document often carries the customer's number — extraction precedes
    // filing at runtime). The renewal date is extraction-only.
    if (step.type === "doc_extract" && step.fileAs) {
      const ownFields = new Set(step.fields.map((f) => f.name));
      if (
        step.fileAs.contactPhoneVar &&
        !vars.has(step.fileAs.contactPhoneVar) &&
        !ENGINE_VARS.has(step.fileAs.contactPhoneVar) &&
        !ownFields.has(step.fileAs.contactPhoneVar)
      ) {
        issues.push(
          `Step "${step.id}" links the filed document to {{vars.${step.fileAs.contactPhoneVar}}}, which no earlier step or extracted field produces.`
        );
      }
      if (step.fileAs.renewalDateField && !ownFields.has(step.fileAs.renewalDateField)) {
        issues.push(
          `Step "${step.id}" reads the renewal date from "${step.fileAs.renewalDateField}", which is not one of the step's extracted fields.`
        );
      }
    }

    // The MMS attachment reads the image URL from a var an EARLIER
    // generate_image step must have produced (same scope rule as urlVar).
    if (
      step.type === "send_sms" &&
      step.mediaUrlVar &&
      !vars.has(step.mediaUrlVar) &&
      !ENGINE_VARS.has(step.mediaUrlVar)
    ) {
      issues.push(
        `Step "${step.id}" attaches an image from {{vars.${step.mediaUrlVar}}} which no earlier step produces.`
      );
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

    // route_to_team pins an offer to ONE roster member: by name (agentName) or by
    // a saved reference (agentRef). Use at most one, and a ref must be an EMPLOYEE
    //; a contact is not on the roster and could never claim the offer.
    if (step.type === "route_to_team") {
      if (step.agentName && step.agentRef) {
        issues.push(
          `Step "${step.id}" pins to both agentName and agentRef; use only one.`
        );
      }
      if (step.agentRef && step.agentRef.source !== "employee") {
        issues.push(
          `Step "${step.id}" routes to a contact, but route_to_team can only pin a team member; use an employee reference.`
        );
      }
      // Broadcast mode is exclusive with the single-agent pins: mixing them
      // would leave the worker with two contradictory offer sets.
      if (step.agentNames && (step.agentName || step.agentRef)) {
        issues.push(
          `Step "${step.id}" sets agentNames alongside agentName/agentRef; broadcast and single-agent pinning are mutually exclusive.`
        );
      }
      // broadcastAll resolves its own offer set (the whole active roster) at
      // execution time — any pinned recipient option alongside it would
      // leave the worker with two contradictory offer sets.
      if (step.broadcastAll && (step.agentName || step.agentRef || step.agentNames)) {
        issues.push(
          `Step "${step.id}" sets broadcastAll alongside agentName/agentRef/agentNames; broadcastAll offers the whole active roster and is mutually exclusive with pinned recipients.`
        );
      }
      // The dynamic pin decides pinned-vs-not at execution time from the
      // var's value, so any static pin or broadcast alongside it would give
      // the worker two contradictory answers.
      if (
        step.agentNameVar &&
        (step.agentName || step.agentRef || step.agentNames || step.broadcastAll)
      ) {
        issues.push(
          `Step "${step.id}" sets agentNameVar alongside another pin/broadcast option; the dynamic pin is mutually exclusive with agentName/agentRef/agentNames/broadcastAll.`
        );
      }
      // The dynamic pin reads a var an EARLIER step must produce (same scope
      // rule as wait_for_reply.phoneVar).
      if (
        step.agentNameVar &&
        !vars.has(step.agentNameVar) &&
        !ENGINE_VARS.has(step.agentNameVar)
      ) {
        issues.push(
          `Step "${step.id}" pins via {{vars.${step.agentNameVar}}} which no earlier step produces.`
        );
      }
      // Duplicate names in one broadcast would double-text a teammate and
      // corrupt the per-recipient offer state.
      if (step.agentNames) {
        const seen = new Set<string>();
        for (const name of step.agentNames) {
          const key = name.trim().toLowerCase();
          if (seen.has(key)) {
            issues.push(
              `Step "${step.id}" lists "${name}" more than once in agentNames.`
            );
            break;
          }
          seen.add(key);
        }
      }
      // The keep-for-owner rule is a pair: a condition without the owner SMS
      // (or vice versa) would silently do nothing, so reject half a rule.
      if (Boolean(step.ownerDirectWhen) !== Boolean(step.ownerDirectTemplate)) {
        issues.push(
          `Step "${step.id}" must set ownerDirectWhen and ownerDirectTemplate together (the keep-for-owner rule needs both the condition and the owner SMS).`
        );
      }
      // Same scope rule as `when`: the condition may only reference a var an
      // EARLIER step produced.
      if (
        step.ownerDirectWhen &&
        !vars.has(step.ownerDirectWhen.var) &&
        !ENGINE_VARS.has(step.ownerDirectWhen.var)
      ) {
        issues.push(
          `Step "${step.id}" has an ownerDirectWhen condition on {{vars.${step.ownerDirectWhen.var}}} which no earlier step produces.`
        );
      }
      // Nudges only exist on the keep-for-owner path.
      if (step.ownerDirectNudges && !step.ownerDirectWhen) {
        issues.push(
          `Step "${step.id}" sets ownerDirectNudges without ownerDirectWhen (nudges only apply to the keep-for-owner alert).`
        );
      }
    }

    // A `when` guard may only reference a var an EARLIER step produced (same
    // scope rule as urlVar/templates; checked before this step's own vars are
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
    } else if (step.type === "doc_extract") {
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
    } else if (step.type === "wait_for_reply") {
      // The reply text ("" on timeout) becomes a var for later `when` branches.
      vars.add(step.saveAs ?? "reply_text");
    } else if (step.type === "place_ai_call") {
      // The call outcome (transferred/answered/no_answer/not_placed/failed)
      // becomes a var for later `when` branches.
      vars.add(step.saveAs ?? "call_outcome");
    } else if (step.type === "classify") {
      vars.add(step.saveAs);
    } else if (step.type === "generate_image") {
      vars.add(step.saveAs);
    } else if (step.type === "math") {
      vars.add(step.saveAs);
    } else if (step.type === "share_document" && step.saveAs) {
      vars.add(step.saveAs);
    } else if (step.type === "run_agent") {
      vars.add(step.saveAs);
      // Filing exposes the filed document's id/title to later templates.
      if (step.saveDocument) {
        vars.add(`${step.saveAs}_document_id`);
        vars.add(`${step.saveAs}_document_title`);
      }
    }
  };

  const walkSteps = (steps: FlowStep[], depth: number): void => {
    for (const step of steps) visitStep(step, depth);
  };

  walkSteps(def.steps, 0);

  if (totalSteps > MAX_TOTAL_STEPS) {
    issues.push(
      `This flow has ${totalSteps} steps in total (including branch paths); the limit is ${MAX_TOTAL_STEPS}.`
    );
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

// ── Best-effort salvage (AI-assist authoring) ────────────────────────────────

/** What salvageFlowDefinition returns: a VALID definition + what was changed. */
export type SalvagedFlow = { definition: AiFlowDefinition; warnings: string[] };

const STEP_ISSUE_RE = /Step "([^"]+)"/;

/**
 * Targeted mend for a step-scoped semantic issue: strip the one broken knob
 * and keep the step where that is safe, or return null to have the step
 * dropped. The mends only ever REMOVE configuration — a mended step does
 * strictly less than the AI asked for, never something different.
 */
function mendStepForIssue(step: Record<string, unknown>, issue: string): boolean {
  // A screenshot attachment with no earlier capture (or an unsupported
  // sender): the send itself is still what the owner wants — just without
  // the attachment.
  if (/attaches a screenshot/.test(issue)) {
    delete step.attachScreenshot;
    return true;
  }
  // sleep mixing wait modes: keep the relative wait when present (it's
  // self-contained), else the time-of-day pair; the date-anchored modes are
  // dropped either way (their templates may reference broken vars).
  if (/mixes wait modes/.test(issue)) {
    if (step.minutes !== undefined) {
      delete step.untilTime;
      delete step.timezone;
    }
    delete step.untilDateTemplate;
    delete step.relativeToTemplate;
    delete step.offsetMinutes;
    return true;
  }
  // Double pin: agentName is the AI-authorable one; refs come from the editor.
  if (/pins to both agentName and agentRef/.test(issue)) {
    delete step.agentRef;
    return true;
  }
  // Half a keep-for-owner rule: drop the half-configured pair.
  if (/ownerDirectWhen and ownerDirectTemplate together/.test(issue)) {
    delete step.ownerDirectWhen;
    delete step.ownerDirectTemplate;
    return true;
  }
  // An MMS attachment var no earlier step produces: the text itself is still
  // what the owner wants — send it without the image.
  if (/attaches an image from/.test(issue)) {
    delete step.mediaUrlVar;
    return true;
  }
  // A generate_image whose source-image template references an unproduced
  // var: keep the generation, drop the edit source — only when the bad var
  // is confined to inputImageTemplate (a broken promptTemplate still drops
  // the step; an image prompt without its subject would be nonsense).
  const badVar = /uses \{\{vars\.(\w+)\}\} before/.exec(issue)?.[1];
  if (
    badVar &&
    typeof step.inputImageTemplate === "string" &&
    step.inputImageTemplate.includes(`vars.${badVar}`) &&
    !(typeof step.promptTemplate === "string" && step.promptTemplate.includes(`vars.${badVar}`))
  ) {
    delete step.inputImageTemplate;
    return true;
  }
  // Multiple SMS recipients: keep the strongest single source.
  if (/sets more than one recipient/.test(issue)) {
    if (step.to) {
      delete step.toAgentName;
      delete step.toRef;
      delete step.replyToGroup;
    } else if (step.toAgentName) {
      delete step.toRef;
      delete step.replyToGroup;
    } else {
      delete step.toRef;
    }
    return true;
  }
  return false;
}

/**
 * Best-effort salvage of an AI-authored definition that failed validation.
 *
 * Instead of bouncing the owner with an error, keep everything that IS valid
 * and mechanically repair or remove what is not, returning a definition that
 * passes `parseAiFlowDefinition` plus a plain-English list of what changed.
 * The result loads into the builder (new AI drafts start DISABLED there), so
 * the owner reviews the salvaged flow rather than retyping their description.
 *
 * Salvage only ever SUBTRACTS: invalid steps/triggers/knobs are removed, and
 * an ununderstandable trigger falls back to Run-now — nothing is invented
 * beyond the placeholder step required when no step survives.
 *
 * Returns null when there is nothing usable at all (not an object, or the
 * salvage loop can't converge) — the caller then surfaces the plain error.
 */
export function salvageFlowDefinition(candidate: unknown): SalvagedFlow | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const raw = candidate as Record<string, unknown>;
  const warnings: string[] = [];

  // Trigger: keep it when valid; otherwise fall back to Run-now.
  let trigger: FlowTrigger;
  const trigParse = triggerSchema.safeParse(raw.trigger);
  if (trigParse.success) {
    trigger = trigParse.data;
  } else {
    trigger = { channel: "manual" };
    warnings.push(
      'The trigger could not be understood, so this flow starts from the Run-now button for now — pick the right "Starts when" in the editor.'
    );
  }

  // Extra triggers (OR set): keep the valid non-voice ones, up to the cap.
  let triggers: FlowTrigger[] | undefined;
  if (Array.isArray(raw.triggers)) {
    const kept: FlowTrigger[] = [];
    let dropped = 0;
    for (const t of raw.triggers) {
      const p = triggerSchema.safeParse(t);
      if (p.success && p.data.channel !== "voice" && kept.length < 4) kept.push(p.data);
      else dropped += 1;
    }
    if (dropped > 0) warnings.push(`Removed ${dropped} additional trigger(s) that couldn't be used.`);
    if (kept.length > 0) triggers = kept;
  }

  // Pre-mend from_matches conditions across the trigger set: the exactly-one
  // sender rule is semantic (zod passes both-or-neither), and a malformed
  // condition would otherwise force the manual-trigger fallback below.
  for (const trig of [trigger, ...(triggers ?? [])]) {
    const conds = (trig as { conditions?: TriggerCondition[] }).conditions;
    if (!Array.isArray(conds)) continue;
    const kept = conds.filter(
      (c) => c.type !== "from_matches" || (!c.value !== !c.ref)
    );
    if (kept.length !== conds.length) {
      warnings.push('Removed a "from matches" condition that had no usable sender.');
      (trig as { conditions?: TriggerCondition[] }).conditions = kept;
    }
  }

  // Steps: mint/dedupe ids, then keep each step that parses (retrying once
  // without its `when` guard — a malformed guard is a common single fault).
  const seenIds = new Set<string>();
  const steps: FlowStep[] = [];
  const rawSteps = Array.isArray(raw.steps) ? raw.steps.slice(0, 25) : [];
  if (Array.isArray(raw.steps) && raw.steps.length > 25) {
    warnings.push(
      `Removed ${raw.steps.length - 25} step(s) past the 25-step limit (kept the first 25).`
    );
  }
  for (let i = 0; i < rawSteps.length; i++) {
    const s = rawSteps[i];
    if (!s || typeof s !== "object") {
      warnings.push(`Removed step ${i + 1}: it wasn't a usable step at all.`);
      continue;
    }
    const step = { ...(s as Record<string, unknown>) };
    let id = typeof step.id === "string" && step.id.trim() ? step.id.trim().slice(0, 60) : `s${i + 1}`;
    while (seenIds.has(id)) id = `${id.slice(0, 55)}_${i + 1}`;
    step.id = id;
    let parsed = stepSchema.safeParse(step);
    if (!parsed.success && step.when !== undefined) {
      const { when: _when, ...rest } = step;
      parsed = stepSchema.safeParse(rest);
      if (parsed.success) {
        warnings.push(`Removed a broken run-condition from step ${i + 1} ("${String(step.type)}").`);
      }
    }
    if (!parsed.success) {
      warnings.push(
        `Removed step ${i + 1}${typeof step.type === "string" ? ` ("${step.type}")` : ""}: it was missing required details.`
      );
      continue;
    }
    seenIds.add(id);
    steps.push(parsed.data);
  }

  const options =
    raw.options && typeof raw.options === "object" && !Array.isArray(raw.options)
      ? {
          suppressDefaultReply:
            (raw.options as Record<string, unknown>).suppressDefaultReply === true || undefined,
          captureStepScreenshots:
            (raw.options as Record<string, unknown>).captureStepScreenshots === true || undefined
        }
      : undefined;

  // Semantic repair loop: mend or remove the step each issue names; a
  // non-step (trigger/voice-shape) issue forces the Run-now fallback once.
  let triggerReset = trigParse.success === false;
  for (let guard = 0; guard < 60; guard++) {
    if (steps.length === 0) {
      // A voice flow can only hold voice steps, so the notify-me placeholder
      // below would be rejected (and re-injected) forever — a voice trigger
      // with no surviving call steps falls back to Run-now first.
      if (trigger.channel === "voice") {
        trigger = { channel: "manual" };
        triggers = undefined;
        triggerReset = true;
        warnings.push(
          "The voice flow had no usable call steps left, so it starts from the Run-now button for now."
        );
      }
      steps.push({
        id: "s1",
        type: "notify_owner",
        message:
          "Your automation ran. (The AI draft needed manual attention — open this flow in the editor to finish it.)"
      });
      warnings.push(
        "No usable steps survived, so a simple notify-me step was added as a starting point."
      );
    }
    const def: AiFlowDefinition = {
      version: 1,
      trigger,
      ...(triggers && triggers.length > 0 ? { triggers } : {}),
      steps,
      ...(options ? { options } : {})
    };
    const issues = validateDefinitionSemantics(def);
    if (issues.length === 0) {
      // Belt-and-braces zod re-parse: strips any keys the mends left behind
      // so the result is exactly what parseAiFlowDefinition would accept.
      const finalParse = aiFlowDefinitionSchema.safeParse(def);
      /* c8 ignore next -- zod + semantics both passed above; defensive only */
      if (!finalParse.success) return null;
      return { definition: finalParse.data, warnings };
    }
    const issue = issues[0];
    const stepMatch = STEP_ISSUE_RE.exec(issue);
    if (stepMatch) {
      const idx = steps.findIndex((s) => s.id === stepMatch[1]);
      /* c8 ignore next 2 -- semantics always name a present step; defensive only */
      if (idx === -1) return null;
      const mutable = steps[idx] as unknown as Record<string, unknown>;
      if (mendStepForIssue(mutable, issue)) {
        warnings.push(`Adjusted step ${idx + 1} ("${steps[idx].type}"): ${issue}`);
      } else {
        warnings.push(`Removed step ${idx + 1} ("${steps[idx].type}"): ${issue}`);
        steps.splice(idx, 1);
      }
      continue;
    }
    // Trigger-level / voice-shape issue: fall back to Run-now once (which also
    // invalidates any voice steps — the loop then removes them) — then give up.
    // (Under a manual trigger no non-step issues remain, so the second-reset
    // bail is defensive.)
    /* c8 ignore next */
    if (triggerReset) return null;
    triggerReset = true;
    trigger = { channel: "manual" };
    triggers = undefined;
    warnings.push(
      `The trigger setup couldn't be repaired (${issue}) — the flow starts from the Run-now button for now.`
    );
  }
  /* c8 ignore next 2 -- the loop always converges (every pass removes something) */
  return null;
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
          ? `Every ${formatDurationMinutes(t.everyMinutes)}`
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
    case "webhook":
      trigPart =
        t.conditions.length === 0
          ? "When any webhook event arrives"
          : `When a webhook event matches ${t.conditions.length} condition(s)`;
      break;
    case "calendar": {
      const what =
        t.on === "event_start"
          ? `${formatDurationMinutes(t.leadMinutes ?? 0)} before a calendar event starts`
          : t.on === "event_end"
            ? t.followMinutes !== undefined && t.followMinutes > 0
              ? `${formatDurationMinutes(t.followMinutes)} after a calendar event ends`
              : "When a calendar event ends"
            : t.on === "event_canceled"
              ? "When a calendar event is canceled"
              : "When a calendar event is created";
      trigPart =
        t.conditions.length === 0
          ? what
          : `${what} (matching ${t.conditions.length} condition(s))`;
      break;
    }
    case "contact_created":
      trigPart =
        t.conditions.length === 0
          ? "When a contact is created"
          : `When a contact is created (matching ${t.conditions.length} condition(s))`;
      break;
    case "tag_changed":
      trigPart = `When the tag ${t.tag ? `"${t.tag}" ` : ""}is ${t.change ?? "added"}`;
      break;
    case "owner_assigned":
      trigPart = "When a contact is assigned an owner";
      break;
    case "birthday":
      trigPart = `On a contact's birthday (at ${t.time ?? "09:00"})`;
      break;
    case "voice":
      trigPart =
        t.direction === "outbound"
          ? "When you place an outbound call"
          : `When a call comes in from ${t.fromE164 ?? t.fromRef?.label ?? "a saved contact"}`;
      break;
  }
  // Additional OR triggers get a compact count; the primary keeps its prose.
  const extra = def.triggers?.length ?? 0;
  if (extra > 0) trigPart += ` (or ${extra} other trigger${extra === 1 ? "" : "s"})`;
  const stepTypes = def.steps.map((s) => s.type).join(" -> ");
  return `${trigPart}: ${stepTypes}`;
}
