import { describe, expect, it } from "vitest";
import {
  AiFlowValidationError,
  aiFlowDefinitionSchema,
  collectTemplateRefs,
  parseAiFlowDefinition,
  summarizeDefinition,
  validateDefinitionSemantics,
  type AiFlowDefinition
} from "@/lib/ai-flows/schema";

const validInput = {
  version: 1,
  trigger: {
    channel: "sms",
    correlationWindowMinutes: 15,
    conditions: [
      { type: "contains", value: "referral" },
      { type: "has_url" }
    ]
  },
  steps: [
    { id: "s1", type: "extract_url", saveAs: "lead_url" },
    {
      id: "s2",
      type: "browse_extract",
      urlVar: "lead_url",
      fields: [{ name: "seller_phone", description: "the seller phone" }]
    },
    { id: "s3", type: "send_sms", to: "{{vars.seller_phone}}", body: "Hi from {{trigger.from}}" },
    { id: "s4", type: "approval_gate", prompt: "approve?" },
    { id: "s5", type: "notify_owner", message: "done {{vars.seller_phone}}" },
    {
      id: "s6",
      type: "http_call",
      label: "crm",
      method: "POST",
      path: "/leads",
      bodyTemplate: "{{vars.seller_phone}}",
      saveAs: "crm_resp"
    }
  ],
  options: { suppressDefaultReply: true }
};

function baseDef(): AiFlowDefinition {
  return aiFlowDefinitionSchema.parse(JSON.parse(JSON.stringify(validInput)));
}

describe("collectTemplateRefs", () => {
  it("parses dotted and single-token refs", () => {
    expect(collectTemplateRefs("{{vars.x}} {{trigger.url}} {{foo}} plain")).toEqual([
      { scope: "vars", key: "x" },
      { scope: "trigger", key: "url" },
      { scope: "foo", key: "" }
    ]);
  });
  it("returns empty with no refs", () => {
    expect(collectTemplateRefs("nothing here")).toEqual([]);
  });
});

describe("parseAiFlowDefinition", () => {
  it("accepts a fully valid definition", () => {
    const def = parseAiFlowDefinition(validInput);
    expect(def.steps).toHaveLength(6);
    expect(def.options?.suppressDefaultReply).toBe(true);
  });

  it("accepts a browse_extract with an auth (credentialed-browse) block", () => {
    const withAuth = JSON.parse(JSON.stringify(validInput));
    withAuth.steps[1].auth = {
      integrationLabel: "Referral Exchange",
      login: { usernameSelector: "#email", passwordSelector: "#password" }
    };
    const def = parseAiFlowDefinition(withAuth);
    const browse = def.steps[1];
    expect(browse.type === "browse_extract" && browse.auth?.integrationLabel).toBe(
      "Referral Exchange"
    );
  });

  it("accepts an extract_text step whose fields feed a later step (no URL needed)", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [{ type: "contains", value: "rltr.pro" }] },
      steps: [
        {
          id: "s1",
          type: "extract_text",
          fields: [
            { name: "buyer_phone", description: "the buyer phone" },
            { name: "buyer_name", description: "the buyer full name" }
          ]
        },
        { id: "s2", type: "send_sms", to: "{{vars.buyer_phone}}", body: "Hi {{vars.buyer_name}}" }
      ]
    });
    expect(def.steps[0].type).toBe("extract_text");
  });

  it("flags a {{vars.x}} that only a LATER extract_text would produce", () => {
    const bad = {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        { id: "s1", type: "send_sms", to: "{{vars.buyer_phone}}", body: "hi" },
        { id: "s2", type: "extract_text", fields: [{ name: "buyer_phone" }] }
      ]
    };
    expect(() => parseAiFlowDefinition(bad)).toThrow(AiFlowValidationError);
  });

  it("rejects an auth block missing integrationLabel", () => {
    const bad = JSON.parse(JSON.stringify(validInput));
    bad.steps[1].auth = { login: { usernameSelector: "#email" } };
    expect(() => parseAiFlowDefinition(bad)).toThrow(AiFlowValidationError);
  });

  it("throws with a (root) issue for a non-object", () => {
    try {
      parseAiFlowDefinition("not an object");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AiFlowValidationError);
      const issues = (err as AiFlowValidationError).issues;
      expect(issues.some((i) => i.startsWith("(root):"))).toBe(true);
    }
  });

  it("throws with a field path for a shape error", () => {
    const bad = { ...validInput, steps: [{ id: "s1", type: "send_sms", to: "", body: "x" }] };
    try {
      parseAiFlowDefinition(bad);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AiFlowValidationError);
      expect((err as AiFlowValidationError).issues.length).toBeGreaterThan(0);
    }
  });

  it("throws on a semantic failure (unresolved var)", () => {
    const bad = {
      ...validInput,
      steps: [{ id: "s1", type: "send_sms", to: "{{vars.ghost}}", body: "x" }]
    };
    expect(() => parseAiFlowDefinition(bad)).toThrow(AiFlowValidationError);
  });
});

