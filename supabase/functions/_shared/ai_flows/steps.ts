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
import type { BrowseAuth, ExtractField, FlowStep } from "./types.ts";

export type StepScope = {
  vars?: Record<string, unknown>;
  trigger?: Record<string, unknown>;
};

export type StepAction =
  | { kind: "set_vars"; vars: Record<string, string> }
  | { kind: "browse"; url: string; fields: ExtractField[]; auth?: BrowseAuth }
  | { kind: "send_sms"; to: string; body: string }
  | { kind: "notify_owner"; message: string }
  | { kind: "await_approval"; prompt: string }
  | {
      kind: "http_call";
      label: string;
      method: string;
      path: string;
      body: string;
      saveAs?: string;
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
      return { ok: true, action: { kind: "browse", url, fields: step.fields, auth: step.auth } };
    }
    case "send_sms": {
      const to = renderTemplate(step.to, scope).trim();
      const body = renderTemplate(step.body, scope).trim();
      if (!to) return { ok: false, error: "send_sms: recipient is empty after templating" };
      if (!body) return { ok: false, error: "send_sms: body is empty after templating" };
      return { ok: true, action: { kind: "send_sms", to, body } };
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
  }
}
