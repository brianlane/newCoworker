import { describe, expect, it } from "vitest";
import { planStep, type StepScope } from "../supabase/functions/_shared/ai_flows/steps";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";

describe("planStep: sleep", () => {
  it("plans a relative wait with the re-entry marker, capping minutes at 30 days", () => {
    const plan = planStep({ id: "z1", type: "sleep", minutes: 300 } as FlowStep, { vars: {} });
    expect(plan).toEqual({
      ok: true,
      action: { kind: "sleep", minutes: 300, marker: "__slept_z1" }
    });
    const capped = planStep({ id: "z1", type: "sleep", minutes: 999999 } as FlowStep, { vars: {} });
    expect(capped.ok && capped.action.kind === "sleep" && capped.action.minutes).toBe(43200);
  });
  it("plans an until-time wait carrying the timezone", () => {
    const plan = planStep(
      { id: "z2", type: "sleep", untilTime: "08:30", timezone: "America/Toronto" } as FlowStep,
      { vars: {} }
    );
    expect(plan).toEqual({
      ok: true,
      action: {
        kind: "sleep",
        untilTime: "08:30",
        timezone: "America/Toronto",
        marker: "__slept_z2"
      }
    });
  });
  it("completes as a no-op on re-entry (the worker stamped the marker before parking)", () => {
    const plan = planStep({ id: "z1", type: "sleep", minutes: 300 } as FlowStep, {
      vars: { __slept_z1: "1" }
    });
    expect(plan).toEqual({ ok: true, action: { kind: "set_vars", vars: {} } });
  });
});

describe("planStep: wait_for_reply", () => {
  const step = {
    id: "w1",
    type: "wait_for_reply",
    phoneVar: "lead_phone",
    timeoutMinutes: 300
  } as FlowStep;

  it("parks on the normalized phone with the default saveAs and per-step marker", () => {
    const plan = planStep(step, { vars: { lead_phone: "(647) 449-4244" } });
    expect(plan).toEqual({
      ok: true,
      action: {
        kind: "wait_for_reply",
        from: "+16474494244",
        saveAs: "reply_text",
        marker: "__waited_w1",
        timeoutMinutes: 300
      }
    });
  });
  it("defaults the timeout to 24h and caps it at 30 days", () => {
    const noTimeout = planStep(
      { id: "w2", type: "wait_for_reply", phoneVar: "p" } as FlowStep,
      { vars: { p: "+16025551234" } }
    );
    expect(noTimeout.ok && noTimeout.action.kind === "wait_for_reply" && noTimeout.action.timeoutMinutes).toBe(1440);
    const capped = planStep(
      { id: "w3", type: "wait_for_reply", phoneVar: "p", timeoutMinutes: 999999 } as FlowStep,
      { vars: { p: "+16025551234" } }
    );
    expect(capped.ok && capped.action.kind === "wait_for_reply" && capped.action.timeoutMinutes).toBe(43200);
  });
  it("completes only via ITS OWN marker — a stale saveAs from an earlier wait still parks", () => {
    // Marker set (this step's resume/timeout ran) → no-op completion.
    const resolved = planStep(step, {
      vars: { lead_phone: "+16474494244", reply_text: "yes please", __waited_w1: "1" }
    });
    expect(resolved).toEqual({ ok: true, action: { kind: "set_vars", vars: {} } });
    // saveAs set by an EARLIER wait but no marker for THIS step → park again
    // (Bugbot 868c00ba: two waits sharing reply_text must both wait).
    const stale = planStep(step, {
      vars: { lead_phone: "+16474494244", reply_text: "earlier answer" }
    });
    expect(stale.ok && stale.action.kind).toBe("wait_for_reply");
  });
  it("resolves straight to the no-reply branch when the phone is unusable", () => {
    for (const vars of [{}, { lead_phone: "none" }, { lead_phone: "12345" }]) {
      const plan = planStep(step, { vars });
      expect(plan).toEqual({
        ok: true,
        action: { kind: "set_vars", vars: { reply_text: "no_reply", __waited_w1: "1" } }
      });
    }
  });
});

describe("planStep: classify", () => {
  const step = {
    id: "c1",
    type: "classify",
    textVar: "reply_text",
    question: "Why are they shopping?",
    categories: [
      { value: "wants_a_call", description: "asks to talk" },
      { value: "not_interested" }
    ],
    saveAs: "intent"
  } as FlowStep;

  it("plans a model call for real text (var source)", () => {
    const plan = planStep(step, { vars: { reply_text: "can someone ring me today?" } });
    expect(plan).toEqual({
      ok: true,
      action: {
        kind: "classify",
        text: "can someone ring me today?",
        question: "Why are they shopping?",
        categories: [
          { value: "wants_a_call", description: "asks to talk" },
          { value: "not_interested" }
        ],
        saveAs: "intent"
      }
    });
  });

  it("reads the triggering message when no textVar is set", () => {
    const plan = planStep(
      { id: "c2", type: "classify", categories: [{ value: "a" }, { value: "b" }], saveAs: "x" } as FlowStep,
      { trigger: { windowText: "hello there" } }
    );
    expect(plan.ok && plan.action.kind === "classify" && plan.action.text).toBe("hello there");
  });

  it("pre-resolves sentinels without a model call: empty → unclear, engine sentinels pass through", () => {
    const empty = planStep(step, { vars: {} });
    expect(empty.ok && empty.action.kind === "classify" && empty.action.resolved).toBe("unclear");
    const noReply = planStep(step, { vars: { reply_text: "no_reply" } });
    expect(noReply.ok && noReply.action.kind === "classify" && noReply.action.resolved).toBe(
      "no_reply"
    );
    const called = planStep(step, { vars: { reply_text: "customer_called" } });
    expect(called.ok && called.action.kind === "classify" && called.action.resolved).toBe(
      "customer_called"
    );
  });
});