describe("validateDefinitionSemantics", () => {
  it("returns no issues for a valid definition", () => {
    expect(validateDefinitionSemantics(baseDef())).toEqual([]);
  });

  it("flags duplicate step ids", () => {
    const def = baseDef();
    def.steps[1].id = "s1";
    expect(validateDefinitionSemantics(def).some((i) => i.includes("Duplicate step id"))).toBe(true);
  });

  it("flags unknown trigger fields", () => {
    const def = baseDef();
    const send = def.steps[2];
    if (send.type === "send_sms") send.body = "{{trigger.nope}}";
    expect(
      validateDefinitionSemantics(def).some((i) => i.includes("unknown trigger field"))
    ).toBe(true);
  });

  it("flags a var used before it is produced", () => {
    const def: AiFlowDefinition = {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [{ id: "a", type: "notify_owner", message: "{{vars.early}}" }]
    };
    expect(validateDefinitionSemantics(def).some((i) => i.includes("before any step produces"))).toBe(
      true
    );
  });

  it("flags an unknown template scope", () => {
    const def: AiFlowDefinition = {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [{ id: "a", type: "notify_owner", message: "{{weird}}" }]
    };
    expect(validateDefinitionSemantics(def).some((i) => i.includes("unknown template scope"))).toBe(
      true
    );
  });

  it("flags a browse_extract urlVar that no earlier step produces", () => {
    const def: AiFlowDefinition = {
      version: 1,
      trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
      steps: [
        {
          id: "b",
          type: "browse_extract",
          urlVar: "missing_url",
          fields: [{ name: "x" }]
        }
      ]
    };
    expect(
      validateDefinitionSemantics(def).some((i) => i.includes('browses urlVar "missing_url"'))
    ).toBe(true);
  });

  it("accepts an http_call without saveAs and with no body template", () => {
    const def: AiFlowDefinition = {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        { id: "h", type: "http_call", label: "ping", path: "/p" },
        { id: "h2", type: "http_call", label: "ping2" }
      ]
    };
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });
});

describe("step `when` guard", () => {
  const branchedInput = {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
    steps: [
      { id: "u", type: "extract_url", saveAs: "lead_url" },
      {
        id: "b",
        type: "browse_extract",
        urlVar: "lead_url",
        fields: [{ name: "lead_type" }, { name: "lead_phone" }]
      },
      {
        id: "buyer",
        type: "send_sms",
        to: "{{vars.lead_phone}}",
        body: "buyer copy",
        when: { var: "lead_type", contains: "buyer" }
      }
    ]
  };

  it("parses and preserves a `when` guard (zod does not strip it)", () => {
    const def = parseAiFlowDefinition(JSON.parse(JSON.stringify(branchedInput)));
    const step = def.steps[2];
    expect(step.when).toEqual({ var: "lead_type", contains: "buyer" });
  });

  it("rejects a `when` with both equals and contains set", () => {
    const bad = JSON.parse(JSON.stringify(branchedInput));
    bad.steps[2].when = { var: "lead_type", equals: "buyer", contains: "buyer" };
    expect(() => parseAiFlowDefinition(bad)).toThrow(AiFlowValidationError);
  });

  it("rejects a `when` with neither equals nor contains set", () => {
    const bad = JSON.parse(JSON.stringify(branchedInput));
    bad.steps[2].when = { var: "lead_type" };
    expect(() => parseAiFlowDefinition(bad)).toThrow(AiFlowValidationError);
  });

  it("flags a `when.var` that no earlier step produces", () => {
    const def: AiFlowDefinition = {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        {
          id: "n",
          type: "notify_owner",
          message: "hi",
          when: { var: "lead_type", contains: "buyer" }
        }
      ]
    };
    expect(
      validateDefinitionSemantics(def).some((i) => i.includes('"when" condition on {{vars.lead_type}}'))
    ).toBe(true);
  });

  it("accepts a `when.var` produced by an earlier step", () => {
    const def = parseAiFlowDefinition(JSON.parse(JSON.stringify(branchedInput)));
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });
});

