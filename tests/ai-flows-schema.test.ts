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

  it("accepts a links-only browse_extract whose captured link feeds a later step", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
      steps: [
        { id: "s1", type: "extract_url", saveAs: "lead_url" },
        {
          id: "s2",
          type: "browse_extract",
          urlVar: "lead_url",
          extractLinks: [{ name: "claim_link", matchText: "Call me to claim referral" }]
        },
        { id: "s3", type: "notify_owner", message: "claim at {{vars.claim_link}}" }
      ]
    });
    // The link var is in scope for the later step → no semantic issues.
    expect(validateDefinitionSemantics(def)).toEqual([]);
    const browse = def.steps[1];
    expect(browse.type === "browse_extract" && browse.extractLinks?.[0]?.name).toBe("claim_link");
  });

  it("accepts a browse_extract carrying both fields and extractLinks", () => {
    const withBoth = JSON.parse(JSON.stringify(validInput));
    withBoth.steps[1].extractLinks = [{ name: "claim_link", matchText: "claim" }];
    const def = parseAiFlowDefinition(withBoth);
    const browse = def.steps[1];
    expect(
      browse.type === "browse_extract" &&
        (browse.fields?.length ?? 0) > 0 &&
        browse.extractLinks?.length
    ).toBe(1);
  });

  it("rejects a browse_extract with neither fields nor extractLinks", () => {
    const bad = JSON.parse(JSON.stringify(validInput));
    delete bad.steps[1].fields;
    expect(() => parseAiFlowDefinition(bad)).toThrow(AiFlowValidationError);
  });

  it("accepts an optional browse_extract skipWhenText terminal-state marker", () => {
    const withSkip = JSON.parse(JSON.stringify(validInput));
    withSkip.steps[1].skipWhenText = "already been claimed";
    const def = parseAiFlowDefinition(withSkip);
    const browse = def.steps[1];
    expect(browse.type === "browse_extract" && browse.skipWhenText).toBe("already been claimed");
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects an empty browse_extract skipWhenText", () => {
    const bad = JSON.parse(JSON.stringify(validInput));
    bad.steps[1].skipWhenText = "";
    expect(() => parseAiFlowDefinition(bad)).toThrow(AiFlowValidationError);
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

describe("upsert_customer step", () => {
  const withUpsert = (phoneVar: string, nameVar?: string, emailVar?: string) => ({
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
    steps: [
      { id: "u", type: "extract_url", saveAs: "lead_url" },
      {
        id: "b",
        type: "browse_extract",
        urlVar: "lead_url",
        fields: [{ name: "lead_phone" }, { name: "lead_name" }, { name: "lead_email" }]
      },
      { id: "save", type: "upsert_customer", phoneVar, nameVar, emailVar }
    ]
  });

  it("parses and round-trips an upsert_customer step", () => {
    const def = parseAiFlowDefinition(
      JSON.parse(JSON.stringify(withUpsert("lead_phone", "lead_name", "lead_email")))
    );
    expect(def.steps[2]).toEqual({
      id: "save",
      type: "upsert_customer",
      phoneVar: "lead_phone",
      nameVar: "lead_name",
      emailVar: "lead_email"
    });
  });

  it("accepts an upsert_customer whose vars an earlier step produced", () => {
    const def = parseAiFlowDefinition(
      JSON.parse(JSON.stringify(withUpsert("lead_phone", "lead_name", "lead_email")))
    );
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("accepts an upsert_customer with only the required phoneVar", () => {
    const def = parseAiFlowDefinition(JSON.parse(JSON.stringify(withUpsert("lead_phone"))));
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("flags phoneVar/nameVar/emailVar that no earlier step produces", () => {
    const def = aiFlowDefinitionSchema.parse(
      JSON.parse(JSON.stringify(withUpsert("ghost_phone", "ghost_name", "ghost_email")))
    );
    const issues = validateDefinitionSemantics(def);
    expect(issues.some((i) => i.includes("phoneVar {{vars.ghost_phone}}"))).toBe(true);
    expect(issues.some((i) => i.includes("nameVar {{vars.ghost_name}}"))).toBe(true);
    expect(issues.some((i) => i.includes("emailVar {{vars.ghost_email}}"))).toBe(true);
  });

  it("summarizes a flow ending in upsert_customer", () => {
    const def = parseAiFlowDefinition(JSON.parse(JSON.stringify(withUpsert("lead_phone"))));
    expect(summarizeDefinition(def)).toContain("upsert_customer");
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

  it("parses and preserves a `notEquals` guard", () => {
    const input = JSON.parse(JSON.stringify(branchedInput));
    input.steps[2].when = { var: "lead_type", notEquals: "none" };
    const def = parseAiFlowDefinition(input);
    expect(def.steps[2].when).toEqual({ var: "lead_type", notEquals: "none" });
  });

  it("rejects a `when` with both equals and notEquals set", () => {
    const bad = JSON.parse(JSON.stringify(branchedInput));
    bad.steps[2].when = { var: "lead_type", equals: "buyer", notEquals: "none" };
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
    // notify_owner cannot reference an agent; no agent in scope there.
    bad.steps.push({ id: "n", type: "notify_owner", message: "by {{agent.name}}" });
    const def = aiFlowDefinitionSchema.parse(bad);
    expect(
      validateDefinitionSemantics(def).some((i) =>
        i.includes("only a route_to_team or send_sms toAgentName step has an agent")
      )
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

  it("preserves an explicit firstToClaim opt-out (undefined means ON)", () => {
    const optOut = JSON.parse(JSON.stringify(routedInput));
    optOut.steps[2].firstToClaim = false;
    const def = parseAiFlowDefinition(optOut);
    const step = def.steps[2];
    expect(step.type === "route_to_team" && step.firstToClaim).toBe(false);
    expect(validateDefinitionSemantics(def)).toEqual([]);

    const defaulted = parseAiFlowDefinition(routedInput);
    const dStep = defaulted.steps[2];
    expect(dStep.type === "route_to_team" && dStep.firstToClaim).toBeUndefined();
  });

  it("accepts a complete keep-for-owner rule and preserves both fields", () => {
    const withRule = JSON.parse(JSON.stringify(routedInput));
    withRule.steps[1].fields.push({ name: "price_band" });
    withRule.steps[2].ownerDirectWhen = { var: "price_band", equals: "over_1m" };
    withRule.steps[2].ownerDirectTemplate = "Kept for you: {{vars.lead_name}}";
    const def = parseAiFlowDefinition(withRule);
    const step = def.steps[2];
    expect(step.type === "route_to_team" && step.ownerDirectWhen).toEqual({
      var: "price_band",
      equals: "over_1m"
    });
    expect(step.type === "route_to_team" && step.ownerDirectTemplate).toBe(
      "Kept for you: {{vars.lead_name}}"
    );
  });

  it("rejects half a keep-for-owner rule (condition and template are a pair)", () => {
    const onlyWhen = JSON.parse(JSON.stringify(routedInput));
    onlyWhen.steps[1].fields.push({ name: "price_band" });
    onlyWhen.steps[2].ownerDirectWhen = { var: "price_band", equals: "over_1m" };
    expect(
      validateDefinitionSemantics(aiFlowDefinitionSchema.parse(onlyWhen)).some((i) =>
        i.includes("ownerDirectWhen and ownerDirectTemplate together")
      )
    ).toBe(true);

    const onlyTemplate = JSON.parse(JSON.stringify(routedInput));
    onlyTemplate.steps[2].ownerDirectTemplate = "Kept for you";
    expect(
      validateDefinitionSemantics(aiFlowDefinitionSchema.parse(onlyTemplate)).some((i) =>
        i.includes("ownerDirectWhen and ownerDirectTemplate together")
      )
    ).toBe(true);
  });

  it("rejects an ownerDirectWhen on a var no earlier step produces", () => {
    const ghost = JSON.parse(JSON.stringify(routedInput));
    ghost.steps[2].ownerDirectWhen = { var: "price_band", equals: "over_1m" };
    ghost.steps[2].ownerDirectTemplate = "Kept for you";
    expect(
      validateDefinitionSemantics(aiFlowDefinitionSchema.parse(ghost)).some((i) =>
        i.includes("ownerDirectWhen condition on {{vars.price_band}}")
      )
    ).toBe(true);
  });

  it("strips the removed claimTimeframeOption/lateClaimOption fields from old definitions", () => {
    // Reply digits are universal now ("1" claim, "2" pass); a definition
    // authored before the migration still parses, but the legacy per-flow
    // option digits are dropped rather than honored.
    const withOpts = JSON.parse(JSON.stringify(routedInput));
    withOpts.steps[2].claimTimeframeOption = 3;
    withOpts.steps[2].lateClaimOption = 4;
    const def = parseAiFlowDefinition(withOpts);
    const step = def.steps[2] as Record<string, unknown>;
    expect("claimTimeframeOption" in step).toBe(false);
    expect("lateClaimOption" in step).toBe(false);
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

  it("accepts an optional skipWhenText terminal-state marker", () => {
    const withSkip = JSON.parse(JSON.stringify(actionInput));
    withSkip.steps[1].skipWhenText = "already been claimed";
    const def = parseAiFlowDefinition(withSkip);
    const step = def.steps[1];
    expect(step.type === "browse_action" && step.skipWhenText).toBe("already been claimed");
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects an empty skipWhenText", () => {
    const bad = JSON.parse(JSON.stringify(actionInput));
    bad.steps[1].skipWhenText = "";
    expect(() => aiFlowDefinitionSchema.parse(bad)).toThrow();
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

describe("Clever engine: browse_action same-pass extraction + click_text_while_present", () => {
  it("accepts a browse_action with click_text_while_present and registers extracted fields", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [{ type: "contains", value: "Clever referral" }] },
      steps: [
        { id: "u", type: "extract_url", saveAs: "lead_url" },
        {
          id: "acc",
          type: "browse_action",
          urlVar: "lead_url",
          auth: { integrationLabel: "Clever" },
          actions: [{ kind: "click_text_while_present", target: "Next" }],
          fields: [{ name: "lead_name" }, { name: "lead_phone" }],
          screenshot: true
        },
        // A LATER step may reference the vars the browse_action extracted.
        { id: "e", type: "send_email", to: "amy@amylaidlaw.com", subject: "{{vars.lead_name}} QT, Clever", body: "{{vars.lead_phone}}", attachScreenshot: true }
      ]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("flags a {{vars.x}} referencing a browse_action field BEFORE it runs", () => {
    const def = baseDef();
    def.steps = [
      { id: "early", type: "notify_owner", message: "name is {{vars.lead_name}}" },
      {
        id: "acc",
        type: "browse_action",
        urlVar: "lead_url",
        actions: [{ kind: "click_text", target: "Accept" }],
        fields: [{ name: "lead_name" }]
      }
    ] as AiFlowDefinition["steps"];
    // urlVar lead_url is also unproduced here, so expect the var-scope issue among the list.
    const issues = validateDefinitionSemantics(def);
    expect(issues.some((i) => i.includes("{{vars.lead_name}} before any step produces it"))).toBe(
      true
    );
  });
});

describe("Clever engine: send_sms replyToGroup", () => {
  it("accepts a replyToGroup send_sms with no `to`", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [{ type: "contains", value: "introduce you to Amy" }] },
      steps: [
        { id: "t", type: "extract_text", fields: [{ name: "seller_first_name" }] },
        { id: "g", type: "send_sms", replyToGroup: true, body: "Hi {{vars.seller_first_name}}!" }
      ]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects a send_sms with no recipient at all", () => {
    const def = baseDef();
    def.steps = [{ id: "g", type: "send_sms", body: "hi" }] as AiFlowDefinition["steps"];
    expect(validateDefinitionSemantics(def)).toEqual([
      'Step "g" sends a text but has no recipient; set "to", "toAgentName", "toRef", or turn on replyToGroup.'
    ]);
  });

  it("rejects replyToGroup on a non-SMS-triggered flow", () => {
    const def: AiFlowDefinition = {
      version: 1,
      trigger: { channel: "manual" },
      steps: [{ id: "g", type: "send_sms", replyToGroup: true, body: "hi" }]
    };
    expect(validateDefinitionSemantics(def)).toContain(
      'Step "g" replies to a group thread, which only works on an SMS-triggered flow.'
    );
  });
});

describe("Clever engine: send_sms toAgentName", () => {
  it("accepts toAgentName as the sole recipient and {{agent.*}} in the body", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [{ type: "from_matches", value: "4702212279" }] },
      steps: [
        {
          id: "tell",
          type: "send_sms",
          toAgentName: "Dave",
          body: "{{agent.name}}, Homeward offers: {{trigger.windowText}}"
        }
      ]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects setting more than one recipient source", () => {
    const def = baseDef();
    def.steps = [
      { id: "g", type: "send_sms", to: "{{vars.x}}", toAgentName: "Dave", body: "hi" }
    ] as AiFlowDefinition["steps"];
    expect(validateDefinitionSemantics(def)).toContain(
      'Step "g" sets more than one recipient; use only one of "to", "toAgentName", "toRef", or replyToGroup.'
    );
  });

  it("rejects {{agent.*}} in a send_sms body without toAgentName", () => {
    const def = baseDef();
    def.steps = [
      { id: "g", type: "send_sms", to: "{{vars.x}}", body: "hi {{agent.name}}" }
    ] as AiFlowDefinition["steps"];
    expect(validateDefinitionSemantics(def)).toContain(
      'Step "g" uses {{agent.name}} but only a route_to_team or send_sms toAgentName step has an agent.'
    );
  });
});

describe("Dynamic contact refs: send_sms toRef", () => {
  const employeeRef = {
    source: "employee",
    id: "11111111-1111-4111-8111-111111111111",
    label: "Dave"
  };
  const contactRef = { source: "contact", id: "22222222-2222-4222-8222-222222222222" };

  it("accepts an employee toRef as the sole recipient", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "manual" },
      steps: [{ id: "g", type: "send_sms", toRef: employeeRef, body: "Hi {{agent.name}}" }]
    });
    const step = def.steps[0];
    expect(step.type === "send_sms" && step.toRef?.source).toBe("employee");
    expect(step.type === "send_sms" && step.toRef?.label).toBe("Dave");
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("accepts a contact toRef (no label) as the sole recipient", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "manual" },
      steps: [{ id: "g", type: "send_sms", toRef: contactRef, body: "Hi there" }]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects {{agent.*}} in a body sent to a contact toRef (no agent in scope)", () => {
    const def = aiFlowDefinitionSchema.parse({
      version: 1,
      trigger: { channel: "manual" },
      steps: [{ id: "g", type: "send_sms", toRef: contactRef, body: "Hi {{agent.name}}" }]
    });
    expect(validateDefinitionSemantics(def)).toContain(
      'Step "g" uses {{agent.name}} but only a route_to_team or send_sms toAgentName step has an agent.'
    );
  });

  it("rejects toRef combined with another recipient source", () => {
    const def = baseDef();
    def.steps = [
      { id: "g", type: "send_sms", to: "{{vars.x}}", toRef: contactRef, body: "hi" }
    ] as AiFlowDefinition["steps"];
    expect(validateDefinitionSemantics(def)).toContain(
      'Step "g" sets more than one recipient; use only one of "to", "toAgentName", "toRef", or replyToGroup.'
    );
  });

  it("rejects a toRef with a non-uuid id at parse time", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "manual" },
        steps: [
          {
            id: "g",
            type: "send_sms",
            toRef: { source: "contact", id: "not-a-uuid" },
            body: "hi"
          }
        ]
      })
    ).toThrow(AiFlowValidationError);
  });

  it("rejects a toRef with an unknown source at parse time", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "manual" },
        steps: [
          {
            id: "g",
            type: "send_sms",
            toRef: { source: "owner", id: "22222222-2222-4222-8222-222222222222" },
            body: "hi"
          }
        ]
      })
    ).toThrow(AiFlowValidationError);
  });
});

