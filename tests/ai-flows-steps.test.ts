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
  it("carries an auth config into the browse action", () => {
    const authed: FlowStep = {
      id: "b",
      type: "browse_extract",
      urlVar: "lead_url",
      fields: [{ name: "seller_phone" }],
      auth: { integrationLabel: "Referral Exchange", login: { usernameSelector: "#email" } }
    };
    expect(planStep(authed, { vars: { lead_url: "https://rfrl.to/x" } })).toEqual({
      ok: true,
      action: {
        kind: "browse",
        url: "https://rfrl.to/x",
        fields: [{ name: "seller_phone" }],
        auth: { integrationLabel: "Referral Exchange", login: { usernameSelector: "#email" } }
      }
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
  it("still plans normally when the step carries a `when` guard (guard is the worker's job)", () => {
    const gated: FlowStep = {
      id: "x",
      type: "send_sms",
      to: "{{vars.lead_phone}}",
      body: "buyer copy",
      when: { var: "lead_type", contains: "buyer" }
    };
    expect(planStep(gated, { vars: { lead_phone: "+16026866672", lead_type: "buyer" } })).toEqual({
      ok: true,
      action: { kind: "send_sms", to: "+16026866672", body: "buyer copy" }
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

describe("planStep: route_to_team", () => {
  const base: FlowStep = {
    id: "r",
    type: "route_to_team",
    offerTemplate: "New lead {{vars.lead_name}}, reply 1/2",
    ownerFallbackTemplate: "No one claimed {{vars.lead_name}}",
    claimedNotifyTemplate: "{{agent.name}} claimed it"
  };
  it("passes templates through UNRENDERED (agent is resolved by the worker)", () => {
    expect(planStep(base, { vars: { lead_name: "Pat" } })).toEqual({
      ok: true,
      action: {
        kind: "route_to_team",
        offerTemplate: "New lead {{vars.lead_name}}, reply 1/2",
        responseMinutes: 10,
        ownerFallbackTemplate: "No one claimed {{vars.lead_name}}",
        claimedNotifyTemplate: "{{agent.name}} claimed it"
      }
    });
  });
  it("defaults responseMinutes to 10 and rounds/clamps a provided value", () => {
    const r1 = planStep({ ...base, responseMinutes: 3 }, {});
    expect(r1.ok && r1.action.kind === "route_to_team" && r1.action.responseMinutes).toBe(3);
    const r2 = planStep({ ...base, responseMinutes: 0 }, {});
    // min(1) clamp
    expect(r2.ok && r2.action.kind === "route_to_team" && r2.action.responseMinutes).toBe(1);
  });
  it("drops an empty claimedNotifyTemplate to undefined", () => {
    const r = planStep({ ...base, claimedNotifyTemplate: "   " }, {});
    expect(r.ok && r.action.kind === "route_to_team" && r.action.claimedNotifyTemplate).toBeUndefined();
  });
  it("omits claimedNotifyTemplate entirely (optional)", () => {
    const { claimedNotifyTemplate: _omit, ...noClaim } = base as Extract<
      FlowStep,
      { type: "route_to_team" }
    >;
    void _omit;
    const r = planStep(noClaim, {});
    expect(r.ok && r.action.kind === "route_to_team" && r.action.claimedNotifyTemplate).toBeUndefined();
  });
  it("fails when offerTemplate is blank", () => {
    expect(planStep({ ...base, offerTemplate: "   " }, {})).toEqual({
      ok: false,
      error: "route_to_team: offerTemplate is empty"
    });
  });
  it("fails when ownerFallbackTemplate is blank", () => {
    expect(planStep({ ...base, ownerFallbackTemplate: "" }, {})).toEqual({
      ok: false,
      error: "route_to_team: ownerFallbackTemplate is empty"
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