describe("browse_extract screenshot + send_email step", () => {
  const emailInput = {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
    steps: [
      { id: "u", type: "extract_url", saveAs: "lead_url" },
      {
        id: "b",
        type: "browse_extract",
        urlVar: "lead_url",
        fields: [{ name: "lead_name" }, { name: "lead_type" }],
        screenshot: true
      },
      {
        id: "email_buyer",
        type: "send_email",
        to: "amy@amylaidlaw.com",
        subject: "{{vars.lead_name}} BS RX",
        body: "New buyer lead {{vars.lead_name}}, screenshot attached.",
        attachScreenshot: true,
        when: { var: "lead_type", equals: "buyer" }
      }
    ]
  };

  it("parses and preserves screenshot + send_email (incl. attachScreenshot and when)", () => {
    const def = parseAiFlowDefinition(JSON.parse(JSON.stringify(emailInput)));
    const browse = def.steps[1];
    expect(browse.type === "browse_extract" && browse.screenshot).toBe(true);
    const email = def.steps[2];
    expect(email.type).toBe("send_email");
    if (email.type === "send_email") {
      expect(email.attachScreenshot).toBe(true);
      expect(email.when).toEqual({ var: "lead_type", equals: "buyer" });
    }
  });

  it("flags a send_email attachScreenshot when no earlier browse step captures one", () => {
    const bad = JSON.parse(JSON.stringify(emailInput));
    delete bad.steps[1].screenshot;
    const def = aiFlowDefinitionSchema.parse(bad);
    expect(
      validateDefinitionSemantics(def).some((i) =>
        i.includes("attaches a screenshot but no earlier browse step")
      )
    ).toBe(true);
  });

  it("a browse_action screenshot also satisfies a later attachScreenshot", () => {
    const viaAction = JSON.parse(JSON.stringify(emailInput));
    delete viaAction.steps[1].screenshot;
    viaAction.steps.splice(2, 0, {
      id: "act",
      type: "browse_action",
      urlVar: "lead_url",
      actions: [{ kind: "click_text", target: "Leave an update" }],
      screenshot: true
    });
    expect(validateDefinitionSemantics(parseAiFlowDefinition(viaAction))).toEqual([]);
    // ...but a browse_action WITHOUT a screenshot does not.
    const noShot = JSON.parse(JSON.stringify(viaAction));
    delete noShot.steps[2].screenshot;
    const def = aiFlowDefinitionSchema.parse(noShot);
    expect(
      validateDefinitionSemantics(def).some((i) =>
        i.includes("attaches a screenshot but no earlier browse step")
      )
    ).toBe(true);
  });

  it("accepts and flags a route_to_team attachScreenshot the same way", () => {
    const routed = JSON.parse(JSON.stringify(emailInput));
    routed.steps.push({
      id: "route",
      type: "route_to_team",
      offerTemplate: "New lead {{vars.lead_name}}, reply 1/2",
      ownerFallbackTemplate: "No one claimed {{vars.lead_name}}",
      attachScreenshot: true
    });
    // With the screenshot captured earlier: valid.
    expect(validateDefinitionSemantics(parseAiFlowDefinition(routed))).toEqual([]);
    // Without it: flagged.
    const bad = JSON.parse(JSON.stringify(routed));
    delete bad.steps[1].screenshot;
    delete bad.steps[2].attachScreenshot;
    const def = aiFlowDefinitionSchema.parse(bad);
    expect(
      validateDefinitionSemantics(def).some(
        (i) => i.includes('"route"') && i.includes("attaches a screenshot")
      )
    ).toBe(true);
  });

  it("validates {{vars.x}} ordering inside send_email to/subject/body", () => {
    const bad = JSON.parse(JSON.stringify(emailInput));
    bad.steps[2].subject = "{{vars.ghost}} BS RX";
    const def = aiFlowDefinitionSchema.parse(bad);
    expect(validateDefinitionSemantics(def).some((i) => i.includes("{{vars.ghost}}"))).toBe(true);
  });

  it("rejects a send_email missing its subject", () => {
    const bad = JSON.parse(JSON.stringify(emailInput));
    delete bad.steps[2].subject;
    expect(() => parseAiFlowDefinition(bad)).toThrow(AiFlowValidationError);
  });

  it("parses cc/bcc arrays and template-validates their {{vars.x}} refs", () => {
    const withCc = JSON.parse(JSON.stringify(emailInput));
    withCc.steps[2].cc = ["manager@x.com", "{{vars.lead_name}}@x.com"];
    withCc.steps[2].bcc = ["archive@x.com"];
    const def = parseAiFlowDefinition(withCc);
    const email = def.steps[2];
    expect(email.type === "send_email" && email.cc).toEqual([
      "manager@x.com",
      "{{vars.lead_name}}@x.com"
    ]);
    expect(email.type === "send_email" && email.bcc).toEqual(["archive@x.com"]);

    // A cc that references a not-yet-produced var is flagged like to/subject/body.
    const bad = JSON.parse(JSON.stringify(emailInput));
    bad.steps[2].cc = ["{{vars.ghost}}@x.com"];
    const badDef = aiFlowDefinitionSchema.parse(bad);
    expect(validateDefinitionSemantics(badDef).some((i) => i.includes("{{vars.ghost}}"))).toBe(true);
  });

  it("rejects a send_email cc list over the 10-recipient cap", () => {
    const bad = JSON.parse(JSON.stringify(emailInput));
    bad.steps[2].cc = Array.from({ length: 11 }, (_, i) => `u${i}@x.com`);
    expect(() => parseAiFlowDefinition(bad)).toThrow(AiFlowValidationError);
  });
});