describe("Dynamic contact refs: route_to_team agentRef", () => {
  const employeeRef = {
    source: "employee",
    id: "33333333-3333-4333-8333-333333333333",
    label: "Dave"
  };

  function routedWith(extra: Record<string, unknown>) {
    return {
      version: 1,
      trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
      steps: [
        {
          id: "r",
          type: "route_to_team",
          offerTemplate: "Offer to {{agent.name}}",
          ownerFallbackTemplate: "No one took it",
          ...extra
        }
      ]
    };
  }

  it("accepts an employee agentRef as the sole pin", () => {
    const def = parseAiFlowDefinition(routedWith({ agentRef: employeeRef }));
    const step = def.steps[0];
    expect(step.type === "route_to_team" && step.agentRef?.id).toBe(employeeRef.id);
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects setting both agentName and agentRef", () => {
    const def = aiFlowDefinitionSchema.parse(
      routedWith({ agentName: "Dave", agentRef: employeeRef })
    );
    expect(validateDefinitionSemantics(def)).toContain(
      'Step "r" pins to both agentName and agentRef; use only one.'
    );
  });

  it("rejects a contact-sourced agentRef (not on the roster)", () => {
    const def = aiFlowDefinitionSchema.parse(
      routedWith({
        agentRef: { source: "contact", id: "44444444-4444-4444-8444-444444444444" }
      })
    );
    expect(validateDefinitionSemantics(def)).toContain(
      'Step "r" routes to a contact, but route_to_team can only pin a team member; use an employee reference.'
    );
  });
});

