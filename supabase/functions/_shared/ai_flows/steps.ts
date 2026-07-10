/**
 * AiFlows step planner: the PURE half of the step catalog.
 *
 * `planStep` turns a definition step + the current run scope ({ vars, trigger })
 * into a normalized `StepAction` describing the SINGLE side effect the worker
 * should perform (or an error). All templating / variable resolution / "is the
 * required input present?" logic lives here so it is unit-tested; the
 * ai-flow-worker (supabase/functions/ai-flow-worker/index.ts) stays a thin IO
 * dispatcher that switches on `action.kind`.
 */
import { firstUrlInText, isE164, normalizeNanpToE164, renderTemplate } from "./engine.ts";
import { branchChoiceVar, chooseBranchArm } from "./branching.ts";
import type {
  BrowseAuth,
  ContactRef,
  ExtractField,
  ExtractLink,
  FlowStep,
  RouteOfferWindow,
  StepCondition
} from "./types.ts";

export type StepScope = {
  vars?: Record<string, unknown>;
  trigger?: Record<string, unknown>;
  /** The AI coworker's own mailbox, referenceable in templates as {{coworker.email}}. */
  coworker?: { email?: string };
  /** Relative-date tokens ({{now.*}}); see engine.buildNowScope. Derived, never persisted. */
  now?: unknown;
};

/**
 * A send_sms step's quiet-hours plan with templates already resolved: the
 * email-fallback recipient comes from the configured var ("" when absent) and
 * the subject is rendered, so the worker only has to pick a branch.
 */
export type SendSmsQuietPlan = {
  timezone: string;
  noSendAfter: string;
  resumeAt: string;
  /** Resolved lead email for the email-instead branch; "" → defer instead. */
  emailTo: string;
  emailSubject: string;
  emailFromConnectionId?: string;
};

/** One resolved browse_action UI action (valueTemplate already rendered). */
export type BrowseActionPlanned = {
  kind:
    | "click_text"
    | "click_selector"
    | "fill_selector"
    | "fill_placeholder"
    | "click_text_while_present"
    | "click_role"
    | "select_option";
  target: string;
  value: string;
};

/** Hard ceiling on any wait (sleep / wait_for_reply): 30 days, in minutes. */
export const MAX_WAIT_MINUTES = 43200;

/**
 * What a wait_for_reply step's saveAs var holds when the lead never texted
 * back (timeout, or no usable phone to wait on). A named sentinel — not "" —
 * because when-conditions (equals/notEquals) require a non-empty value.
 * Must match the SQL literal in resume_overdue_reply_waits().
 */
export const NO_REPLY_SENTINEL = "no_reply";