describe("route_to_team step", () => {
  const routedInput = {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
    steps: [
      { id: "u", type: "extract_url", saveAs: "lead_url" },
      {
        id: "b",
        type: "browse_extract",
        urlVar: "lead_url",
        fields: [{ name: "lead_name" }, { name: "lead_phone" }]
      },
      {
        id: "r",
        type: "route_to_team",
        offerTemplate: "Offer {{vars.lead_name}} to {{agent.name}} ({{agent.phone}})",
        responseMinutes: 10,
        ownerFallbackTemplate: "No one took {{vars.lead_name}}",
        claimedNotifyTemplate: "{{agent.name}} claimed {{vars.lead_name}}"
      }
    ]
  };

  it("parses and preserves the route_to_team templates", () => {
    const def = parseAiFlowDefinition(JSON.parse(JSON.stringify(routedInput)));
    const step = def.steps[2];
    expect(step.type).toBe("route_to_team");
    expect(step.type === "route_to_team" && step.responseMinutes).toBe(10);
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("allows {{agent.name}}/{{agent.phone}} only inside route_to_team", () => {
    const bad = JSON.parse(JSON.stringify(routedInput));
    // notify_owner cannot reference an agent — no agent in scope there.
    bad.steps.push({ id: "n", type: "notify_owner", message: "by {{agent.name}}" });
    const def = aiFlowDefinitionSchema.parse(bad);
    expect(
      validateDefinitionSemantics(def).some((i) => i.includes("only a route_to_team step has an agent"))
    ).toBe(true);
  });

  it("flags an unknown agent field even inside route_to_team", () => {
    const bad = JSON.parse(JSON.stringify(routedInput));
    bad.steps[2].offerTemplate = "Hello {{agent.email}}";
    const def = aiFlowDefinitionSchema.parse(bad);
    expect(
      validateDefinitionSemantics(def).some((i) => i.includes('unknown agent field "email"'))
    ).toBe(true);
  });

  it("still validates {{vars.x}} ordering inside an offer template", () => {
    const bad = JSON.parse(JSON.stringify(routedInput));
    bad.steps[2].offerTemplate = "Offer {{vars.ghost}} to {{agent.name}}";
    const def = aiFlowDefinitionSchema.parse(bad);
    expect(
      validateDefinitionSemantics(def).some((i) => i.includes("{{vars.ghost}}"))
    ).toBe(true);
  });

  it("rejects a route_to_team missing required templates", () => {
    const bad = JSON.parse(JSON.stringify(routedInput));
    delete bad.steps[2].ownerFallbackTemplate;
    expect(() => parseAiFlowDefinition(bad)).toThrow(AiFlowValidationError);
  });

  it("accepts a route_to_team with no claimedNotifyTemplate (optional)", () => {
    const noClaim = JSON.parse(JSON.stringify(routedInput));
    delete noClaim.steps[2].claimedNotifyTemplate;
    const def = parseAiFlowDefinition(noClaim);
    const step = def.steps[2];
    expect(step.type === "route_to_team" && step.claimedNotifyTemplate).toBeUndefined();
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });
});

describe("route_to_team offerWindow + agentName + {{offer.deadline}}", () => {
  const routedInput = {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
    steps: [
      { id: "u", type: "extract_url", saveAs: "lead_url" },
      {
        id: "b",
        type: "browse_extract",
        urlVar: "lead_url",
        fields: [{ name: "lead_name" }]
      },
      {
        id: "r",
        type: "route_to_team",
        offerTemplate: "Offer {{vars.lead_name}} to {{agent.name}} by {{offer.deadline}}",
        ownerFallbackTemplate: "No one took {{vars.lead_name}}",
        agentName: "Dave",
        offerWindow: {
          timezone: "America/Phoenix",
          quietStart: "21:00",
          quietEnd: "08:30",
          graceMinutes: 10
        }
      }
    ]
  };

  it("parses agentName + offerWindow and allows {{offer.deadline}} in the offer", () => {
    const def = parseAiFlowDefinition(JSON.parse(JSON.stringify(routedInput)));
    const step = def.steps[2];
    expect(step.type === "route_to_team" && step.agentName).toBe("Dave");
    expect(step.type === "route_to_team" && step.offerWindow?.quietEnd).toBe("08:30");
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects malformed quiet-hour times", () => {
    const bad = JSON.parse(JSON.stringify(routedInput));
    bad.steps[2].offerWindow.quietStart = "9pm";
    expect(() => parseAiFlowDefinition(bad)).toThrow(AiFlowValidationError);
  });

  it("allows {{offer.x}} only inside route_to_team", () => {
    const bad = JSON.parse(JSON.stringify(routedInput));
    bad.steps.push({ id: "n", type: "notify_owner", message: "due {{offer.deadline}}" });
    const def = aiFlowDefinitionSchema.parse(bad);
    expect(
      validateDefinitionSemantics(def).some((i) =>
        i.includes("only a route_to_team step has an offer")
      )
    ).toBe(true);
  });

  it("flags an unknown offer field even inside route_to_team", () => {
    const bad = JSON.parse(JSON.stringify(routedInput));
    bad.steps[2].offerTemplate = "by {{offer.expiry}}";
    const def = aiFlowDefinitionSchema.parse(bad);
    expect(
      validateDefinitionSemantics(def).some((i) => i.includes('unknown offer field "expiry"'))
    ).toBe(true);
  });
});

describe("send_sms quietHours semantics", () => {
  function smsDef(quietHours: Record<string, unknown>) {
    return {
      version: 1,
      trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
      steps: [
        { id: "u", type: "extract_url", saveAs: "lead_url" },
        {
          id: "b",
          type: "browse_extract",
          urlVar: "lead_url",
          fields: [{ name: "lead_phone" }, { name: "lead_email" }]
        },
        { id: "s", type: "send_sms", to: "{{vars.lead_phone}}", body: "hi", quietHours }
      ]
    };
  }
  const goodQuiet = {
    timezone: "America/Phoenix",
    noSendAfter: "22:00",
    resumeAt: "08:30",
    emailFallbackVar: "lead_email",
    emailSubject: "Re: your inquiry",
    emailFromConnectionId: "22222222-2222-4222-8222-222222222222"
  };

  it("accepts a full quietHours config", () => {
    const def = parseAiFlowDefinition(smsDef(goodQuiet));
    const step = def.steps[2];
    expect(step.type === "send_sms" && step.quietHours?.emailFallbackVar).toBe("lead_email");
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects a malformed HH:MM boundary", () => {
    expect(() => parseAiFlowDefinition(smsDef({ ...goodQuiet, noSendAfter: "10pm" }))).toThrow(
      AiFlowValidationError
    );
  });

  it("flags an emailFallbackVar no earlier step produces", () => {
    const def = aiFlowDefinitionSchema.parse(smsDef({ ...goodQuiet, emailFallbackVar: "ghost" }));
    expect(
      validateDefinitionSemantics(def).some((i) =>
        i.includes("falls back to {{vars.ghost}} after hours")
      )
    ).toBe(true);
  });
});

describe("engine-provided vars + send_email fromConnectionId", () => {
  it("allows {{vars.actions_taken}} (and a when guard on it) with no producing step", () => {
    const def = aiFlowDefinitionSchema.parse({
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        {
          id: "n",
          type: "notify_owner",
          message: "did: {{vars.actions_taken}}",
          when: { var: "actions_taken", contains: "texted" }
        }
      ]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("accepts fromConnectionId and rejects combining it with attachScreenshot", () => {
    const mk = (extra: Record<string, unknown>) =>
      aiFlowDefinitionSchema.parse({
        version: 1,
        trigger: { channel: "sms", conditions: [] },
        steps: [
          {
            id: "e",
            type: "send_email",
            to: "a@b.com",
            subject: "s",
            body: "b",
            fromConnectionId: "22222222-2222-4222-8222-222222222222",
            ...extra
          }
        ]
      });
    expect(validateDefinitionSemantics(mk({}))).toEqual([]);
    expect(
      validateDefinitionSemantics(mk({ attachScreenshot: true })).some((i) =>
        i.includes("attachments are only supported when sending from your AI coworker's email")
      )
    ).toBe(true);
  });
});

describe("browse_action step", () => {
  const actionInput = {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
    steps: [
      { id: "u", type: "extract_url", saveAs: "lead_url" },
      {
        id: "act",
        type: "browse_action",
        urlVar: "lead_url",
        auth: { integrationLabel: "Referral Exchange" },
        actions: [
          { kind: "click_text", target: "Leave an update" },
          { kind: "fill_placeholder", target: "Add an update", valueTemplate: "{{vars.actions_taken}}" }
        ],
        screenshot: true
      }
    ]
  };

  it("parses a valid browse_action and validates its templates", () => {
    const def = parseAiFlowDefinition(JSON.parse(JSON.stringify(actionInput)));
    const step = def.steps[1];
    expect(step.type === "browse_action" && step.actions).toHaveLength(2);
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("flags a urlVar no earlier step produces", () => {
    const bad = JSON.parse(JSON.stringify(actionInput));
    bad.steps[1].urlVar = "ghost_url";
    const def = aiFlowDefinitionSchema.parse(bad);
    expect(
      validateDefinitionSemantics(def).some((i) => i.includes('urlVar "ghost_url"'))
    ).toBe(true);
  });

  it("validates {{vars.x}} ordering inside fill values", () => {
    const bad = JSON.parse(JSON.stringify(actionInput));
    bad.steps[1].actions[1].valueTemplate = "{{vars.ghost}}";
    const def = aiFlowDefinitionSchema.parse(bad);
    expect(validateDefinitionSemantics(def).some((i) => i.includes("{{vars.ghost}}"))).toBe(true);
  });

  it("rejects an empty actions array and unknown kinds", () => {
    const empty = JSON.parse(JSON.stringify(actionInput));
    empty.steps[1].actions = [];
    expect(() => parseAiFlowDefinition(empty)).toThrow(AiFlowValidationError);
    const badKind = JSON.parse(JSON.stringify(actionInput));
    badKind.steps[1].actions[0].kind = "hover";
    expect(() => parseAiFlowDefinition(badKind)).toThrow(AiFlowValidationError);
  });
});

describe("summarizeDefinition", () => {
  it("summarizes a conditionless trigger", () => {
    const def: AiFlowDefinition = {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [{ id: "n", type: "notify_owner", message: "hi" }]
    };
    expect(summarizeDefinition(def)).toBe("When any inbound SMS: notify_owner");
  });
  it("summarizes a conditioned trigger with step chain", () => {
    expect(summarizeDefinition(baseDef())).toContain("SMS matching 2 condition(s)");
  });
  it("summarizes the non-SMS channels", () => {
    const steps: AiFlowDefinition["steps"] = [{ id: "n", type: "notify_owner", message: "hi" }];
    expect(
      summarizeDefinition({ version: 1, trigger: { channel: "manual" }, steps })
    ).toBe("On demand: notify_owner");
    expect(
      summarizeDefinition({
        version: 1,
        trigger: { channel: "schedule", time: "08:30", timezone: "America/Phoenix" },
        steps
      })
    ).toBe("Daily at 08:30 (America/Phoenix): notify_owner");
    expect(
      summarizeDefinition({
        version: 1,
        trigger: { channel: "schedule", everyMinutes: 60 },
        steps
      })
    ).toBe("Every 60 min: notify_owner");
    expect(
      summarizeDefinition({
        version: 1,
        trigger: {
          channel: "email",
          connectionId: "8e7f95b0-0000-4000-8000-000000000001",
          conditions: []
        },
        steps
      })
    ).toBe("When any inbound email: notify_owner");
    expect(
      summarizeDefinition({
        version: 1,
        trigger: {
          channel: "email",
          connectionId: "8e7f95b0-0000-4000-8000-000000000001",
          conditions: [{ type: "has_url" }]
        },
        steps
      })
    ).toBe("When email matching 1 condition(s): notify_owner");
    expect(
      summarizeDefinition({ version: 1, trigger: { channel: "tenant_email", conditions: [] }, steps })
    ).toBe("When the AI mailbox receives any email: notify_owner");
    expect(
      summarizeDefinition({
        version: 1,
        trigger: { channel: "tenant_email", conditions: [{ type: "has_url" }] },
        steps
      })
    ).toBe("When AI mailbox email matches 1 condition(s): notify_owner");
  });
});

describe("trigger channels", () => {
  const steps = [{ id: "n", type: "notify_owner", message: "hi" }];
  const CONN = "8e7f95b0-0000-4000-8000-000000000001";

  it("accepts a manual trigger", () => {
    const def = parseAiFlowDefinition({ version: 1, trigger: { channel: "manual" }, steps });
    expect(def.trigger.channel).toBe("manual");
  });

  it("accepts a daily schedule trigger (with optional daysOfWeek)", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: {
        channel: "schedule",
        time: "08:30",
        timezone: "America/Phoenix",
        daysOfWeek: [1, 2, 3, 4, 5]
      },
      steps
    });
    expect(def.trigger.channel === "schedule" && def.trigger.time).toBe("08:30");
  });

  it("accepts an interval schedule trigger", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "schedule", everyMinutes: 60 },
      steps
    });
    expect(def.trigger.channel === "schedule" && def.trigger.everyMinutes).toBe(60);
  });

  it("rejects a schedule mixing daily and interval mode", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: {
          channel: "schedule",
          time: "08:30",
          timezone: "America/Phoenix",
          everyMinutes: 60
        },
        steps
      })
    ).toThrow(AiFlowValidationError);
  });

  it("rejects a half-configured daily schedule", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "schedule", time: "08:30" },
        steps
      })
    ).toThrow(AiFlowValidationError);
    expect(() =>
      parseAiFlowDefinition({ version: 1, trigger: { channel: "schedule" }, steps })
    ).toThrow(AiFlowValidationError);
  });

  it("rejects an everyMinutes below the floor", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "schedule", everyMinutes: 5 },
        steps
      })
    ).toThrow(AiFlowValidationError);
  });

  it("accepts an email trigger and rejects one without a connection", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "email", connectionId: CONN, conditions: [{ type: "has_url" }] },
      steps
    });
    expect(def.trigger.channel === "email" && def.trigger.connectionId).toBe(CONN);
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "email", conditions: [] },
        steps
      })
    ).toThrow(AiFlowValidationError);
  });

  it("accepts a tenant_email trigger (no connectionId on the type)", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "tenant_email", conditions: [{ type: "contains", value: "quote" }] },
      steps
    });
    expect(def.trigger.channel).toBe("tenant_email");
    // tenant_email has no connectionId field; an extra one is stripped, not stored.
    expect("connectionId" in def.trigger).toBe(false);
  });

  it("steps in non-SMS flows may still reference {{trigger.x}} scope keys", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "email", connectionId: CONN, conditions: [] },
      steps: [
        { id: "u", type: "extract_url", saveAs: "lead_url" },
        { id: "n", type: "notify_owner", message: "from {{trigger.from}}: {{trigger.windowText}}" }
      ]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });
});