describe("Clever weekly update: browse_action forEachLink", () => {
  it("accepts forEachLink with an actions sequence", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [{ type: "from_matches", value: "3142707635" }] },
      steps: [
        { id: "u", type: "extract_url", saveAs: "portal_url" },
        {
          id: "loop",
          type: "browse_action",
          urlVar: "portal_url",
          auth: { integrationLabel: "Clever" },
          forEachLink: "a.needs-action-lead",
          actions: [
            { kind: "click_text", target: "Provide Update" },
            { kind: "click_text", target: "We Spoke" }
          ]
        }
      ]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects combining forEachLink with fields, screenshot, or rememberUrlKeyedByVar", () => {
    const def = baseDef();
    def.steps = [
      { id: "u", type: "extract_url", saveAs: "portal_url" },
      {
        id: "loop",
        type: "browse_action",
        urlVar: "portal_url",
        forEachLink: "a.lead",
        actions: [{ kind: "click_text", target: "Provide Update" }],
        fields: [{ name: "x" }],
        screenshot: true,
        rememberUrlKeyedByVar: "x"
      }
    ] as AiFlowDefinition["steps"];
    const issues = validateDefinitionSemantics(def);
    expect(issues).toContain(
      'Step "loop" can\'t combine forEachLink with fields; extraction has no single page in a loop.'
    );
    expect(issues).toContain('Step "loop" can\'t combine forEachLink with screenshot.');
    expect(issues).toContain('Step "loop" can\'t combine forEachLink with rememberUrlKeyedByVar.');
  });

  it("accepts forEachLinkMatchVar pointing at an earlier-produced var", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [{ type: "from_matches", value: "3142077635" }] },
      steps: [
        { id: "u", type: "extract_url", saveAs: "portal_url" },
        { id: "n", type: "extract_text", fields: [{ name: "lead_names" }] },
        {
          id: "loop",
          type: "browse_action",
          urlVar: "portal_url",
          auth: { integrationLabel: "Clever" },
          forEachLink: "a.needs-action-lead",
          forEachLinkMatchVar: "lead_names",
          actions: [{ kind: "click_text", target: "Provide Update" }]
        }
      ]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects forEachLinkMatchVar without forEachLink", () => {
    const def = baseDef();
    def.steps = [
      { id: "u", type: "extract_url", saveAs: "portal_url" },
      { id: "n", type: "extract_text", fields: [{ name: "lead_names" }] },
      {
        id: "loop",
        type: "browse_action",
        urlVar: "portal_url",
        forEachLinkMatchVar: "lead_names",
        actions: [{ kind: "click_text", target: "Provide Update" }]
      }
    ] as AiFlowDefinition["steps"];
    expect(validateDefinitionSemantics(def)).toContain(
      'Step "loop" sets forEachLinkMatchVar but has no forEachLink to filter.'
    );
  });

  it("rejects forEachLinkMatchVar referencing a var no earlier step produces", () => {
    const def = baseDef();
    def.steps = [
      { id: "u", type: "extract_url", saveAs: "portal_url" },
      {
        id: "loop",
        type: "browse_action",
        urlVar: "portal_url",
        forEachLink: "a.needs-action-lead",
        forEachLinkMatchVar: "lead_names",
        actions: [{ kind: "click_text", target: "Provide Update" }]
      }
    ] as AiFlowDefinition["steps"];
    expect(validateDefinitionSemantics(def)).toContain(
      'Step "loop" filters its forEachLink by {{vars.lead_names}} which no earlier step produces.'
    );
  });
});

