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
import { firstUrlInText, renderTemplate } from "./engine.ts";
import type { BrowseAuth, ExtractField, FlowStep, RouteOfferWindow } from "./types.ts";

export type StepScope = {
  vars?: Record<string, unknown>;
  trigger?: Record<string, unknown>;
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
  kind: "click_text" | "click_selector" | "fill_selector" | "fill_placeholder";
  target: string;
  value: string;
};

export type StepAction =
  | { kind: "set_vars"; vars: Record<string, string> }
  | { kind: "browse"; url: string; fields: ExtractField[]; auth?: BrowseAuth; screenshot?: boolean }
  | { kind: "send_sms"; to: string; body: string; quiet?: SendSmsQuietPlan }
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
      /** After-hours claim-deadline extension. */
      offerWindow?: RouteOfferWindow;
      /** Attach the stored browse screenshot to each agent offer as MMS. */
      attachScreenshot: boolean;
    }
  | {
      kind: "browse_action";
      url: string;
      auth?: BrowseAuth;
      actions: BrowseActionPlanned[];
      screenshot: boolean;
    };

export type StepPlan =
  | { ok: true; action: StepAction }
  | { ok: false; error: string };

function triggerString(scope: StepScope, key: string): string {
  const v = scope.trigger?.[key];
  return typeof v === "string" ? v : "";
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
          fields: step.fields,
          auth: step.auth,
          screenshot: step.screenshot
        }
      };
    }
    case "send_sms": {
      const to = renderTemplate(step.to, scope).trim();
      const body = renderTemplate(step.body, scope).trim();
      if (!to) return { ok: false, error: "send_sms: recipient is empty after templating" };
      if (!body) return { ok: false, error: "send_sms: body is empty after templating" };
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
      return { ok: true, action: { kind: "send_sms", to, body, ...(quiet ? { quiet } : {}) } };
    }
    case "send_email": {
      const to = renderTemplate(step.to, scope).trim();
      const subject = renderTemplate(step.subject, scope).trim();
      const body = renderTemplate(step.body, scope).trim();
      if (!to) return { ok: false, error: "send_email: recipient is empty after templating" };
      if (!subject) return { ok: false, error: "send_email: subject is empty after templating" };
      if (!body) return { ok: false, error: "send_email: body is empty after templating" };
      // Render each cc/bcc template and drop entries that resolve to empty
      // (e.g. a {{vars.x}} that wasn't produced), so a blank slot never sends.
      const cc = (step.cc ?? [])
        .map((entry) => renderTemplate(entry, scope).trim())
        .filter((entry) => entry.length > 0);
      const bcc = (step.bcc ?? [])
        .map((entry) => renderTemplate(entry, scope).trim())
        .filter((entry) => entry.length > 0);
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
      return {
        ok: true,
        action: {
          kind: "route_to_team",
          offerTemplate,
          responseMinutes,
          ownerFallbackTemplate,
          claimedNotifyTemplate: claimed ? claimed : undefined,
          ...(agentName ? { agentName } : {}),
          ...(step.offerWindow ? { offerWindow: step.offerWindow } : {}),
          attachScreenshot: step.attachScreenshot === true
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
      return {
        ok: true,
        action: {
          kind: "browse_action",
          url,
          auth: step.auth,
          actions,
          screenshot: step.screenshot === true
        }
      };
    }
  }
}
