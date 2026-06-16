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
  "send_sms",
  "send_email",
  "approval_gate",
  "notify_owner",
  "http_call",
  "route_to_team",
  "browse_action"
] as const;

/** Keys available as `{{agent.x}}` inside a route_to_team step's templates. */
export const AGENT_SCOPE_KEYS = ["name", "phone"] as const;

/** Keys available as `{{offer.x}}` inside a route_to_team step's templates. */
export const OFFER_SCOPE_KEYS = ["deadline"] as const;

/**
 * Vars the ENGINE itself maintains (not produced by any step): the worker
 * appends a human description of each outbound contact (SMS / email / routing)
 * to `actions_taken`, so a later step — e.g. a browse_action timeline note —
 * can template "what did this flow actually do". Always in scope.
 */
export const ENGINE_PROVIDED_VARS = ["actions_taken"] as const;

/** The UI action kinds a browse_action step may perform. */
export const BROWSE_ACTION_KINDS = [
  "click_text",
  "click_selector",
  "fill_selector",
  "fill_placeholder"
] as const;

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Variable identifiers (saveAs, field names, urlVar): snake/camel, bounded. */
export const VAR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

/** Trigger-scope keys the engine always populates (see evaluateSmsTrigger). */
export const TRIGGER_SCOPE_KEYS = ["url", "windowText", "from"] as const;

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

const triggerSchema = z.discriminatedUnion("channel", [
  smsTriggerSchema,
  manualTriggerSchema,
  scheduleTriggerSchema,
  emailTriggerSchema,
  tenantEmailTriggerSchema
]);

const extractFieldSchema = z.object({
  name: varName,
  description: z.string().max(300).optional()
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

const browseActionItemSchema = z.object({
  kind: z.enum(BROWSE_ACTION_KINDS),
  target: z.string().min(1).max(300),
  valueTemplate: z.string().max(2000).optional()
});

/**
 * Optional per-step guard. The step only runs when the condition holds against a
 * var produced by an EARLIER step; otherwise the worker skips it. Exactly one of
 * `equals`/`contains` must be set (XOR), so two gated steps give simple branching
 * (e.g. a buyer vs. seller `send_sms`). MUST be part of the schema so the
 * dashboard editor's save round-trips it instead of zod stripping it.
 */
const whenSchema = z
  .object({
    var: varName,
    equals: z.string().min(1).max(200).optional(),
    contains: z.string().min(1).max(200).optional(),
    caseInsensitive: z.boolean().optional()
  })
  .refine((w) => (w.equals === undefined) !== (w.contains === undefined), {
    message: "set exactly one of equals/contains"
  });

const stepSchema = z.discriminatedUnion("type", [
  z.object({ id: stepId, type: z.literal("extract_url"), saveAs: varName, when: whenSchema.optional() }),
  z.object({
    id: stepId,
    type: z.literal("browse_extract"),
    urlVar: varName,
    fields: z.array(extractFieldSchema).min(1).max(15),
    auth: browseAuthSchema.optional(),
    screenshot: z.boolean().optional(),
    when: whenSchema.optional()
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
  z.object({
    id: stepId,
    type: z.literal("send_sms"),
    to: z.string().min(1).max(200),
    body: z.string().min(1).max(1600),
    quietHours: sendSmsQuietHoursSchema.optional(),
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
    when: whenSchema.optional()
  }),
  z.object({
    id: stepId,
    type: z.literal("browse_action"),
    urlVar: varName,
    auth: browseAuthSchema.optional(),
    actions: z.array(browseActionItemSchema).min(1).max(15),
    screenshot: z.boolean().optional(),
    when: whenSchema.optional()
  })
]);

export const aiFlowDefinitionSchema = z.object({
  version: z.literal(1),
  trigger: triggerSchema,
  steps: z.array(stepSchema).min(1).max(25),
  options: z
    .object({ suppressDefaultReply: z.boolean().optional() })
    .optional()
});

export type TriggerCondition = z.infer<typeof conditionSchema>;
export type FlowTrigger = z.infer<typeof triggerSchema>;
export type FlowStep = z.infer<typeof stepSchema>;
export type StepCondition = z.infer<typeof whenSchema>;
export type AiFlowDefinition = z.infer<typeof aiFlowDefinitionSchema>;

/** The trigger channels the builder offers. */
export const TRIGGER_CHANNELS = ["sms", "manual", "schedule", "email", "tenant_email"] as const;

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
      return [step.to, step.body, step.quietHours?.emailSubject ?? ""];
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
    case "extract_url":
    case "browse_extract":
    case "extract_text":
      return [];
  }
}

const TRIGGER_KEYS = new Set<string>(TRIGGER_SCOPE_KEYS);
const AGENT_KEYS = new Set<string>(AGENT_SCOPE_KEYS);
const OFFER_KEYS = new Set<string>(OFFER_SCOPE_KEYS);
const ENGINE_VARS = new Set<string>(ENGINE_PROVIDED_VARS);

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
          // {{agent.name}}/{{agent.phone}} is the offered team member, resolved at
          // run time — only meaningful inside a route_to_team step's templates.
          if (step.type !== "route_to_team") {
            issues.push(
              `Step "${step.id}" uses {{agent.${ref.key}}} but only a route_to_team step has an agent.`
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
        } else {
          issues.push(`Step "${step.id}" uses unknown template scope "${ref.scope}".`);
        }
      }
    }

    if ((step.type === "browse_extract" || step.type === "browse_action") && !vars.has(step.urlVar)) {
      issues.push(`Step "${step.id}" browses urlVar "${step.urlVar}" which no earlier step produces.`);
    }

    // The owner-mailbox send path is plain text (Nango Gmail/Outlook); the
    // screenshot attachment only exists on the platform Resend path.
    if (step.type === "send_email" && step.attachScreenshot && step.fromConnectionId) {
      issues.push(
        `Step "${step.id}" attaches a screenshot but sends from a connected mailbox — attachments are only supported from the platform sender.`
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
      for (const f of step.fields) vars.add(f.name);
      if (step.screenshot) screenshotCaptured = true;
    } else if (step.type === "extract_text") {
      for (const f of step.fields) vars.add(f.name);
    } else if (step.type === "browse_action") {
      if (step.screenshot) screenshotCaptured = true;
    } else if (step.type === "http_call" && step.saveAs) {
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
  }
  const stepTypes = def.steps.map((s) => s.type).join(" -> ");
  return `${trigPart}: ${stepTypes}`;
}
