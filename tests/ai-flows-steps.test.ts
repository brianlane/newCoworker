import { describe, expect, it } from "vitest";
import { planStep, type StepScope } from "../supabase/functions/_shared/ai_flows/steps";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";

describe("planStep: extract_url", () => {
  const step: FlowStep = { id: "s", type: "extract_url", saveAs: "lead_url" };
  it("uses the engine-extracted trigger.url", () => {
    const scope: StepScope = { trigger: { url: "https://rfrl.to/x" } };
    expect(planStep(step, scope)).toEqual({
      ok: true,
      action: { kind: "set_vars", vars: { lead_url: "https://rfrl.to/x" } }
    });
  });
  it("falls back to scanning trigger.windowText", () => {
    const scope: StepScope = { trigger: { windowText: "lead at https://rfrl.to/y now" } };
    expect(planStep(step, scope)).toEqual({
      ok: true,
      action: { kind: "set_vars", vars: { lead_url: "https://rfrl.to/y" } }
    });
  });
  it("fails when no URL is present", () => {
    expect(planStep(step, { trigger: {} })).toEqual({
      ok: false,
      error: "extract_url: no URL in the triggering messages"
    });
  });
});

describe("planStep: browse_extract", () => {
  const step: FlowStep = {
    id: "b",
    type: "browse_extract",
    urlVar: "lead_url",
    fields: [{ name: "seller_phone" }]
  };
  it("returns a browse action when the urlVar is set", () => {
    const scope: StepScope = { vars: { lead_url: "https://rfrl.to/x" } };
    expect(planStep(step, scope)).toEqual({
      ok: true,
      action: { kind: "browse", url: "https://rfrl.to/x", fields: [{ name: "seller_phone" }] }
    });
  });
  it("fails when the urlVar is missing or non-string", () => {
    expect(planStep(step, { vars: {} }).ok).toBe(false);
    expect(planStep(step, { vars: { lead_url: 123 } })).toEqual({
      ok: false,
      error: 'browse_extract: urlVar "lead_url" is not set'
    });
  });
});

describe("planStep: send_sms", () => {
  const step: FlowStep = {
    id: "x",
    type: "send_sms",
    to: "{{vars.seller_phone}}",
    body: "Hi, are you still interested? - {{trigger.from}}"
  };
  it("templates recipient + body", () => {
    const scope: StepScope = {
      vars: { seller_phone: "+16026866672" },
      trigger: { from: "+15551112222" }
    };
    expect(planStep(step, scope)).toEqual({
      ok: true,
      action: {
        kind: "send_sms",
        to: "+16026866672",
        body: "Hi, are you still interested? - +15551112222"
      }
    });
  });
  it("fails when the recipient resolves empty", () => {
    expect(planStep(step, { vars: {}, trigger: { from: "+1" } })).toEqual({
      ok: false,
      error: "send_sms: recipient is empty after templating"
    });
  });
  it("fails when the body resolves empty", () => {
    const blankBody: FlowStep = { id: "x", type: "send_sms", to: "+16026866672", body: "{{vars.msg}}" };
    expect(planStep(blankBody, { vars: {} })).toEqual({
      ok: false,
      error: "send_sms: body is empty after templating"
    });
  });
});

describe("planStep: notify_owner", () => {
  it("templates the message", () => {
    const step: FlowStep = { id: "n", type: "notify_owner", message: "New lead {{vars.seller_phone}}" };
    expect(planStep(step, { vars: { seller_phone: "+16026866672" } })).toEqual({
      ok: true,
      action: { kind: "notify_owner", message: "New lead +16026866672" }
    });
  });
  it("fails when the message resolves empty", () => {
    const step: FlowStep = { id: "n", type: "notify_owner", message: "{{vars.x}}" };
    expect(planStep(step, { vars: {} })).toEqual({
      ok: false,
      error: "notify_owner: message is empty after templating"
    });
  });
});

describe("planStep: approval_gate", () => {
  it("returns an await_approval action with templated prompt", () => {
    const step: FlowStep = { id: "a", type: "approval_gate", prompt: "Send to {{vars.seller_phone}}?" };
    expect(planStep(step, { vars: { seller_phone: "+16026866672" } })).toEqual({
      ok: true,
      action: { kind: "await_approval", prompt: "Send to +16026866672?" }
    });
  });
});

describe("planStep: http_call", () => {
  it("defaults method to GET and templates path/body", () => {
    const step: FlowStep = {
      id: "h",
      type: "http_call",
      label: "crm"
    };
    expect(planStep(step, {})).toEqual({
      ok: true,
      action: { kind: "http_call", label: "crm", method: "GET", path: "", body: "", saveAs: undefined }
    });
  });
  it("honors method/path/body/saveAs", () => {
    const step: FlowStep = {
      id: "h",
      type: "http_call",
      label: "crm",
      method: "post",
      path: "/leads/{{vars.seller_phone}}",
      bodyTemplate: '{"phone":"{{vars.seller_phone}}"}',
      saveAs: "crm_resp"
    };
    expect(planStep(step, { vars: { seller_phone: "+16026866672" } })).toEqual({
      ok: true,
      action: {
        kind: "http_call",
        label: "crm",
        method: "POST",
        path: "/leads/+16026866672",
        body: '{"phone":"+16026866672"}',
        saveAs: "crm_resp"
      }
    });
  });
});