describe("Clever auto-update: recall_url + rememberUrlKeyedByVar", () => {
  it("accepts a browse_action that remembers its URL and a later recall_url", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [{ type: "contains", value: "Clever referral" }] },
      steps: [
        { id: "u", type: "extract_url", saveAs: "lead_url" },
        {
          id: "acc",
          type: "browse_action",
          urlVar: "lead_url",
          actions: [{ kind: "click_text", target: "Accept" }],
          fields: [{ name: "lead_phone" }],
          rememberUrlKeyedByVar: "lead_phone"
        }
      ]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects rememberUrlKeyedByVar pointing at an unproduced var", () => {
    const def = baseDef();
    def.steps = [
      { id: "u", type: "extract_url", saveAs: "lead_url" },
      {
        id: "acc",
        type: "browse_action",
        urlVar: "lead_url",
        actions: [{ kind: "click_text", target: "Accept" }],
        rememberUrlKeyedByVar: "lead_phone"
      }
    ] as AiFlowDefinition["steps"];
    expect(validateDefinitionSemantics(def)).toContain(
      'Step "acc" remembers its URL keyed by {{vars.lead_phone}} which no earlier step or its own extraction produces.'
    );
  });

  it("recall_url registers saveAs for a later browse_action urlVar, guarded by when", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [{ type: "contains", value: "introduce you" }] },
      steps: [
        { id: "r", type: "recall_url", keyFromTrigger: "participants", saveAs: "connection_url" },
        {
          id: "upd",
          type: "browse_action",
          urlVar: "connection_url",
          actions: [{ kind: "select_option", target: "#status", valueTemplate: "We Spoke" }],
          when: { var: "connection_url", contains: "http" }
        }
      ]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects a recall_url with no key source", () => {
    const def: AiFlowDefinition = {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [{ id: "r", type: "recall_url", saveAs: "connection_url" }]
    };
    expect(validateDefinitionSemantics(def)).toContain(
      'Step "r" recalls a URL but has no key source; set keyFromTrigger or keyVars.'
    );
  });

  it("rejects recall by participants on a non-SMS flow", () => {
    const def: AiFlowDefinition = {
      version: 1,
      trigger: { channel: "manual" },
      steps: [{ id: "r", type: "recall_url", keyFromTrigger: "participants", saveAs: "u" }]
    };
    expect(validateDefinitionSemantics(def)).toContain(
      'Step "r" recalls by group participants, which only works on an SMS-triggered flow.'
    );
  });

  it("rejects recall_url keyVars naming an unproduced var", () => {
    const def: AiFlowDefinition = {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [{ id: "r", type: "recall_url", keyVars: ["lead_phone"], saveAs: "u" }]
    };
    expect(validateDefinitionSemantics(def)).toContain(
      'Step "r" recalls a URL keyed by {{vars.lead_phone}} which no earlier step produces.'
    );
  });

  it("accepts recall_url keyVars naming an earlier or engine-provided var", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        { id: "t", type: "extract_text", fields: [{ name: "seller_phone" }] },
        { id: "r", type: "recall_url", keyVars: ["seller_phone", "actions_taken"], saveAs: "u" }
      ]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });
});