export type StepAction =
  | { kind: "set_vars"; vars: Record<string, string> }
  | {
      /**
       * Pause-then-continue. The WORKER computes the resume instant (it owns
       * the clock/zone helpers) and defers the run via earliest_claim_at;
       * `marker` is the context var it stamps so re-entry after the deferral
       * completes instead of re-sleeping.
       */
      kind: "sleep";
      minutes?: number;
      untilTime?: string;
      timezone?: string;
      marker: string;
    }
  | {
      /**
       * Park the run until `from` texts back or the timeout lapses. The
       * planner resolves the phone; the worker persists the awaiting_reply
       * state. `marker` is the per-STEP resolution flag (stamped by the
       * resume/timeout paths alongside `saveAs`) — resolution is tracked per
       * step, not per saveAs var, so two waits sharing a var both park.
       * A marker already set → the planner returns set_vars {} instead, so
       * this action always means "park now".
       */
      kind: "wait_for_reply";
      from: string;
      saveAs: string;
      marker: string;
      timeoutMinutes: number;
    }
  | {
      kind: "browse";
      url: string;
      fields?: ExtractField[];
      extractLinks?: ExtractLink[];
      auth?: BrowseAuth;
      screenshot?: boolean;
      /**
       * Terminal-state marker: when the fetched page contains this
       * (case-insensitive) text, the worker ends the run gracefully (step
       * "skipped", run "done") instead of extracting from a page that has
       * nothing to read — see FlowStep (browse_extract).skipWhenText.
       */
      skipWhenText?: string;
    }
  | { kind: "extract_text"; text: string; fields: ExtractField[] }
  | {
      // Read + extract from a connected mailbox. The planner resolves the
      // body-match terms (rendered matchTemplates, blanks dropped); the worker
      // performs the IO (mailbox read via the platform proxy, then the same Gemini
      // extraction).
      kind: "email_extract";
      connectionId: string;
      fromContains: string;
      /** Rendered terms the message text must ALL contain ([] → no body filter). */
      bodyContains: string[];
      lookbackMinutes: number;
      fields: ExtractField[];
      fillOnlyEmpty: boolean;
    }
  | {
      kind: "send_sms";
      /** Primary recipient (used for logging / opt-out; recipients[0] for a group). */
      to: string;
      /** All recipients for a group MMS reply; absent for a normal 1:1 send. */
      recipients?: string[];
      /**
       * When set, the worker resolves this named roster member's phone at run
       * time (the planner can't reach the DB) and renders `body` with {{agent.*}}
       * in scope. `to` is left empty until then.
       */
      toAgentName?: string;
      /**
       * When set, the worker resolves this saved employee/contact's current
       * phone at run time (see ContactRef). The planner passes it through with a
       * RAW body (like toAgentName) because only the worker knows whether to put
       * {{agent.*}} in scope (employee) or render against plain vars (contact).
       */
      toRef?: ContactRef;
      body: string;
      quiet?: SendSmsQuietPlan;
      /**
       * Resolved image URL to attach (an earlier generate_image step's var):
       * the worker sends MMS instead of plain SMS. Absent when the step has
       * no mediaUrlVar or the var resolved empty (plain-text degrade).
       */
      mediaUrl?: string;
      /**
       * Set when a TEMPLATED recipient resolved to nothing usable (the lead
       * had no phone, or the self-number scrub cleared a bogus extraction).
       * The worker skips the send with an actions_taken note instead of
       * failing the run — a lead-data gap is not a flow-config bug.
       */
      skipReason?: string;
    }
  | {
      kind: "send_email";
      to: string;
      /** Resolved cc recipients (templated, empties dropped). Omitted when none. */
      cc?: string[];
      /** Resolved bcc recipients (templated, empties dropped). Omitted when none. */
      bcc?: string[];
      subject: string;
      body: string;
      attachScreenshot: boolean;
      /** Send via the owner's connected mailbox instead of platform Resend. */
      fromConnectionId?: string;
    }
  | { kind: "notify_owner"; message: string }
  | { kind: "await_approval"; prompt: string }
  | {
      kind: "http_call";
      label: string;
      method: string;
      path: string;
      body: string;
      saveAs?: string;
    }
  | {
      // Templates are passed through UNRENDERED: the offer/claimed copy reference
      // {{agent.*}} / {{offer.*}}, which only the worker knows after it selects
      // an agent and resolves the offer deadline.
      kind: "route_to_team";
      offerTemplate: string;
      responseMinutes: number;
      ownerFallbackTemplate: string;
      claimedNotifyTemplate?: string;
      /** Pin offers to the single roster member with this name. */
      agentName?: string;
      /** Pin offers to a saved roster member by reference (worker resolves the
       * current name, then routes exactly like agentName). Employee source only. */
      agentRef?: ContactRef;
      /** After-hours claim-deadline extension. */
      offerWindow?: RouteOfferWindow;
      /** Attach the stored browse screenshot to each agent offer as MMS. */
      attachScreenshot: boolean;
      /** First to claim (ON when undefined; false disables the bare-"1" yank). */
      firstToClaim?: boolean;
      /** Keep-for-owner rule (see FlowStep): matched on first entry → no team
       * offer; the owner gets ownerDirectTemplate instead. */
      ownerDirectWhen?: StepCondition;
      /** Passed UNRENDERED like the other route templates (worker renders it). */
      ownerDirectTemplate?: string;
      /** Offer the lead's owning employee (contacts.owner_employee_id) first. */
      preferContactOwner?: boolean;
    }
  | {
      kind: "browse_action";
      url: string;
      auth?: BrowseAuth;
      actions: BrowseActionPlanned[];
      /** Same-pass field extraction over the post-action page text, if any. */
      fields?: ExtractField[];
      screenshot: boolean;
      /**
       * Var name whose (phone) value the worker normalizes and persists the
       * final URL under — resolved AFTER any same-pass extraction, so a phone
       * this step itself extracts can be the key.
       */
      rememberKeyVar?: string;
      /**
       * CSS selector for list rows: the render service collects each match's
       * href and runs `actions` on every one in turn (loop-over-list). When set,
       * fields/screenshot/rememberKeyVar don't apply.
       */
      forEachLink?: string;
      /**
       * Names to restrict a forEachLink loop to (rows whose text contains one of
       * these). Resolved by the planner from forEachLinkMatchVar; only present
       * when forEachLink is set AND the var yielded >= 1 name.
       */
      forEachMatch?: string[];
      /**
       * Terminal-state marker: when an action fails and the page contains this
       * (case-insensitive) text, the worker ends the run gracefully (step
       * "skipped", run "done") instead of failing — see FlowStep.skipWhenText.
       */
      skipWhenText?: string;
    }
  | {
      kind: "recall_url";
      /** Candidate (normalized) phone keys to look up, in priority order. */
      keys: string[];
      saveAs: string;
    }
  | {
      /**
       * Generate an AI image from the (already rendered) prompt and save a
       * signed URL to the stored image into vars[saveAs]. The worker owns the
       * IO: spend gate, Gemini image call, storage upload, signing, metering.
       */
      kind: "generate_image";
      prompt: string;
      saveAs: string;
    }
  | {
      // Enrich/create a customer profile. The planner resolves the phone (key)
      // and reads the name/email vars; the worker does the alias-aware, fill-only
      // write (and skips known business contacts).
      kind: "upsert_customer";
      e164: string;
      name: string;
      email: string;
    }
  | {
      /**
       * Classify `text` into exactly one of `values` (or the reserved
       * "unclear" fallback), saving the winner into vars[saveAs]. The planner
       * resolves the text (a var or the trigger's message) and pre-computes
       * the fallback: empty text plans `resolved: "unclear"` directly so the
       * worker never burns a model call on nothing.
       */
      kind: "classify";
      text: string;
      question?: string;
      categories: { value: string; description?: string }[];
      saveAs: string;
      /** Set when no model call is needed (empty text) — the decided value. */
      resolved?: string;
    }
  | {
      /**
       * Maintain the contact's lead-state tags. The planner resolves the
       * phone; `skipReason` set means the phone was unusable — the worker
       * notes the skip instead of failing (a lead-data gap is not a flow
       * bug), mirroring send_sms's templated-recipient behavior.
       */
      kind: "update_contact";
      e164: string;
      addTags: string[];
      removeTags: string[];
      skipReason?: string;
    };