describe("planStep: update_contact", () => {
  const step = {
    id: "u1",
    type: "update_contact",
    phoneVar: "lead_phone",
    addTags: ["Contacted"],
    removeTags: ["New Lead"]
  } as FlowStep;

  it("resolves the phone and carries the tag lists", () => {
    const plan = planStep(step, { vars: { lead_phone: "(647) 449-4244" } });
    expect(plan).toEqual({
      ok: true,
      action: {
        kind: "update_contact",
        e164: "+16474494244",
        addTags: ["Contacted"],
        removeTags: ["New Lead"]
      }
    });
  });

  it("defaults absent tag lists to empty arrays", () => {
    const addOnly = planStep(
      { id: "u2", type: "update_contact", phoneVar: "p", addTags: ["VIP"] } as FlowStep,
      { vars: { p: "+16025551234" } }
    );
    expect(addOnly).toEqual({
      ok: true,
      action: { kind: "update_contact", e164: "+16025551234", addTags: ["VIP"], removeTags: [] }
    });
    const removeOnly = planStep(
      { id: "u3", type: "update_contact", phoneVar: "p", removeTags: ["Lost"] } as FlowStep,
      { vars: { p: "+16025551234" } }
    );
    expect(removeOnly).toEqual({
      ok: true,
      action: { kind: "update_contact", e164: "+16025551234", addTags: [], removeTags: ["Lost"] }
    });
  });

  it("skips (never fails) when the phone is unusable — tag bookkeeping is auxiliary", () => {
    for (const vars of [{}, { lead_phone: "none" }, { lead_phone: "12345" }]) {
      const plan = planStep(step, { vars });
      expect(plan).toEqual({
        ok: true,
        action: {
          kind: "update_contact",
          e164: "",
          addTags: ["Contacted"],
          removeTags: ["New Lead"],
          skipReason: "no_contact_phone"
        }
      });
    }
  });
});

describe("planStep: unknown step types", () => {
  it("returns undefined for a step type this build doesn't know (the worker guards on it)", () => {
    // Runtime version skew: a stored definition can carry a step type newer
    // than the deployed worker. planStep's exhaustive switch falls through to
    // undefined; the worker converts that into a readable run failure telling
    // ops to redeploy — never a bare TypeError.
    const plan = planStep(
      { id: "x", type: "step_from_the_future" } as unknown as FlowStep,
      { vars: {} }
    );
    expect(plan).toBeUndefined();
  });
});

describe("planStep: voice steps are rejected by the async worker", () => {
  it.each<FlowStep>([
    { id: "r", type: "ring_handoff", toE164: "+16025245719" },
    { id: "a", type: "voice_ai_intake", notifyE164: "+16026951142" },
    { id: "t", type: "voice_transfer", toE164: "+16026951142" },
    { id: "o", type: "outbound_call", notifyE164: "+16026951142" }
  ])("fails for %s (runs on the call path, not the worker)", (step) => {
    const r = planStep(step, { trigger: {} });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error).toContain("voice steps run on the call path");
  });
});

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
  it("carries the screenshot flag into the browse action", () => {
    const withShot: FlowStep = {
      id: "b",
      type: "browse_extract",
      urlVar: "lead_url",
      fields: [{ name: "seller_phone" }],
      screenshot: true
    };
    const r = planStep(withShot, { vars: { lead_url: "https://rfrl.to/x" } });
    expect(r.ok && r.action.kind === "browse" && r.action.screenshot).toBe(true);
  });
  it("carries a trimmed skipWhenText marker into the browse action", () => {
    const withSkip: FlowStep = {
      id: "b",
      type: "browse_extract",
      urlVar: "lead_url",
      fields: [{ name: "seller_phone" }],
      skipWhenText: "  already been claimed  "
    };
    const r = planStep(withSkip, { vars: { lead_url: "https://rfrl.to/x" } });
    expect(r.ok && r.action.kind === "browse" && r.action.skipWhenText).toBe(
      "already been claimed"
    );
  });
  it("omits skipWhenText when unset", () => {
    const r = planStep(step, { vars: { lead_url: "https://rfrl.to/x" } });
    expect(r.ok && r.action.kind === "browse" && "skipWhenText" in r.action).toBe(false);
  });
  it("omits skipWhenText when blank after trim", () => {
    const blank: FlowStep = {
      id: "b",
      type: "browse_extract",
      urlVar: "lead_url",
      fields: [{ name: "seller_phone" }],
      skipWhenText: "   "
    };
    const r = planStep(blank, { vars: { lead_url: "https://rfrl.to/x" } });
    expect(r.ok && r.action.kind === "browse" && "skipWhenText" in r.action).toBe(false);
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
  it("carries extractLinks alongside fields into the browse action", () => {
    const withLinks: FlowStep = {
      id: "b",
      type: "browse_extract",
      urlVar: "lead_url",
      fields: [{ name: "seller_phone" }],
      extractLinks: [{ name: "claim_link", matchText: "Call me to claim referral" }]
    };
    const r = planStep(withLinks, { vars: { lead_url: "https://rfrl.to/x" } });
    expect(r).toEqual({
      ok: true,
      action: {
        kind: "browse",
        url: "https://rfrl.to/x",
        fields: [{ name: "seller_phone" }],
        extractLinks: [{ name: "claim_link", matchText: "Call me to claim referral" }]
      }
    });
  });
  it("supports a links-only browse_extract (no fields key in the action)", () => {
    const linksOnly: FlowStep = {
      id: "b",
      type: "browse_extract",
      urlVar: "lead_url",
      extractLinks: [{ name: "claim_link", matchText: "claim" }]
    };
    const r = planStep(linksOnly, { vars: { lead_url: "https://rfrl.to/x" } });
    expect(r.ok && "fields" in r.action).toBe(false);
    expect(r).toEqual({
      ok: true,
      action: {
        kind: "browse",
        url: "https://rfrl.to/x",
        extractLinks: [{ name: "claim_link", matchText: "claim" }]
      }
    });
  });
});

describe("planStep: extract_text", () => {
  const step: FlowStep = {
    id: "t",
    type: "extract_text",
    fields: [{ name: "buyer_phone" }, { name: "buyer_name" }]
  };
  it("returns an extract_text action carrying the trigger windowText and fields", () => {
    const scope: StepScope = { trigger: { windowText: "New inquiry: Jane 480-555-0100" } };
    expect(planStep(step, scope)).toEqual({
      ok: true,
      action: {
        kind: "extract_text",
        text: "New inquiry: Jane 480-555-0100",
        fields: [{ name: "buyer_phone" }, { name: "buyer_name" }]
      }
    });
  });
  it("fails when there is no message text to read", () => {
    expect(planStep(step, { trigger: {} })).toEqual({
      ok: false,
      error: "extract_text: no message text to read"
    });
    expect(planStep(step, { trigger: { windowText: "   " } }).ok).toBe(false);
  });
});