describe("click_role / select_option require a value", () => {
  it("rejects click_role with no valueTemplate", () => {
    const parsed = aiFlowDefinitionSchema.safeParse({
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        { id: "u", type: "extract_url", saveAs: "lead_url" },
        {
          id: "a",
          type: "browse_action",
          urlVar: "lead_url",
          actions: [{ kind: "click_role", target: "option" }]
        }
      ]
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts click_role with a name and select_option with a value", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        { id: "u", type: "extract_url", saveAs: "lead_url" },
        {
          id: "a",
          type: "browse_action",
          urlVar: "lead_url",
          actions: [
            { kind: "click_role", target: "option", valueTemplate: "Choose {{now.tomorrow.weekday}}" },
            { kind: "select_option", target: "#status", valueTemplate: "We Spoke" }
          ]
        }
      ]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });
});

describe("{{now.*}} template scope", () => {
  it("accepts known now fields and rejects unknown ones", () => {
    const ok = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [{ id: "n", type: "notify_owner", message: "Follow up {{now.tomorrow.weekday}} at {{now.afternoonTime}}" }]
    });
    expect(validateDefinitionSemantics(ok)).toEqual([]);

    const bad = baseDef();
    bad.steps = [
      { id: "n", type: "notify_owner", message: "{{now.yesterday}}" }
    ] as AiFlowDefinition["steps"];
    expect(validateDefinitionSemantics(bad)).toContain(
      'Step "n" references unknown date field "now.yesterday".'
    );
  });
});