export type StepPlan =
  | { ok: true; action: StepAction }
  | { ok: false; error: string };

function triggerString(scope: StepScope, key: string): string {
  const v = scope.trigger?.[key];
  return typeof v === "string" ? v : "";
}

/** Max cc (and, separately, bcc) recipients on one send. Mirrors the schema. */
const MAX_CC_BCC_RECIPIENTS = 10;
// Same strictness class as the Node senders and the chat-worker regex.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Render each cc/bcc template, then normalize the results the same way every
 * other send path does: split comma/semicolon/whitespace lists, validate each
 * address, lowercase, de-dup, and cap. Keeps the platform (Resend) path in
 * lockstep with the owner-mailbox adapter and the email_log it writes.
 */
function normalizeFlowRecipients(templates: string[] | undefined, scope: StepScope): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const template of templates ?? []) {
    const rendered = renderTemplate(template, scope);
    for (const part of rendered.split(/[,;\s]+/)) {
      const addr = part.trim().toLowerCase();
      if (!addr || seen.has(addr) || !EMAIL_RE.test(addr)) continue;
      seen.add(addr);
      out.push(addr);
      if (out.length >= MAX_CC_BCC_RECIPIENTS) return out;
    }
  }
  return out;
}

/**
 * Plan the one side effect for a step. Pure: never performs IO, only decides
 * WHAT the worker should do and validates that the inputs the step needs are
 * present in scope. Returns `{ ok: false }` for a recoverable "missing input"
 * so the worker can mark the step failed without throwing.
 */
