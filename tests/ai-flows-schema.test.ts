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
});