describe("voice trigger + voice steps", () => {
  it("accepts a handoff chain (ring_handoff x2 + trailing voice_ai_intake)", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "voice", fromE164: "+14159851909" },
      steps: [
        { id: "r1", type: "ring_handoff", toE164: "+16025245719", ringSeconds: 20 },
        { id: "r2", type: "ring_handoff", toE164: "+16026951142", ringSeconds: 20 },
        {
          id: "ai",
          type: "voice_ai_intake",
          notifyE164: "+16026951142",
          persona: "Amy's assistant",
          captureFields: ["name", "phone"]
        }
      ]
    });
    expect(def.trigger.channel).toBe("voice");
    expect(validateDefinitionSemantics(def)).toEqual([]);
    expect(summarizeDefinition(def)).toContain("+14159851909");
  });

  it("accepts a single voice_transfer flow", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "voice", fromE164: "+13056133412" },
      steps: [{ id: "t", type: "voice_transfer", toE164: "+16026951142", whisper: "Connecting you now." }]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects an E.164 that isn't well-formed", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "voice", fromE164: "4159851909" },
        steps: [{ id: "r", type: "ring_handoff", toE164: "+16025245719" }]
      })
    ).toThrow(AiFlowValidationError);
  });

  describe("dynamic contact refs (toRef/notifyRef)", () => {
    const empRef = { source: "employee", id: "11111111-1111-4111-8111-111111111111", label: "Dave" };
    const conRef = { source: "contact", id: "22222222-2222-4222-8222-222222222222" };

    it("accepts refs as the sole number source on every voice step", () => {
      const inbound = parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "voice", fromE164: "+14159851909" },
        steps: [
          { id: "r", type: "ring_handoff", toRef: empRef },
          { id: "ai", type: "voice_ai_intake", notifyRef: empRef }
        ]
      });
      expect(validateDefinitionSemantics(inbound)).toEqual([]);

      const transfer = parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "voice", fromE164: "+14159851909" },
        steps: [{ id: "t", type: "voice_transfer", toRef: conRef }]
      });
      expect(validateDefinitionSemantics(transfer)).toEqual([]);

      const outbound = parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "voice", direction: "outbound" },
        steps: [{ id: "c", type: "outbound_call", toRef: conRef, notifyRef: empRef }]
      });
      expect(validateDefinitionSemantics(outbound)).toEqual([]);
    });

    it("rejects a ring_handoff with neither toE164 nor toRef", () => {
      const def = aiFlowDefinitionSchema.parse({
        version: 1,
        trigger: { channel: "voice", fromE164: "+14159851909" },
        steps: [{ id: "r", type: "ring_handoff" }]
      });
      expect(validateDefinitionSemantics(def)).toContain(
        'Step "r" has no number to ring; set toE164 or pick a saved contact (toRef).'
      );
    });

    it("rejects a voice_transfer that sets both toE164 and toRef", () => {
      const def = aiFlowDefinitionSchema.parse({
        version: 1,
        trigger: { channel: "voice", fromE164: "+14159851909" },
        steps: [{ id: "t", type: "voice_transfer", toE164: "+16026951142", toRef: empRef }]
      });
      expect(validateDefinitionSemantics(def)).toContain(
        'Step "t" sets both toE164 and toRef; use only one.'
      );
    });

    it("rejects a voice_ai_intake with no notify source (and both sources)", () => {
      const neither = aiFlowDefinitionSchema.parse({
        version: 1,
        trigger: { channel: "voice", fromE164: "+14159851909" },
        steps: [
          { id: "r", type: "ring_handoff", toE164: "+16025245719" },
          { id: "ai", type: "voice_ai_intake" }
        ]
      });
      expect(validateDefinitionSemantics(neither)).toContain(
        'Step "ai" has nowhere to send the call summary; set notifyE164 or pick a saved contact (notifyRef).'
      );
      const both = aiFlowDefinitionSchema.parse({
        version: 1,
        trigger: { channel: "voice", fromE164: "+14159851909" },
        steps: [
          { id: "r", type: "ring_handoff", toE164: "+16025245719" },
          { id: "ai", type: "voice_ai_intake", notifyE164: "+16026951142", notifyRef: empRef }
        ]
      });
      expect(validateDefinitionSemantics(both)).toContain(
        'Step "ai" sets both notifyE164 and notifyRef; use only one.'
      );
    });

    it("accepts a voice trigger fromRef as the caller match, rejects both sources", () => {
      const withRef = parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "voice", fromRef: conRef },
        steps: [{ id: "r", type: "ring_handoff", toE164: "+16025245719" }]
      });
      expect(validateDefinitionSemantics(withRef)).toEqual([]);
      expect(summarizeDefinition(withRef)).toContain("a saved contact");

      const both = aiFlowDefinitionSchema.parse({
        version: 1,
        trigger: { channel: "voice", fromE164: "+14159851909", fromRef: conRef },
        steps: [{ id: "r", type: "ring_handoff", toE164: "+16025245719" }]
      });
      expect(validateDefinitionSemantics(both)).toContain(
        "The trigger sets both fromE164 and fromRef; use only one."
      );
    });

    it("accepts a from_matches condition with a saved-contact ref (sms trigger)", () => {
      const def = parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "sms", conditions: [{ type: "from_matches", ref: conRef }] },
        steps: [{ id: "n", type: "notify_owner", message: "hi" }]
      });
      expect(validateDefinitionSemantics(def)).toEqual([]);
    });

    it("rejects a from_matches condition with neither / both sender sources", () => {
      const neither = aiFlowDefinitionSchema.parse({
        version: 1,
        trigger: { channel: "sms", conditions: [{ type: "from_matches" }] },
        steps: [{ id: "n", type: "notify_owner", message: "hi" }]
      });
      expect(validateDefinitionSemantics(neither)).toContain(
        'A "from matches" condition needs a sender; enter text or pick a saved contact.'
      );
      const both = aiFlowDefinitionSchema.parse({
        version: 1,
        trigger: {
          channel: "sms",
          conditions: [{ type: "from_matches", value: "+1602", ref: conRef }]
        },
        steps: [{ id: "n", type: "notify_owner", message: "hi" }]
      });
      expect(validateDefinitionSemantics(both)).toContain(
        'A "from matches" condition sets both a text value and a saved contact; use only one.'
      );
    });

    it("rejects an outbound_call with both callee sources, allows neither (entry supplies it)", () => {
      const both = aiFlowDefinitionSchema.parse({
        version: 1,
        trigger: { channel: "voice", direction: "outbound" },
        steps: [
          {
            id: "c",
            type: "outbound_call",
            toE164: "+19178628675",
            toRef: conRef,
            notifyE164: "+16026951142"
          }
        ]
      });
      expect(validateDefinitionSemantics(both)).toContain(
        'Step "c" sets both toE164 and toRef; use only one.'
      );
      const neither = parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "voice", direction: "outbound" },
        steps: [{ id: "c", type: "outbound_call", notifyE164: "+16026951142" }]
      });
      expect(validateDefinitionSemantics(neither)).toEqual([]);
    });
  });

  it("rejects a non-voice step under a voice trigger", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "voice", fromE164: "+14159851909" },
        steps: [
          { id: "r", type: "ring_handoff", toE164: "+16025245719" },
          { id: "n", type: "notify_owner", message: "hi" }
        ]
      })
    ).toThrow(AiFlowValidationError);
  });

  it("rejects a voice step under a non-voice trigger", () => {
    const parsed = aiFlowDefinitionSchema.parse({
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [{ id: "r", type: "ring_handoff", toE164: "+16025245719" }]
    });
    expect(validateDefinitionSemantics(parsed)).toContain(
      'Step "r" is a voice step ("ring_handoff") but the trigger is "sms"; voice steps need a voice trigger.'
    );
  });

  it("rejects voice_ai_intake that isn't the last step", () => {
    const parsed = aiFlowDefinitionSchema.parse({
      version: 1,
      trigger: { channel: "voice", fromE164: "+14159851909" },
      steps: [
        { id: "r", type: "ring_handoff", toE164: "+16025245719" },
        { id: "ai", type: "voice_ai_intake", notifyE164: "+16026951142" },
        { id: "r2", type: "ring_handoff", toE164: "+16026951142" }
      ]
    });
    expect(validateDefinitionSemantics(parsed)).toContain(
      "voice_ai_intake must be the last step; it only takes over after every ring_handoff missed."
    );
  });

  it("rejects more than one voice_ai_intake", () => {
    const parsed = aiFlowDefinitionSchema.parse({
      version: 1,
      trigger: { channel: "voice", fromE164: "+14159851909" },
      steps: [
        { id: "r", type: "ring_handoff", toE164: "+16025245719" },
        { id: "ai1", type: "voice_ai_intake", notifyE164: "+16026951142" },
        { id: "ai2", type: "voice_ai_intake", notifyE164: "+16026951142" }
      ]
    });
    expect(validateDefinitionSemantics(parsed)).toContain(
      "A voice flow can have at most one voice_ai_intake."
    );
  });

  it("rejects a voice_transfer mixed with other steps", () => {
    const parsed = aiFlowDefinitionSchema.parse({
      version: 1,
      trigger: { channel: "voice", fromE164: "+14159851909" },
      steps: [
        { id: "t", type: "voice_transfer", toE164: "+16026951142" },
        { id: "r", type: "ring_handoff", toE164: "+16025245719" }
      ]
    });
    expect(validateDefinitionSemantics(parsed)).toContain(
      "A voice_transfer flow connects the caller straight to one number; it must be the only step (no ring_handoff/voice_ai_intake)."
    );
  });

  it("flags duplicate step ids inside a voice flow", () => {
    const parsed = aiFlowDefinitionSchema.parse({
      version: 1,
      trigger: { channel: "voice", fromE164: "+14159851909" },
      steps: [
        { id: "dup", type: "ring_handoff", toE164: "+16025245719" },
        { id: "dup", type: "ring_handoff", toE164: "+16026951142" }
      ]
    });
    expect(validateDefinitionSemantics(parsed)).toContain('Duplicate step id "dup".');
  });

  it("rejects a voice flow with no ringable step", () => {
    const parsed = aiFlowDefinitionSchema.parse({
      version: 1,
      trigger: { channel: "voice", fromE164: "+14159851909" },
      steps: [{ id: "ai", type: "voice_ai_intake", notifyE164: "+16026951142" }]
    });
    expect(validateDefinitionSemantics(parsed)).toContain(
      "A voice flow needs at least one ring_handoff (or a single voice_transfer)."
    );
  });

  it("accepts an outbound voice flow with a single outbound_call step", () => {
    const parsed = aiFlowDefinitionSchema.parse({
      version: 1,
      trigger: { channel: "voice", direction: "outbound" },
      steps: [
        {
          id: "c",
          type: "outbound_call",
          toE164: "+19178628675",
          notifyE164: "+16026951142",
          persona: "Amy's assistant",
          captureFields: ["name", "timeline"]
        }
      ]
    });
    expect(validateDefinitionSemantics(parsed)).toEqual([]);
    expect(summarizeDefinition(parsed)).toBe("When you place an outbound call: outbound_call");
  });

  it("rejects an outbound voice flow that has more than the outbound_call step", () => {
    const parsed = aiFlowDefinitionSchema.parse({
      version: 1,
      trigger: { channel: "voice", direction: "outbound" },
      steps: [
        { id: "c", type: "outbound_call", notifyE164: "+16026951142" },
        { id: "r", type: "ring_handoff", toE164: "+16025245719" }
      ]
    });
    expect(validateDefinitionSemantics(parsed)).toContain(
      "An outbound voice flow must contain exactly one outbound_call step (and no inbound voice steps)."
    );
  });

  it("rejects outbound_call inside an inbound voice flow", () => {
    const parsed = aiFlowDefinitionSchema.parse({
      version: 1,
      trigger: { channel: "voice", fromE164: "+14159851909" },
      steps: [{ id: "c", type: "outbound_call", notifyE164: "+16026951142" }]
    });
    expect(validateDefinitionSemantics(parsed)).toContain(
      'outbound_call is only valid in an outbound voice flow (set the trigger direction to "outbound").'
    );
  });

  it("rejects an inbound voice flow with no caller number", () => {
    const parsed = aiFlowDefinitionSchema.parse({
      version: 1,
      trigger: { channel: "voice" },
      steps: [{ id: "r", type: "ring_handoff", toE164: "+16025245719" }]
    });
    expect(validateDefinitionSemantics(parsed)).toContain(
      "An inbound voice flow needs a caller; set fromE164 or pick a saved contact (fromRef) on its trigger."
    );
  });

  const outboundStep = {
    id: "c",
    type: "outbound_call" as const,
    toE164: "+19178628675",
    notifyE164: "+16026951142"
  };

  it("accepts a daily-scheduled outbound voice flow", () => {
    const parsed = aiFlowDefinitionSchema.parse({
      version: 1,
      trigger: {
        channel: "voice",
        direction: "outbound",
        time: "09:00",
        timezone: "America/Phoenix",
        daysOfWeek: [1, 2, 3, 4, 5]
      },
      steps: [outboundStep]
    });
    expect(validateDefinitionSemantics(parsed)).toEqual([]);
    expect(parsed.trigger.channel).toBe("voice");
  });

  it("accepts an interval-scheduled outbound voice flow", () => {
    const parsed = aiFlowDefinitionSchema.parse({
      version: 1,
      trigger: { channel: "voice", direction: "outbound", everyMinutes: 60 },
      steps: [outboundStep]
    });
    expect(validateDefinitionSemantics(parsed)).toEqual([]);
  });

  it("rejects a schedule on an inbound voice flow", () => {
    expect(() =>
      aiFlowDefinitionSchema.parse({
        version: 1,
        trigger: { channel: "voice", fromE164: "+14159851909", everyMinutes: 60 },
        steps: [{ id: "r", type: "ring_handoff", toE164: "+16025245719" }]
      })
    ).toThrow(/Only outbound voice flows can be scheduled/);
  });

  it("rejects mixing a daily time and everyMinutes on an outbound voice flow", () => {
    expect(() =>
      aiFlowDefinitionSchema.parse({
        version: 1,
        trigger: {
          channel: "voice",
          direction: "outbound",
          time: "09:00",
          timezone: "America/Phoenix",
          everyMinutes: 60
        },
        steps: [outboundStep]
      })
    ).toThrow(/use either a daily time or everyMinutes, not both/);
  });

  it("rejects a daily schedule missing the timezone on an outbound voice flow", () => {
    expect(() =>
      aiFlowDefinitionSchema.parse({
        version: 1,
        trigger: { channel: "voice", direction: "outbound", time: "09:00" },
        steps: [outboundStep]
      })
    ).toThrow(/daily mode needs both time and timezone/);
  });
});