export function planStep(step: FlowStep, scope: StepScope): StepPlan {
  switch (step.type) {
    case "extract_url": {
      const fromTrigger = triggerString(scope, "url");
      const url = fromTrigger || firstUrlInText(triggerString(scope, "windowText"));
      if (!url) {
        return { ok: false, error: "extract_url: no URL in the triggering messages" };
      }
      return { ok: true, action: { kind: "set_vars", vars: { [step.saveAs]: url } } };
    }
    case "browse_extract": {
      const url = scope.vars?.[step.urlVar];
      if (typeof url !== "string" || !url) {
        return { ok: false, error: `browse_extract: urlVar "${step.urlVar}" is not set` };
      }
      return {
        ok: true,
        action: {
          kind: "browse",
          url,
          ...(step.fields && step.fields.length > 0 ? { fields: step.fields } : {}),
          ...(step.extractLinks && step.extractLinks.length > 0
            ? { extractLinks: step.extractLinks }
            : {}),
          auth: step.auth,
          screenshot: step.screenshot,
          ...(step.skipWhenText && step.skipWhenText.trim()
            ? { skipWhenText: step.skipWhenText.trim() }
            : {})
        }
      };
    }
    case "extract_text": {
      // Read the same structured fields out of the inbound message text rather
      // than a fetched page. windowText is the combined correlation-window text
      // the trigger evaluated, so it carries everything the lead sent.
      const text = triggerString(scope, "windowText").trim();
      if (!text) {
        return { ok: false, error: "extract_text: no message text to read" };
      }
      return { ok: true, action: { kind: "extract_text", text, fields: step.fields } };
    }
    case "email_extract": {
      // The body-match terms narrow the inbox read to THIS lead's email; render
      // them now (the worker does only IO) and drop any that render blank (e.g. a
      // city var that wasn't captured) so a missing optional term never blocks the
      // match. No terms means "no body filter" — fromContains + recency still
      // scope the read.
      const bodyContains = (step.matchTemplates ?? [])
        .map((t) => renderTemplate(t, scope).trim())
        .filter((t) => t.length > 0);
      return {
        ok: true,
        action: {
          kind: "email_extract",
          connectionId: step.connectionId,
          fromContains: (step.fromContains ?? "").trim(),
          bodyContains,
          lookbackMinutes: Math.max(1, Math.round(step.lookbackMinutes ?? 60)),
          fields: step.fields,
          fillOnlyEmpty: step.fillOnlyEmpty === true
        }
      };
    }
    case "send_sms": {
      // MMS attachment: resolve the image URL var an earlier generate_image
      // step produced. Anything that is not an http(s) URL (empty var, failed
      // generation prose) degrades to a plain text send — the message itself
      // must never be blocked by an image hiccup.
      let mediaUrl: string | undefined;
      if (step.mediaUrlVar) {
        const rawMedia = scope.vars?.[step.mediaUrlVar];
        const candidate = typeof rawMedia === "string" ? rawMedia.trim() : "";
        if (/^https?:\/\//i.test(candidate)) mediaUrl = candidate;
      }
      let quiet: SendSmsQuietPlan | undefined;
      if (step.quietHours) {
        const q = step.quietHours;
        const emailRaw = q.emailFallbackVar ? scope.vars?.[q.emailFallbackVar] : "";
        // The fallback address comes from page EXTRACTION, which answers "none"
        // (or other prose) when the lead has no email — only an @-bearing value
        // may select the email-instead branch; anything else means defer.
        const emailTo = typeof emailRaw === "string" ? emailRaw.trim() : "";
        quiet = {
          timezone: q.timezone,
          noSendAfter: q.noSendAfter,
          resumeAt: q.resumeAt,
          emailTo: emailTo.includes("@") ? emailTo : "",
          emailSubject: renderTemplate(
            q.emailSubject ?? "Following up on your inquiry",
            scope
          ).trim(),
          ...(q.emailFromConnectionId ? { emailFromConnectionId: q.emailFromConnectionId } : {})
        };
      }
      // Named-agent send: the planner can't reach the roster DB, so pass the
      // agent name + the UNRENDERED body through; the worker resolves the
      // member's phone and renders the body with {{agent.*}} in scope.
      if (step.toAgentName) {
        return {
          ok: true,
          action: {
            kind: "send_sms",
            to: "",
            body: step.body,
            toAgentName: step.toAgentName.trim(),
            ...(quiet ? { quiet } : {}),
            ...(mediaUrl ? { mediaUrl } : {})
          }
        };
      }
      // Dynamic recipient (saved employee/contact). Like toAgentName, the worker
      // resolves the number AND renders the body (it alone knows the source), so
      // the planner passes the raw body through.
      if (step.toRef) {
        return {
          ok: true,
          action: {
            kind: "send_sms",
            to: "",
            body: step.body,
            toRef: step.toRef,
            ...(quiet ? { quiet } : {}),
            ...(mediaUrl ? { mediaUrl } : {})
          }
        };
      }
      const body = renderTemplate(step.body, scope).trim();
      if (!body) return { ok: false, error: "send_sms: body is empty after templating" };
      // Group reply: recipients come from the inbound thread roster, not `to`.
      // Everyone in trigger.participants except our own business number
      // (trigger.to), de-duped, preserving order.
      if (step.replyToGroup) {
        const ownNumber = triggerString(scope, "to");
        const raw = scope.trigger?.participants;
        const seen = new Set<string>();
        const recipients: string[] = [];
        if (Array.isArray(raw)) {
          for (const p of raw) {
            if (typeof p !== "string") continue;
            const n = p.trim();
            if (!n || n === ownNumber || seen.has(n)) continue;
            seen.add(n);
            recipients.push(n);
          }
        }
        if (recipients.length === 0) {
          return {
            ok: false,
            error: "send_sms: replyToGroup but the trigger has no other group participants"
          };
        }
        return {
          ok: true,
          action: {
            kind: "send_sms",
            to: recipients[0],
            recipients,
            body,
            ...(quiet ? { quiet } : {}),
            ...(mediaUrl ? { mediaUrl } : {})
          }
        };
      }
      const toRaw = renderTemplate(step.to ?? "", scope).trim();
      // A recipient that came from a TEMPLATE VAR (extraction output) can
      // legitimately be missing — the lead had no phone, or the scrub cleared
      // a bogus one. That's a lead-data gap, not a flow-config bug: plan a
      // SKIP (the worker notes it in actions_taken) instead of failing the
      // whole run. A LITERAL bad recipient stays a hard plan failure.
      const fromTemplateVar = (step.to ?? "").includes("{{");
      const emptyish =
        !toRaw || ["none", "n/a", "na", "null", "unknown"].includes(toRaw.toLowerCase());
      if (emptyish) {
        if (fromTemplateVar) {
          return {
            ok: true,
            action: { kind: "send_sms", to: "", body, skipReason: "no_recipient_phone" }
          };
        }
        return { ok: false, error: "send_sms: recipient is empty after templating" };
      }
      // Telnyx only accepts E.164. Extracted phones arrive in page formatting —
      // "(840) 275-3158", "840.275.3158" — so coerce NANP shapes to +1XXXXXXXXXX
      // and fail fast (no retries) on anything unparseable instead of burning
      // MAX_ATTEMPTS on a guaranteed Telnyx 40310 "Invalid 'to' address".
      const to = isE164(toRaw) ? toRaw : normalizeNanpToE164(toRaw);
      if (!to) {
        if (fromTemplateVar) {
          return {
            ok: true,
            action: { kind: "send_sms", to: "", body, skipReason: "unparseable_recipient_phone" }
          };
        }
        return {
          ok: false,
          error: `send_sms: recipient "${toRaw}" is not a valid phone number`
        };
      }
      return {
        ok: true,
        action: {
          kind: "send_sms",
          to,
          body,
          ...(quiet ? { quiet } : {}),
          ...(mediaUrl ? { mediaUrl } : {})
        }
      };
    }
    case "send_email": {
      const to = renderTemplate(step.to, scope).trim();
      const subject = renderTemplate(step.subject, scope).trim();
      const body = renderTemplate(step.body, scope).trim();
      if (!to) return { ok: false, error: "send_email: recipient is empty after templating" };
      if (!subject) return { ok: false, error: "send_email: subject is empty after templating" };
      if (!body) return { ok: false, error: "send_email: body is empty after templating" };
      // Render + normalize cc/bcc (validate, split lists, lowercase, de-dup,
      // cap) so the platform and owner-mailbox paths — and the email_log —
      // all carry the exact addresses that get delivered.
      const cc = normalizeFlowRecipients(step.cc, scope);
      const bcc = normalizeFlowRecipients(step.bcc, scope);
      return {
        ok: true,
        action: {
          kind: "send_email",
          to,
          ...(cc.length > 0 ? { cc } : {}),
          ...(bcc.length > 0 ? { bcc } : {}),
          subject,
          body,
          attachScreenshot: step.attachScreenshot === true,
          ...(step.fromConnectionId ? { fromConnectionId: step.fromConnectionId } : {})
        }
      };
    }
    case "notify_owner": {
      const message = renderTemplate(step.message, scope).trim();
      if (!message) return { ok: false, error: "notify_owner: message is empty after templating" };
      return { ok: true, action: { kind: "notify_owner", message } };
    }
    case "approval_gate": {
      return {
        ok: true,
        action: { kind: "await_approval", prompt: renderTemplate(step.prompt, scope).trim() }
      };
    }
    case "http_call": {
      const method = (step.method ?? "GET").toUpperCase();
      const path = renderTemplate(step.path ?? "", scope);
      const body = renderTemplate(step.bodyTemplate ?? "", scope);
      return {
        ok: true,
        action: { kind: "http_call", label: step.label, method, path, body, saveAs: step.saveAs }
      };
    }
    case "route_to_team": {
      const offerTemplate = step.offerTemplate.trim();
      const ownerFallbackTemplate = step.ownerFallbackTemplate.trim();
      if (!offerTemplate) {
        return { ok: false, error: "route_to_team: offerTemplate is empty" };
      }
      if (!ownerFallbackTemplate) {
        return { ok: false, error: "route_to_team: ownerFallbackTemplate is empty" };
      }
      const responseMinutes = Math.max(1, Math.round(step.responseMinutes ?? 10));
      const claimed = step.claimedNotifyTemplate?.trim();
      const agentName = step.agentName?.trim();
      // Keep-for-owner rule: carried only as a complete pair (the schema
      // enforces both-or-neither; a half-configured rule is dropped, not
      // half-applied). Template stays unrendered like the other route copy.
      const ownerDirect = step.ownerDirectWhen && step.ownerDirectTemplate?.trim();
      return {
        ok: true,
        action: {
          kind: "route_to_team",
          offerTemplate,
          responseMinutes,
          ownerFallbackTemplate,
          claimedNotifyTemplate: claimed ? claimed : undefined,
          ...(agentName ? { agentName } : {}),
          ...(step.agentRef ? { agentRef: step.agentRef } : {}),
          ...(step.offerWindow ? { offerWindow: step.offerWindow } : {}),
          attachScreenshot: step.attachScreenshot === true,
          // Only an explicit opt-out is carried; undefined means ON.
          ...(step.firstToClaim === false ? { firstToClaim: false } : {}),
          ...(step.preferContactOwner === true ? { preferContactOwner: true } : {}),
          ...(ownerDirect
            ? {
                ownerDirectWhen: step.ownerDirectWhen,
                ownerDirectTemplate: step.ownerDirectTemplate!.trim()
              }
            : {})
        }
      };
    }
    case "browse_action": {
      const url = scope.vars?.[step.urlVar];
      if (typeof url !== "string" || !url) {
        return { ok: false, error: `browse_action: urlVar "${step.urlVar}" is not set` };
      }
      if (step.actions.length === 0) {
        return { ok: false, error: "browse_action: no actions configured" };
      }
      const actions: BrowseActionPlanned[] = step.actions.map((a) => ({
        kind: a.kind,
        target: a.target,
        value: a.valueTemplate ? renderTemplate(a.valueTemplate, scope).trim() : ""
      }));
      // Resolve the forEachLink name filter: split the var's value on
      // commas/newlines/semicolons, trim, drop empties, dedupe. When the author
      // requested a filter (forEachLinkMatchVar set) we ALWAYS attach the list —
      // even when it resolves to EMPTY — so the render service updates NOTHING
      // rather than silently falling back to acting on every row. An empty list
      // is reported by the worker as "found no matching list items".
      let forEachMatch: string[] | undefined;
      if (step.forEachLink && step.forEachLinkMatchVar) {
        const raw = scope.vars?.[step.forEachLinkMatchVar];
        const seen = new Set<string>();
        const names: string[] = [];
        if (typeof raw === "string") {
          for (const part of raw.split(/[,\n;]+/)) {
            const name = part.trim();
            const key = name.toLowerCase();
            if (name && !seen.has(key)) {
              seen.add(key);
              names.push(name);
            }
          }
        }
        forEachMatch = names;
      }
      // Pass the remember-key VAR NAME (not a resolved value): the worker reads
      // and normalizes it AFTER any same-pass extraction, so a phone this step
      // itself extracts can serve as the key.
      return {
        ok: true,
        action: {
          kind: "browse_action",
          url,
          auth: step.auth,
          actions,
          ...(step.fields && step.fields.length > 0 ? { fields: step.fields } : {}),
          screenshot: step.screenshot === true,
          ...(step.rememberUrlKeyedByVar ? { rememberKeyVar: step.rememberUrlKeyedByVar } : {}),
          ...(step.forEachLink ? { forEachLink: step.forEachLink } : {}),
          ...(forEachMatch !== undefined ? { forEachMatch } : {}),
          ...(step.skipWhenText && step.skipWhenText.trim()
            ? { skipWhenText: step.skipWhenText.trim() }
            : {})
        }
      };
    }
    case "recall_url": {
      // Gather candidate phone keys: the inbound group participants and/or vars
      // the author named, all normalized to E.164 and deduped (priority order).
      const keys: string[] = [];
      const seen = new Set<string>();
      const add = (raw: unknown) => {
        if (typeof raw !== "string") return;
        const norm = normalizeNanpToE164(raw);
        if (norm && !seen.has(norm)) {
          seen.add(norm);
          keys.push(norm);
        }
      };
      if (step.keyFromTrigger === "participants") {
        const parts = scope.trigger?.participants;
        if (Array.isArray(parts)) for (const p of parts) add(p);
      }
      for (const v of step.keyVars ?? []) add(scope.vars?.[v]);
      return { ok: true, action: { kind: "recall_url", keys, saveAs: step.saveAs } };
    }
    case "sleep": {
      // Re-entry after the deferral: the worker stamped the marker before
      // parking, so the step completes as a no-op instead of re-sleeping.
      const marker = `__slept_${step.id}`;
      if (scope.vars?.[marker]) {
        return { ok: true, action: { kind: "set_vars", vars: {} } };
      }
      return {
        ok: true,
        action: {
          kind: "sleep",
          ...(step.minutes !== undefined
            ? { minutes: Math.min(Math.max(1, Math.round(step.minutes)), MAX_WAIT_MINUTES) }
            : {}),
          ...(step.untilTime ? { untilTime: step.untilTime } : {}),
          ...(step.timezone ? { timezone: step.timezone } : {}),
          marker
        }
      };
    }
    case "wait_for_reply": {
      const saveAs = step.saveAs ?? "reply_text";
      // Resolution is tracked PER STEP (not per saveAs var): a later wait
      // reusing the same var must still park, so an earlier wait's reply can
      // never satisfy this one. The resume/timeout paths stamp this marker
      // alongside the saveAs var.
      const marker = `__waited_${step.id}`;
      if (scope.vars?.[marker] !== undefined) {
        return { ok: true, action: { kind: "set_vars", vars: {} } };
      }
      const raw = scope.vars?.[step.phoneVar];
      const phone = typeof raw === "string" ? raw.trim() : "";
      const e164 = phone ? (isE164(phone) ? phone : normalizeNanpToE164(phone)) : null;
      if (!e164) {
        // A lead-data gap, not a flow bug: resolve straight to the no-reply
        // branch instead of parking a run that can never be resumed.
        // NO_REPLY_SENTINEL (not ""): when-conditions require non-empty values.
        return {
          ok: true,
          action: { kind: "set_vars", vars: { [saveAs]: NO_REPLY_SENTINEL, [marker]: "1" } }
        };
      }
      const timeoutMinutes = Math.min(
        Math.max(1, Math.round(step.timeoutMinutes ?? 1440)),
        MAX_WAIT_MINUTES
      );
      return {
        ok: true,
        action: { kind: "wait_for_reply", from: e164, saveAs, marker, timeoutMinutes }
      };
    }
    case "branch": {
      // Evaluate the arms top to bottom (first match wins, else on no match)
      // and record the choice as an engine var. The worker's flat loop then
      // skips every step on an untaken arm via isOnActivePath — the branch
      // step itself is just this one var write.
      const chosen = chooseBranchArm(step, scope);
      const label =
        chosen === "else"
          ? "none matched"
          : (step.branches.find((a) => a.id === chosen)?.label ?? chosen);
      return {
        ok: true,
        action: {
          kind: "set_vars",
          vars: { [branchChoiceVar(step.id)]: chosen, [`__branch_label_${step.id}`]: label }
        }
      };
    }
    case "upsert_customer": {
      const raw = scope.vars?.[step.phoneVar];
      const phone = typeof raw === "string" ? raw.trim() : "";
      // Accept an already-E.164 phone or a loose North-American number; the
      // customer record is keyed by E.164, so an unusable value is a recoverable
      // "missing input" (skip-able), not a thrown error.
      const e164 = phone ? (isE164(phone) ? phone : normalizeNanpToE164(phone)) : null;
      if (!e164) {
        return {
          ok: false,
          error:
            `upsert_customer: the lead's phone ({{vars.${step.phoneVar}}}) is missing or unusable — ` +
            `it may not have been in the source at all, or it matched the business's own number ` +
            `and was discarded (see this run's notes). The flow can't contact this lead by text.`
        };
      }
      const readVar = (name?: string): string => {
        if (!name) return "";
        const v = scope.vars?.[name];
        return typeof v === "string" ? v.trim() : "";
      };
      return {
        ok: true,
        action: {
          kind: "upsert_customer",
          e164,
          name: readVar(step.nameVar),
          email: readVar(step.emailVar)
        }
      };
    }
    case "classify": {
      // Text source: the named var, or the triggering message's window text.
      const raw = step.textVar ? scope.vars?.[step.textVar] : triggerString(scope, "windowText");
      const text = typeof raw === "string" ? raw.trim() : "";
      // The engine's no-reply/customer-called sentinels are already decisive
      // categories in their own right — don't ask a model to re-read them.
      const sentinel = text === "no_reply" || text === "customer_called" || text === "";
      return {
        ok: true,
        action: {
          kind: "classify",
          text,
          ...(step.question ? { question: step.question } : {}),
          categories: step.categories,
          saveAs: step.saveAs,
          ...(sentinel ? { resolved: text === "" ? "unclear" : text } : {})
        }
      };
    }
    case "generate_image": {
      const prompt = renderTemplate(step.promptTemplate, scope).trim();
      if (!prompt) {
        return { ok: false, error: "generate_image: prompt is empty after templating" };
      }
      return { ok: true, action: { kind: "generate_image", prompt, saveAs: step.saveAs } };
    }
    case "update_contact": {
      const raw = scope.vars?.[step.phoneVar];
      const phone = typeof raw === "string" ? raw.trim() : "";
      const e164 = phone ? (isE164(phone) ? phone : normalizeNanpToE164(phone)) : null;
      const addTags = step.addTags ?? [];
      const removeTags = step.removeTags ?? [];
      if (!e164) {
        // Skip (with a note), never fail: the tag write is auxiliary
        // bookkeeping and a missing lead phone must not kill the run.
        return {
          ok: true,
          action: {
            kind: "update_contact",
            e164: "",
            addTags,
            removeTags,
            skipReason: "no_contact_phone"
          }
        };
      }
      return { ok: true, action: { kind: "update_contact", e164, addTags, removeTags } };
    }
    // Voice steps execute on the real-time Telnyx call path (telnyx-voice-inbound),
    // never on the async worker — they are only valid under a voice trigger, which
    // the batch enqueue paths skip and the worker rejects via isExecutableDefinition.
    // If one somehow reaches here, fail the step rather than silently no-op.
    case "ring_handoff":
    case "voice_ai_intake":
    case "voice_transfer":
    case "outbound_call":
      return {
        ok: false,
        error: `${step.type}: voice steps run on the call path, not the flow worker`
      };
  }
}