describe("planStep: email_extract", () => {
  const base: FlowStep = {
    id: "e",
    type: "email_extract",
    connectionId: "11111111-1111-1111-1111-111111111111",
    fromContains: "homelight.com",
    matchTemplates: ["{{vars.lead_first_name}}", "{{vars.city}}"],
    lookbackMinutes: 30,
    fillOnlyEmpty: true,
    fields: [{ name: "lead_phone" }, { name: "lead_address" }]
  };
  it("renders every body-match term and carries the mailbox config", () => {
    const scope: StepScope = { vars: { lead_first_name: "Javier", city: "Mesa, AZ" } };
    expect(planStep(base, scope)).toEqual({
      ok: true,
      action: {
        kind: "email_extract",
        connectionId: "11111111-1111-1111-1111-111111111111",
        fromContains: "homelight.com",
        bodyContains: ["Javier", "Mesa, AZ"],
        lookbackMinutes: 30,
        fields: [{ name: "lead_phone" }, { name: "lead_address" }],
        fillOnlyEmpty: true
      }
    });
  });
  it("drops terms that render blank so a missing optional var never blocks the match", () => {
    const r = planStep(base, { vars: { lead_first_name: "Javier" } });
    expect(r.ok && r.action.kind === "email_extract" && r.action.bodyContains).toEqual(["Javier"]);
  });
  it("treats a missing matchTemplates as no body filter", () => {
    const step: FlowStep = { ...base, matchTemplates: undefined };
    const r = planStep(step, { vars: {} });
    expect(r.ok && r.action.kind === "email_extract" && r.action.bodyContains).toEqual([]);
  });
  it("defaults lookback to 60 minutes and fillOnlyEmpty to false when omitted", () => {
    const step: FlowStep = {
      id: "e",
      type: "email_extract",
      connectionId: "11111111-1111-1111-1111-111111111111",
      fields: [{ name: "lead_phone" }]
    };
    const r = planStep(step, { vars: {} });
    expect(r.ok && r.action.kind === "email_extract" && r.action.lookbackMinutes).toBe(60);
    expect(r.ok && r.action.kind === "email_extract" && r.action.fillOnlyEmpty).toBe(false);
    expect(r.ok && r.action.kind === "email_extract" && r.action.fromContains).toBe("");
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
  it("plans a SKIP when a templated recipient resolves empty (lead-data gap, not config bug)", () => {
    expect(planStep(step, { vars: {}, trigger: { from: "+1" } })).toEqual({
      ok: true,
      action: {
        kind: "send_sms",
        to: "",
        body: "Hi, are you still interested? - +1",
        skipReason: "no_recipient_phone"
      }
    });
  });
  it("plans a SKIP for 'none'-class templated recipients (extraction answered 'none')", () => {
    for (const none of ["none", "N/A", "unknown", "null", "na"]) {
      const r = planStep(step, { vars: { seller_phone: none }, trigger: { from: "+1" } });
      expect(r.ok && r.action.kind === "send_sms" && r.action.skipReason).toBe(
        "no_recipient_phone"
      );
    }
  });
  it("fails when `to` is absent and replyToGroup is off", () => {
    const noTo: FlowStep = { id: "x", type: "send_sms", body: "hi" };
    expect(planStep(noTo, {})).toEqual({
      ok: false,
      error: "send_sms: recipient is empty after templating"
    });
  });
  it("coerces a page-formatted NANP recipient to E.164 (Telnyx only accepts E.164)", () => {
    const scope: StepScope = { vars: { seller_phone: "(840) 275-3158" } };
    const r = planStep(step, scope);
    expect(r.ok && r.action.kind === "send_sms" && r.action.to).toBe("+18402753158");
  });
  it("coerces an 11-digit 1-prefixed recipient to E.164", () => {
    const scope: StepScope = { vars: { seller_phone: "1-840-275-3158" } };
    const r = planStep(step, scope);
    expect(r.ok && r.action.kind === "send_sms" && r.action.to).toBe("+18402753158");
  });
  it("plans a SKIP when a templated recipient is not a parseable phone", () => {
    const scope: StepScope = { vars: { seller_phone: "call the office" } };
    expect(planStep(step, scope)).toEqual({
      ok: true,
      action: {
        kind: "send_sms",
        to: "",
        // {{trigger.from}} resolves empty (no trigger in scope) and the body
        // is trimmed by the planner.
        body: "Hi, are you still interested? -",
        skipReason: "unparseable_recipient_phone"
      }
    });
  });
  it("still HARD-FAILS a literal (non-templated) bad recipient — that's a config bug", () => {
    const literal: FlowStep = { id: "x", type: "send_sms", to: "call the office", body: "hi" };
    expect(planStep(literal, {})).toEqual({
      ok: false,
      error: 'send_sms: recipient "call the office" is not a valid phone number'
    });
  });
  it("passes an already-E.164 international recipient through untouched", () => {
    const scope: StepScope = { vars: { seller_phone: "+447911123456" } };
    const r = planStep(step, scope);
    expect(r.ok && r.action.kind === "send_sms" && r.action.to).toBe("+447911123456");
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

  it("passes toAgentName + UNRENDERED body through (worker resolves the agent)", () => {
    const agentSend: FlowStep = {
      id: "x",
      type: "send_sms",
      toAgentName: "Dave",
      body: "{{agent.name}}, offers: {{trigger.windowText}}"
    };
    expect(planStep(agentSend, { trigger: { windowText: "Cash: $400k" } })).toEqual({
      ok: true,
      action: {
        kind: "send_sms",
        to: "",
        toAgentName: "Dave",
        body: "{{agent.name}}, offers: {{trigger.windowText}}"
      }
    });
  });

  it("carries quiet hours into a toAgentName send", () => {
    const agentSend: FlowStep = {
      id: "x",
      type: "send_sms",
      toAgentName: "Dave",
      body: "{{agent.name}}, heads up",
      quietHours: { timezone: "America/Phoenix", noSendAfter: "22:00", resumeAt: "08:30" }
    };
    const r = planStep(agentSend, {});
    expect(r).toEqual({
      ok: true,
      action: {
        kind: "send_sms",
        to: "",
        toAgentName: "Dave",
        body: "{{agent.name}}, heads up",
        quiet: {
          timezone: "America/Phoenix",
          noSendAfter: "22:00",
          resumeAt: "08:30",
          emailTo: "",
          emailSubject: "Following up on your inquiry"
        }
      }
    });
  });

  it("passes toRef + UNRENDERED body through (worker resolves the number/source)", () => {
    const refSend: FlowStep = {
      id: "x",
      type: "send_sms",
      toRef: { source: "employee", id: "11111111-1111-1111-1111-111111111111", label: "Dave" },
      body: "{{agent.name}}, offers: {{trigger.windowText}}"
    };
    expect(planStep(refSend, { trigger: { windowText: "Cash: $400k" } })).toEqual({
      ok: true,
      action: {
        kind: "send_sms",
        to: "",
        toRef: { source: "employee", id: "11111111-1111-1111-1111-111111111111", label: "Dave" },
        body: "{{agent.name}}, offers: {{trigger.windowText}}"
      }
    });
  });

  it("carries quiet hours into a toRef send", () => {
    const refSend: FlowStep = {
      id: "x",
      type: "send_sms",
      toRef: { source: "contact", id: "22222222-2222-2222-2222-222222222222" },
      body: "Hi there",
      quietHours: { timezone: "America/Phoenix", noSendAfter: "22:00", resumeAt: "08:30" }
    };
    const r = planStep(refSend, {});
    expect(r).toEqual({
      ok: true,
      action: {
        kind: "send_sms",
        to: "",
        toRef: { source: "contact", id: "22222222-2222-2222-2222-222222222222" },
        body: "Hi there",
        quiet: {
          timezone: "America/Phoenix",
          noSendAfter: "22:00",
          resumeAt: "08:30",
          emailTo: "",
          emailSubject: "Following up on your inquiry"
        }
      }
    });
  });
});

describe("planStep: send_sms quietHours", () => {
  const base: FlowStep = {
    id: "x",
    type: "send_sms",
    to: "{{vars.lead_phone}}",
    body: "hi",
    quietHours: {
      timezone: "America/Phoenix",
      noSendAfter: "22:00",
      resumeAt: "08:30",
      emailFallbackVar: "lead_email",
      emailSubject: "Re: {{vars.lead_name}}",
      emailFromConnectionId: "22222222-2222-4222-8222-222222222222"
    }
  };
  it("resolves the email fallback var and renders the subject", () => {
    const r = planStep(base, {
      vars: { lead_phone: "+16025550100", lead_email: " lead@x.com ", lead_name: "Pat" }
    });
    expect(r).toEqual({
      ok: true,
      action: {
        kind: "send_sms",
        to: "+16025550100",
        body: "hi",
        quiet: {
          timezone: "America/Phoenix",
          noSendAfter: "22:00",
          resumeAt: "08:30",
          emailTo: "lead@x.com",
          emailSubject: "Re: Pat",
          emailFromConnectionId: "22222222-2222-4222-8222-222222222222"
        }
      }
    });
  });
  it("uses an empty emailTo when the fallback var is missing or non-string", () => {
    const r = planStep(base, { vars: { lead_phone: "+16025550100", lead_email: 42 } });
    expect(r.ok && r.action.kind === "send_sms" && r.action.quiet?.emailTo).toBe("");
  });
  it('rejects a non-address fallback value (extraction answers like "none")', () => {
    const r = planStep(base, { vars: { lead_phone: "+16025550100", lead_email: "none" } });
    expect(r.ok && r.action.kind === "send_sms" && r.action.quiet?.emailTo).toBe("");
  });
  it("defaults the email subject and omits the connection id when unset", () => {
    const noExtras: FlowStep = {
      id: "x",
      type: "send_sms",
      to: "+16025550100",
      body: "hi",
      quietHours: { timezone: "America/Phoenix", noSendAfter: "22:00", resumeAt: "08:30" }
    };
    const r = planStep(noExtras, { vars: {} });
    expect(r.ok && r.action.kind === "send_sms" && r.action.quiet).toEqual({
      timezone: "America/Phoenix",
      noSendAfter: "22:00",
      resumeAt: "08:30",
      emailTo: "",
      emailSubject: "Following up on your inquiry"
    });
  });
  it("omits quiet entirely when the step has no quietHours", () => {
    const plain: FlowStep = { id: "x", type: "send_sms", to: "+16025550100", body: "hi" };
    const r = planStep(plain, {});
    expect(r.ok && r.action.kind === "send_sms" && "quiet" in r.action).toBe(false);
  });
});

describe("planStep: send_email", () => {
  const step: FlowStep = {
    id: "e",
    type: "send_email",
    to: "amy@amylaidlaw.com",
    subject: "{{vars.lead_name}} BS RX",
    body: "New buyer lead {{vars.lead_name}}."
  };
  it("templates subject + body and defaults attachScreenshot to false", () => {
    expect(planStep(step, { vars: { lead_name: "Jane Doe" } })).toEqual({
      ok: true,
      action: {
        kind: "send_email",
        to: "amy@amylaidlaw.com",
        subject: "Jane Doe BS RX",
        body: "New buyer lead Jane Doe.",
        attachScreenshot: false
      }
    });
  });
  it("carries attachScreenshot through", () => {
    const r = planStep({ ...step, attachScreenshot: true }, { vars: { lead_name: "Jane" } });
    expect(r.ok && r.action.kind === "send_email" && r.action.attachScreenshot).toBe(true);
  });
  it("fails when the recipient resolves empty", () => {
    expect(planStep({ ...step, to: "{{vars.owner_email}}" }, { vars: { lead_name: "J" } })).toEqual({
      ok: false,
      error: "send_email: recipient is empty after templating"
    });
  });
  it("fails when the subject resolves empty", () => {
    expect(planStep({ ...step, subject: "{{vars.ghost}}" }, { vars: { lead_name: "J" } })).toEqual({
      ok: false,
      error: "send_email: subject is empty after templating"
    });
  });
  it("fails when the body resolves empty", () => {
    expect(planStep({ ...step, body: "{{vars.ghost}}" }, { vars: { lead_name: "J" } })).toEqual({
      ok: false,
      error: "send_email: body is empty after templating"
    });
  });
  it("renders {{coworker.email}} from scope into body/cc", () => {
    const r = planStep(
      { ...step, body: "Reach me at {{coworker.email}}", cc: ["{{coworker.email}}"] },
      { vars: { lead_name: "Jane" }, coworker: { email: "amy@newcoworker.com" } }
    );
    expect(r.ok && r.action.kind === "send_email" && r.action.body).toBe(
      "Reach me at amy@newcoworker.com"
    );
    expect(r.ok && r.action.kind === "send_email" && r.action.cc).toEqual([
      "amy@newcoworker.com"
    ]);
  });
  it("carries fromConnectionId through (owner-mailbox send)", () => {
    const r = planStep(
      { ...step, fromConnectionId: "33333333-3333-4333-8333-333333333333" },
      { vars: { lead_name: "Jane" } }
    );
    expect(r.ok && r.action.kind === "send_email" && r.action.fromConnectionId).toBe(
      "33333333-3333-4333-8333-333333333333"
    );
  });
  it("renders, validates, lowercases and de-dups cc; drops empty/invalid; splits CSV", () => {
    const r = planStep(
      {
        ...step,
        // CSV in one slot, an uppercase dup, a missing var (empty), and an
        // invalid token — only the valid, de-duplicated addresses survive.
        cc: ["Manager@x.com, ops@x.com", "MANAGER@x.com", "{{vars.missing}}", "not-an-email"],
        bcc: ["archive@x.com"]
      },
      { vars: { lead_name: "Jane" } }
    );
    expect(r.ok && r.action.kind === "send_email" && r.action.cc).toEqual([
      "manager@x.com",
      "ops@x.com"
    ]);
    expect(r.ok && r.action.kind === "send_email" && r.action.bcc).toEqual(["archive@x.com"]);
  });
  it("caps cc at 10 recipients", () => {
    const many = Array.from({ length: 13 }, (_, i) => `u${i}@x.com`);
    const r = planStep({ ...step, cc: many }, { vars: { lead_name: "Jane" } });
    expect(r.ok && r.action.kind === "send_email" && r.action.cc).toHaveLength(10);
  });
  it("omits cc/bcc entirely when none are configured or all resolve empty", () => {
    const r = planStep(
      { ...step, cc: ["{{vars.missing}}"], bcc: [] },
      { vars: { lead_name: "Jane" } }
    );
    expect(r.ok && r.action.kind === "send_email" && "cc" in r.action).toBe(false);
    expect(r.ok && r.action.kind === "send_email" && "bcc" in r.action).toBe(false);
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
        claimedNotifyTemplate: "{{agent.name}} claimed it",
        attachScreenshot: false
      }
    });
  });
  it("carries attachScreenshot through (defaults false)", () => {
    const r = planStep({ ...base, attachScreenshot: true }, {});
    expect(r.ok && r.action.kind === "route_to_team" && r.action.attachScreenshot).toBe(true);
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
  it("carries agentName + offerWindow through, dropping a blank agentName", () => {
    const window = {
      timezone: "America/Phoenix",
      quietStart: "21:00",
      quietEnd: "08:30",
      graceMinutes: 10
    };
    const r = planStep({ ...base, agentName: " Dave ", offerWindow: window }, {});
    expect(r.ok && r.action.kind === "route_to_team" && r.action.agentName).toBe("Dave");
    expect(r.ok && r.action.kind === "route_to_team" && r.action.offerWindow).toEqual(window);
    const blank = planStep({ ...base, agentName: "   " }, {});
    expect(blank.ok && blank.action.kind === "route_to_team" && "agentName" in blank.action).toBe(
      false
    );
  });
  it("carries agentRef through when set, omits it otherwise", () => {
    const ref = { source: "employee", id: "33333333-3333-3333-3333-333333333333", label: "Dave" } as const;
    const r = planStep({ ...base, agentRef: ref }, {});
    expect(r.ok && r.action.kind === "route_to_team" && r.action.agentRef).toEqual(ref);
    const without = planStep({ ...base }, {});
    expect(without.ok && without.action.kind === "route_to_team" && "agentRef" in without.action).toBe(
      false
    );
  });
  it("carries firstToClaim only as an explicit opt-out (undefined/true mean ON)", () => {
    const off = planStep({ ...base, firstToClaim: false }, {});
    expect(off.ok && off.action.kind === "route_to_team" && off.action.firstToClaim).toBe(false);
    const defaulted = planStep(base, {});
    expect(
      defaulted.ok && defaulted.action.kind === "route_to_team" && "firstToClaim" in defaulted.action
    ).toBe(false);
    const explicitOn = planStep({ ...base, firstToClaim: true }, {});
    expect(
      explicitOn.ok &&
        explicitOn.action.kind === "route_to_team" &&
        "firstToClaim" in explicitOn.action
    ).toBe(false);
  });

  it("carries preferContactOwner only when explicitly true (owner-first routing)", () => {
    const on = planStep({ ...base, preferContactOwner: true }, {});
    expect(
      on.ok && on.action.kind === "route_to_team" && on.action.preferContactOwner
    ).toBe(true);
    const defaulted = planStep(base, {});
    expect(
      defaulted.ok &&
        defaulted.action.kind === "route_to_team" &&
        "preferContactOwner" in defaulted.action
    ).toBe(false);
    const explicitOff = planStep({ ...base, preferContactOwner: false }, {});
    expect(
      explicitOff.ok &&
        explicitOff.action.kind === "route_to_team" &&
        "preferContactOwner" in explicitOff.action
    ).toBe(false);
  });

  it("carries the keep-for-owner rule through UNRENDERED, trimmed", () => {
    const r = planStep(
      {
        ...base,
        ownerDirectWhen: { var: "price_band", equals: "over_1m" },
        ownerDirectTemplate: "  Kept for you: {{vars.lead_name}} "
      },
      { vars: { lead_name: "Pat" } }
    );
    expect(r.ok && r.action.kind === "route_to_team" && r.action.ownerDirectWhen).toEqual({
      var: "price_band",
      equals: "over_1m"
    });
    expect(r.ok && r.action.kind === "route_to_team" && r.action.ownerDirectTemplate).toBe(
      "Kept for you: {{vars.lead_name}}"
    );
  });

  it("drops a half-configured keep-for-owner rule instead of half-applying it", () => {
    const onlyWhen = planStep(
      { ...base, ownerDirectWhen: { var: "price_band", equals: "over_1m" } },
      {}
    );
    expect(
      onlyWhen.ok && onlyWhen.action.kind === "route_to_team" && "ownerDirectWhen" in onlyWhen.action
    ).toBe(false);
    const blankTemplate = planStep(
      {
        ...base,
        ownerDirectWhen: { var: "price_band", equals: "over_1m" },
        ownerDirectTemplate: "   "
      },
      {}
    );
    expect(
      blankTemplate.ok &&
        blankTemplate.action.kind === "route_to_team" &&
        "ownerDirectTemplate" in blankTemplate.action
    ).toBe(false);
  });

  it("never carries the removed claimTimeframeOption/lateClaimOption digits", () => {
    // Reply digits are universal ("1" claim, "2" pass); legacy fields on an
    // old stored step type are ignored by planStep, not forwarded.
    const r = planStep({ ...base, claimTimeframeOption: 3, lateClaimOption: 4 } as FlowStep, {});
    expect(r.ok && r.action.kind === "route_to_team" && "claimTimeframeOption" in r.action).toBe(
      false
    );
    expect(r.ok && r.action.kind === "route_to_team" && "lateClaimOption" in r.action).toBe(false);
  });
});

describe("planStep: browse_action", () => {
  const base: FlowStep = {
    id: "u",
    type: "browse_action",
    urlVar: "lead_url",
    actions: [
      { kind: "click_text", target: "Leave an update" },
      { kind: "click_text", target: "No interaction yet" },
      { kind: "fill_placeholder", target: "Add an update", valueTemplate: "AI: {{vars.actions_taken}}" }
    ]
  };
  it("renders fill values and defaults click values to empty strings", () => {
    const r = planStep(base, { vars: { lead_url: "https://rfrl.to/x", actions_taken: "texted lead" } });
    expect(r).toEqual({
      ok: true,
      action: {
        kind: "browse_action",
        url: "https://rfrl.to/x",
        auth: undefined,
        actions: [
          { kind: "click_text", target: "Leave an update", value: "" },
          { kind: "click_text", target: "No interaction yet", value: "" },
          { kind: "fill_placeholder", target: "Add an update", value: "AI: texted lead" }
        ],
        screenshot: false
      }
    });
  });
  it("carries auth + screenshot through", () => {
    const r = planStep(
      { ...base, auth: { integrationLabel: "Referral Exchange" }, screenshot: true },
      { vars: { lead_url: "https://rfrl.to/x" } }
    );
    expect(r.ok && r.action.kind === "browse_action" && r.action.screenshot).toBe(true);
    expect(
      r.ok && r.action.kind === "browse_action" && r.action.auth?.integrationLabel
    ).toBe("Referral Exchange");
  });
  it("fails when the urlVar is missing", () => {
    expect(planStep(base, { vars: {} })).toEqual({
      ok: false,
      error: 'browse_action: urlVar "lead_url" is not set'
    });
  });
  it("fails when no actions are configured", () => {
    expect(planStep({ ...base, actions: [] }, { vars: { lead_url: "https://rfrl.to/x" } })).toEqual({
      ok: false,
      error: "browse_action: no actions configured"
    });
  });
  it("passes a click_text_while_present action through unchanged", () => {
    const wizard: FlowStep = {
      id: "u",
      type: "browse_action",
      urlVar: "lead_url",
      actions: [{ kind: "click_text_while_present", target: "Next" }]
    };
    const r = planStep(wizard, { vars: { lead_url: "https://listwithclever.com/x" } });
    expect(r.ok && r.action.kind === "browse_action" && r.action.actions).toEqual([
      { kind: "click_text_while_present", target: "Next", value: "" }
    ]);
  });
  it("carries same-pass extraction fields through (1b)", () => {
    const withFields: FlowStep = {
      ...base,
      fields: [{ name: "lead_name" }, { name: "lead_phone" }]
    };
    const r = planStep(withFields, { vars: { lead_url: "https://listwithclever.com/x" } });
    expect(r.ok && r.action.kind === "browse_action" && r.action.fields).toEqual([
      { name: "lead_name" },
      { name: "lead_phone" }
    ]);
  });
  it("omits fields entirely when none are configured", () => {
    const r = planStep(base, { vars: { lead_url: "https://rfrl.to/x" } });
    expect(r.ok && r.action.kind === "browse_action" && "fields" in r.action).toBe(false);
  });
});

describe("planStep: send_sms replyToGroup", () => {
  const step: FlowStep = {
    id: "g",
    type: "send_sms",
    replyToGroup: true,
    body: "Hi {{vars.seller_first_name}}!"
  };
  it("replies to every participant except our own number, de-duped; skips junk entries", () => {
    const scope: StepScope = {
      vars: { seller_first_name: "Pat" },
      trigger: {
        to: "+16025550000",
        // Includes our own number (dropped), a dup (de-duped), a non-string
        // (skipped) and a whitespace-only entry (skipped after trim).
        participants: [
          "+16025550000",
          "+14805551111",
          "+14805552222",
          "+14805551111",
          12345,
          "   "
        ]
      }
    };
    expect(planStep(step, scope)).toEqual({
      ok: true,
      action: {
        kind: "send_sms",
        to: "+14805551111",
        recipients: ["+14805551111", "+14805552222"],
        body: "Hi Pat!"
      }
    });
  });
  it("ignores the templated `to` when replyToGroup is set", () => {
    const withTo: FlowStep = { ...step, to: "+19999999999" };
    const r = planStep(withTo, {
      trigger: { to: "+16025550000", participants: ["+16025550000", "+14805551111"] }
    });
    expect(r.ok && r.action.kind === "send_sms" && r.action.recipients).toEqual(["+14805551111"]);
  });
  it("fails when the thread has no other participants", () => {
    expect(
      planStep(step, { trigger: { to: "+16025550000", participants: ["+16025550000"] } })
    ).toEqual({
      ok: false,
      error: "send_sms: replyToGroup but the trigger has no other group participants"
    });
    expect(planStep(step, { trigger: { to: "+16025550000" } }).ok).toBe(false);
  });
  it("still carries quiet hours into a group reply", () => {
    const withQuiet: FlowStep = {
      ...step,
      quietHours: { timezone: "America/Phoenix", noSendAfter: "22:00", resumeAt: "08:30" }
    };
    const r = planStep(withQuiet, {
      trigger: { to: "+16025550000", participants: ["+16025550000", "+14805551111"] }
    });
    expect(r.ok && r.action.kind === "send_sms" && r.action.quiet).toEqual({
      timezone: "America/Phoenix",
      noSendAfter: "22:00",
      resumeAt: "08:30",
      emailTo: "",
      emailSubject: "Following up on your inquiry"
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

describe("planStep: browse_action rememberUrlKeyedByVar", () => {
  const base: FlowStep = {
    id: "acc",
    type: "browse_action",
    urlVar: "lead_url",
    actions: [{ kind: "click_text", target: "Accept" }],
    rememberUrlKeyedByVar: "lead_phone"
  };
  it("passes the remember-key VAR NAME through (resolved post-extraction by the worker)", () => {
    // Even when the var isn't in scope yet (it's extracted in the same pass),
    // the planner forwards the name so the worker can resolve it afterward.
    const r = planStep(base, { vars: { lead_url: "https://x" } });
    expect(r.ok && r.action.kind === "browse_action" && r.action.rememberKeyVar).toBe("lead_phone");
  });
  it("omits rememberKeyVar when not configured", () => {
    const noRemember: FlowStep = { ...base, rememberUrlKeyedByVar: undefined };
    const r = planStep(noRemember, { vars: { lead_url: "https://x" } });
    expect(r.ok && r.action.kind === "browse_action" && "rememberKeyVar" in r.action).toBe(false);
  });
  it("passes forEachLink through to the action", () => {
    const loop: FlowStep = {
      id: "loop",
      type: "browse_action",
      urlVar: "lead_url",
      forEachLink: "a.needs-action",
      actions: [{ kind: "click_text", target: "Provide Update" }]
    };
    const r = planStep(loop, { vars: { lead_url: "https://x" } });
    expect(r.ok && r.action.kind === "browse_action" && r.action.forEachLink).toBe("a.needs-action");
  });
  it("resolves forEachLinkMatchVar into a deduped, trimmed forEachMatch list", () => {
    const loop: FlowStep = {
      id: "loop",
      type: "browse_action",
      urlVar: "lead_url",
      forEachLink: "a.needs-action",
      forEachLinkMatchVar: "lead_names",
      actions: [{ kind: "click_text", target: "Provide Update" }]
    };
    const r = planStep(loop, {
      vars: { lead_url: "https://x", lead_names: "Jane Doe, John Smith\nJane Doe; Bo" }
    });
    expect(r.ok && r.action.kind === "browse_action" && r.action.forEachMatch).toEqual([
      "Jane Doe",
      "John Smith",
      "Bo"
    ]);
  });
  it("attaches an EMPTY forEachMatch when the match var resolves to no names (filter nothing, not all)", () => {
    const loop: FlowStep = {
      id: "loop",
      type: "browse_action",
      urlVar: "lead_url",
      forEachLink: "a.needs-action",
      forEachLinkMatchVar: "lead_names",
      actions: [{ kind: "click_text", target: "Provide Update" }]
    };
    const r = planStep(loop, { vars: { lead_url: "https://x", lead_names: "  , ; \n " } });
    expect(r.ok && r.action.kind === "browse_action" && r.action.forEachMatch).toEqual([]);
  });
  it("attaches an EMPTY forEachMatch when the match var is not a string in scope", () => {
    const loop: FlowStep = {
      id: "loop",
      type: "browse_action",
      urlVar: "lead_url",
      forEachLink: "a.needs-action",
      forEachLinkMatchVar: "lead_names",
      actions: [{ kind: "click_text", target: "Provide Update" }]
    };
    const r = planStep(loop, { vars: { lead_url: "https://x" } });
    expect(r.ok && r.action.kind === "browse_action" && r.action.forEachMatch).toEqual([]);
  });
  it("omits forEachMatch when forEachLinkMatchVar is unset", () => {
    const loop: FlowStep = {
      id: "loop",
      type: "browse_action",
      urlVar: "lead_url",
      forEachLink: "a.needs-action",
      actions: [{ kind: "click_text", target: "Provide Update" }]
    };
    const r = planStep(loop, { vars: { lead_url: "https://x", lead_names: "Jane" } });
    expect(r.ok && r.action.kind === "browse_action" && "forEachMatch" in r.action).toBe(false);
  });
  it("renders click_role / select_option values", () => {
    const step: FlowStep = {
      id: "a",
      type: "browse_action",
      urlVar: "lead_url",
      actions: [
        { kind: "click_role", target: "option", valueTemplate: "Choose {{vars.day}}" },
        { kind: "select_option", target: "#status", valueTemplate: "We Spoke" }
      ]
    };
    const r = planStep(step, { vars: { lead_url: "https://x", day: "Thursday" } });
    expect(r.ok && r.action.kind === "browse_action" && r.action.actions).toEqual([
      { kind: "click_role", target: "option", value: "Choose Thursday" },
      { kind: "select_option", target: "#status", value: "We Spoke" }
    ]);
  });
});

describe("planStep: browse_action skipWhenText", () => {
  const base: FlowStep = {
    id: "acc",
    type: "browse_action",
    urlVar: "lead_url",
    actions: [{ kind: "click_text", target: "Accept" }]
  };
  it("carries a trimmed skipWhenText marker through to the action", () => {
    const step: FlowStep = { ...base, skipWhenText: "  already been claimed  " };
    const r = planStep(step, { vars: { lead_url: "https://x" } });
    expect(r.ok && r.action.kind === "browse_action" && r.action.skipWhenText).toBe(
      "already been claimed"
    );
  });
  it("omits skipWhenText when unset", () => {
    const r = planStep(base, { vars: { lead_url: "https://x" } });
    expect(r.ok && r.action.kind === "browse_action" && "skipWhenText" in r.action).toBe(false);
  });
  it("omits skipWhenText when blank after trim", () => {
    const step: FlowStep = { ...base, skipWhenText: "   " };
    const r = planStep(step, { vars: { lead_url: "https://x" } });
    expect(r.ok && r.action.kind === "browse_action" && "skipWhenText" in r.action).toBe(false);
  });
});

describe("planStep: recall_url", () => {
  it("gathers normalized, deduped keys from participants and keyVars", () => {
    const step: FlowStep = {
      id: "r",
      type: "recall_url",
      keyFromTrigger: "participants",
      keyVars: ["seller_phone"],
      saveAs: "connection_url"
    };
    const r = planStep(step, {
      trigger: { participants: ["+16025550100", "(602) 555-0100", "602-555-0200"] },
      vars: { seller_phone: "6025550300" }
    });
    expect(r).toEqual({
      ok: true,
      action: {
        kind: "recall_url",
        keys: ["+16025550100", "+16025550200", "+16025550300"],
        saveAs: "connection_url"
      }
    });
  });
  it("returns empty keys when nothing resolves", () => {
    const step: FlowStep = { id: "r", type: "recall_url", keyVars: ["x"], saveAs: "u" };
    const r = planStep(step, { vars: { x: "nope" } });
    expect(r).toEqual({ ok: true, action: { kind: "recall_url", keys: [], saveAs: "u" } });
  });
  it("ignores non-string and duplicate participants, with no keyVars", () => {
    const step: FlowStep = {
      id: "r",
      type: "recall_url",
      keyFromTrigger: "participants",
      saveAs: "u"
    };
    const r = planStep(step, {
      trigger: { participants: ["+16025550100", 12345, "(602) 555-0100"] }
    });
    expect(r).toEqual({
      ok: true,
      action: { kind: "recall_url", keys: ["+16025550100"], saveAs: "u" }
    });
  });
  it("yields no keys when participants is not an array", () => {
    const step: FlowStep = {
      id: "r",
      type: "recall_url",
      keyFromTrigger: "participants",
      saveAs: "u"
    };
    expect(planStep(step, { trigger: {} })).toEqual({
      ok: true,
      action: { kind: "recall_url", keys: [], saveAs: "u" }
    });
  });
});

describe("planStep: upsert_customer", () => {
  const base: FlowStep = {
    id: "save",
    type: "upsert_customer",
    phoneVar: "lead_phone",
    nameVar: "lead_name",
    emailVar: "lead_email"
  };
  it("passes an already-E.164 phone through and reads name/email vars", () => {
    const r = planStep(base, {
      vars: { lead_phone: "+14804929641", lead_name: "Manny Rosales", lead_email: "m@example.com" }
    });
    expect(r).toEqual({
      ok: true,
      action: {
        kind: "upsert_customer",
        e164: "+14804929641",
        name: "Manny Rosales",
        email: "m@example.com"
      }
    });
  });
  it("normalizes a loose North-American number and trims the name/email", () => {
    const r = planStep(base, {
      vars: { lead_phone: "(480) 492-9641", lead_name: "  Manny  ", lead_email: "  M@Example.com " }
    });
    expect(r).toEqual({
      ok: true,
      action: { kind: "upsert_customer", e164: "+14804929641", name: "Manny", email: "M@Example.com" }
    });
  });
  it("yields empty name/email when those vars are absent or non-string", () => {
    const noNames: FlowStep = { id: "save", type: "upsert_customer", phoneVar: "lead_phone" };
    expect(planStep(noNames, { vars: { lead_phone: "+14804929641" } })).toEqual({
      ok: true,
      action: { kind: "upsert_customer", e164: "+14804929641", name: "", email: "" }
    });
    const r = planStep(base, { vars: { lead_phone: "+14804929641", lead_name: 42, lead_email: null } });
    expect(r).toEqual({
      ok: true,
      action: { kind: "upsert_customer", e164: "+14804929641", name: "", email: "" }
    });
  });
  it("fails with a human-readable explanation when the phone var is missing", () => {
    const r = planStep(base, { vars: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Owner-facing wording: names the var, explains the two likely causes
      // (absent from the source / discarded by the self-number scrub), and
      // states the consequence — never a bare technical failure.
      expect(r.error).toContain("{{vars.lead_phone}}");
      expect(r.error).toContain("missing or unusable");
      expect(r.error).toContain("matched the business's own number");
    }
  });
  it("fails when the phone var is not a usable number", () => {
    const r = planStep(base, { vars: { lead_phone: "call me", lead_name: "X" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("missing or unusable");
  });
});

describe("planStep: generate_image", () => {
  it("renders the prompt template and plans the generation", () => {
    const plan = planStep(
      {
        id: "g1",
        type: "generate_image",
        promptTemplate: "A flyer for {{vars.listing_address}}",
        saveAs: "flyer_url"
      } as FlowStep,
      { vars: { listing_address: "12 Oak St" } }
    );
    expect(plan).toEqual({
      ok: true,
      action: { kind: "generate_image", prompt: "A flyer for 12 Oak St", saveAs: "flyer_url" }
    });
  });

  it("fails when the prompt renders empty", () => {
    const plan = planStep(
      { id: "g1", type: "generate_image", promptTemplate: "{{vars.missing}}", saveAs: "img" } as FlowStep,
      { vars: {} }
    );
    expect(plan).toEqual({
      ok: false,
      error: "generate_image: prompt is empty after templating"
    });
  });
});

describe("planStep: send_sms mediaUrlVar (MMS attach)", () => {
  it("attaches the resolved image URL on a plain 1:1 send", () => {
    const plan = planStep(
      {
        id: "s1",
        type: "send_sms",
        to: "+16025551234",
        body: "See the flyer!",
        mediaUrlVar: "flyer_url"
      } as FlowStep,
      { vars: { flyer_url: " https://signed.example/p.png " } }
    );
    expect(plan).toEqual({
      ok: true,
      action: {
        kind: "send_sms",
        to: "+16025551234",
        body: "See the flyer!",
        mediaUrl: "https://signed.example/p.png"
      }
    });
  });

  it("degrades to a plain text send when the var is empty, non-URL prose, or not a string", () => {
    for (const vars of [
      {},
      { flyer_url: "" },
      { flyer_url: "the image could not be generated" },
      { flyer_url: 42 as unknown as string }
    ]) {
      const plan = planStep(
        {
          id: "s1",
          type: "send_sms",
          to: "+16025551234",
          body: "hi",
          mediaUrlVar: "flyer_url"
        } as FlowStep,
        { vars }
      );
      expect(plan.ok && plan.action.kind === "send_sms" && plan.action.mediaUrl).toBeUndefined();
    }
  });

  it("carries the media URL through the toAgentName / toRef / replyToGroup paths", () => {
    const scope: StepScope = {
      vars: { flyer_url: "https://signed.example/p.png" },
      trigger: { to: "+15550000000", participants: ["+15550000000", "+16025551234"] }
    };
    const agent = planStep(
      {
        id: "a",
        type: "send_sms",
        toAgentName: "Dave",
        body: "flyer for {{agent.name}}",
        mediaUrlVar: "flyer_url"
      } as FlowStep,
      scope
    );
    expect(agent.ok && agent.action.kind === "send_sms" && agent.action.mediaUrl).toBe(
      "https://signed.example/p.png"
    );
    const ref = planStep(
      {
        id: "r",
        type: "send_sms",
        toRef: { source: "contact", id: "33333333-3333-4333-8333-333333333333" },
        body: "flyer",
        mediaUrlVar: "flyer_url"
      } as FlowStep,
      scope
    );
    expect(ref.ok && ref.action.kind === "send_sms" && ref.action.mediaUrl).toBe(
      "https://signed.example/p.png"
    );
    const group = planStep(
      {
        id: "g",
        type: "send_sms",
        replyToGroup: true,
        body: "flyer",
        mediaUrlVar: "flyer_url"
      } as FlowStep,
      scope
    );
    expect(group.ok && group.action.kind === "send_sms" && group.action.mediaUrl).toBe(
      "https://signed.example/p.png"
    );
  });
});
