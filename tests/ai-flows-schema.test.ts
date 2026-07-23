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

describe("contact-event / birthday triggers + calendar event_canceled", () => {
  const stepsOnly = [{ id: "s1", type: "notify_owner", message: "hi {{trigger.from}}" }];

  it("parses every new trigger channel", () => {
    for (const trigger of [
      { channel: "contact_created", conditions: [] },
      { channel: "tag_changed", tag: "Engaged", change: "removed", conditions: [] },
      { channel: "tag_changed", conditions: [{ type: "contains", value: "vip" }] },
      { channel: "owner_assigned", conditions: [] },
      { channel: "birthday", time: "10:30", timezone: "America/Phoenix", conditions: [] },
      { channel: "calendar", on: "event_canceled", conditions: [] }
    ]) {
      const def = parseAiFlowDefinition({ version: 1, trigger, steps: stepsOnly });
      expect(def.trigger.channel).toBe(trigger.channel);
    }
  });

  it("rejects out-of-range tag/change/time values at the shape layer", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "tag_changed", change: "renamed", conditions: [] },
        steps: stepsOnly
      })
    ).toThrow(AiFlowValidationError);
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "birthday", time: "9am", conditions: [] },
        steps: stepsOnly
      })
    ).toThrow(AiFlowValidationError);
  });

  it("summarizes the new channels", () => {
    const summarize = (trigger: Record<string, unknown>) =>
      summarizeDefinition(
        parseAiFlowDefinition({ version: 1, trigger, steps: stepsOnly })
      );
    expect(summarize({ channel: "contact_created", conditions: [] })).toContain(
      "When a contact is created"
    );
    expect(
      summarize({ channel: "tag_changed", tag: "Won", conditions: [] })
    ).toContain('When the tag "Won" is added');
    expect(summarize({ channel: "tag_changed", change: "removed", conditions: [] })).toContain(
      "is removed"
    );
    expect(summarize({ channel: "owner_assigned", conditions: [] })).toContain(
      "assigned an owner"
    );
    expect(summarize({ channel: "birthday", conditions: [] })).toContain(
      "On a contact's birthday (at 09:00)"
    );
    expect(
      summarize({ channel: "calendar", on: "event_canceled", conditions: [] })
    ).toContain("canceled");
    expect(
      summarize({
        channel: "contact_created",
        conditions: [{ type: "contains", value: "vip" }]
      })
    ).toContain("matching 1 condition(s)");
  });
});

describe("sleep wait modes (untilDate / relativeTo)", () => {
  const flowWith = (sleep: Record<string, unknown>) => ({
    version: 1,
    trigger: { channel: "calendar", on: "event_start", leadMinutes: 30, conditions: [] },
    steps: [
      { id: "e1", type: "extract_text", fields: [{ name: "renewal_date" }] },
      { id: "z1", type: "sleep", ...sleep },
      { id: "n1", type: "notify_owner", message: "time!" }
    ]
  });

  it("accepts the untilDate and relativeTo modes", () => {
    expect(() =>
      parseAiFlowDefinition(flowWith({ untilDateTemplate: "{{vars.renewal_date}}" }))
    ).not.toThrow();
    expect(() =>
      parseAiFlowDefinition(
        flowWith({ relativeToTemplate: "{{trigger.starts_at}}", offsetMinutes: -120 })
      )
    ).not.toThrow();
  });

  it("rejects mixed modes, half a relativeTo pair, and templates out of scope", () => {
    const issuesOf = (sleep: Record<string, unknown>) =>
      validateDefinitionSemantics(aiFlowDefinitionSchema.parse(flowWith(sleep)));
    expect(
      issuesOf({ minutes: 60, untilDateTemplate: "{{vars.renewal_date}}" }).some((i) =>
        i.includes("mixes wait modes")
      )
    ).toBe(true);
    expect(
      issuesOf({ offsetMinutes: -120 }).some((i) => i.includes("no relativeToTemplate"))
    ).toBe(true);
    expect(
      issuesOf({ relativeToTemplate: "{{trigger.starts_at}}" }).some((i) =>
        i.includes("needs offsetMinutes")
      )
    ).toBe(true);
    expect(
      issuesOf({ untilDateTemplate: "{{vars.never_extracted}}" }).some((i) =>
        i.includes("never_extracted")
      )
    ).toBe(true);
  });
});

describe("math step", () => {
  const flowWith = (math: Record<string, unknown>) => ({
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [
      { id: "e1", type: "extract_text", fields: [{ name: "quote_amount" }] },
      { id: "m1", type: "math", ...math },
      // The result var is in scope for later steps.
      { id: "n1", type: "notify_owner", message: "score {{vars.score}}" }
    ]
  });

  it("parses, registers saveAs for later steps, and enforces the right-operand rules", () => {
    expect(() =>
      parseAiFlowDefinition(
        flowWith({ operation: "add", left: "{{vars.quote_amount}}", right: "10", saveAs: "score" })
      )
    ).not.toThrow();
    const issuesOf = (math: Record<string, unknown>) =>
      validateDefinitionSemantics(aiFlowDefinitionSchema.parse(flowWith(math)));
    expect(
      issuesOf({ operation: "add", left: "1", saveAs: "score" }).some((i) =>
        i.includes("needs a right operand")
      )
    ).toBe(true);
    expect(
      issuesOf({ operation: "round", left: "1.5", right: "2", saveAs: "score" }).some((i) =>
        i.includes("remove the unused right operand")
      )
    ).toBe(true);
  });

  it("scope-checks the operand templates", () => {
    const issues = validateDefinitionSemantics(
      aiFlowDefinitionSchema.parse(
        flowWith({ operation: "add", left: "{{vars.missing_var}}", right: "1", saveAs: "score" })
      )
    );
    expect(issues.some((i) => i.includes("missing_var"))).toBe(true);
  });
});

describe("definition drip pacing", () => {
  it("parses drip and bounds the interval", () => {
    const base = {
      version: 1,
      trigger: { channel: "webhook", conditions: [] },
      steps: [{ id: "s1", type: "notify_owner", message: "lead" }]
    };
    const def = parseAiFlowDefinition({ ...base, drip: { intervalMinutes: 5 } });
    expect(def.drip?.intervalMinutes).toBe(5);
    expect(() =>
      parseAiFlowDefinition({ ...base, drip: { intervalMinutes: 0 } })
    ).toThrow(AiFlowValidationError);
    expect(() =>
      parseAiFlowDefinition({ ...base, drip: { intervalMinutes: 2000 } })
    ).toThrow(AiFlowValidationError);
  });
});

describe("goal step (GHL-style Goal Events)", () => {
  const goalFlow = (goalStep: Record<string, unknown>) => ({
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [
      { id: "s1", type: "send_sms", to: "{{trigger.from}}", body: "hi" },
      goalStep,
      { id: "s3", type: "notify_owner", message: "past the goal" }
    ]
  });

  it("accepts a trunk goal with every event kind (tag_added carrying its tag)", () => {
    const def = parseAiFlowDefinition(
      goalFlow({
        id: "g1",
        type: "goal",
        label: "Converted",
        events: [
          { kind: "replied" },
          { kind: "appointment_booked" },
          { kind: "tag_added", tag: "Won" },
          { kind: "claimed" }
        ]
      })
    );
    const goal = def.steps[1];
    expect(goal.type === "goal" && goal.events).toHaveLength(4);
  });

  it("rejects tag_added without a tag, and a tag on any other kind", () => {
    const noTag = validateDefinitionSemantics(
      aiFlowDefinitionSchema.parse(
        goalFlow({ id: "g1", type: "goal", label: "x", events: [{ kind: "tag_added" }] })
      )
    );
    expect(noTag.some((i) => i.includes("names no tag"))).toBe(true);

    const strayTag = validateDefinitionSemantics(
      aiFlowDefinitionSchema.parse(
        goalFlow({
          id: "g1",
          type: "goal",
          label: "x",
          events: [{ kind: "replied", tag: "Won" }]
        })
      )
    );
    expect(strayTag.some((i) => i.includes('tags only apply to "tag_added"'))).toBe(true);
  });

  it("rejects a goal nested inside a branch arm (trunk-only)", () => {
    const def = aiFlowDefinitionSchema.parse({
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        { id: "s1", type: "extract_text", fields: [{ name: "lead_type" }] },
        {
          id: "b1",
          type: "branch",
          question: "path?",
          branches: [
            {
              id: "arm1",
              label: "Buyers",
              condition: { var: "lead_type", equals: "buyer" },
              steps: [
                { id: "g1", type: "goal", label: "Booked", events: [{ kind: "appointment_booked" }] }
              ]
            }
          ],
          else: []
        }
      ]
    });
    const issues = validateDefinitionSemantics(def);
    expect(issues.some((i) => i.includes("goals must sit on the main path"))).toBe(true);
  });

  it("rejects out-of-range events (empty list, > 4 entries) at the shape layer", () => {
    expect(() =>
      parseAiFlowDefinition(goalFlow({ id: "g1", type: "goal", label: "x", events: [] }))
    ).toThrow(AiFlowValidationError);
    expect(() =>
      parseAiFlowDefinition(
        goalFlow({
          id: "g1",
          type: "goal",
          label: "x",
          events: Array.from({ length: 5 }, () => ({ kind: "replied" }))
        })
      )
    ).toThrow(AiFlowValidationError);
  });

  it("rejects a replied goal on a stopOnResponse flow (the two reply reactions contradict)", () => {
    const flow = goalFlow({
      id: "g1",
      type: "goal",
      label: "Answered",
      events: [{ kind: "replied" }]
    }) as Record<string, unknown>;
    const issues = validateDefinitionSemantics(
      aiFlowDefinitionSchema.parse({ ...flow, options: { stopOnResponse: true } })
    );
    expect(issues.some((i) => i.includes("stop when the contact replies"))).toBe(true);

    // A NON-replied goal coexists with stopOnResponse fine.
    const booked = goalFlow({
      id: "g1",
      type: "goal",
      label: "Booked",
      events: [{ kind: "appointment_booked" }]
    }) as Record<string, unknown>;
    expect(
      validateDefinitionSemantics(
        aiFlowDefinitionSchema.parse({ ...booked, options: { stopOnResponse: true } })
      )
    ).toEqual([]);

    // And a replied goal without stopOnResponse stays valid.
    expect(validateDefinitionSemantics(aiFlowDefinitionSchema.parse(flow))).toEqual([]);
  });
});

describe("flow options: stopOnResponse / allowReentry / dedupeLeadRuns", () => {
  it("round-trips the booleans through parseAiFlowDefinition", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [{ id: "s1", type: "send_sms", to: "{{trigger.from}}", body: "hi" }],
      options: { stopOnResponse: true, allowReentry: false, dedupeLeadRuns: true }
    });
    expect(def.options?.stopOnResponse).toBe(true);
    expect(def.options?.allowReentry).toBe(false);
    expect(def.options?.dedupeLeadRuns).toBe(true);
  });

  it("both stay optional (omitted options parse unchanged)", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [{ id: "s1", type: "send_sms", to: "{{trigger.from}}", body: "hi" }]
    });
    expect(def.options).toBeUndefined();
  });
});

describe("notify_lead_owner step", () => {
  const flowWith = (step: Record<string, unknown>) => ({
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [
      {
        id: "s1",
        type: "extract_text",
        fields: [
          { name: "lead_phone", description: "phone" },
          { name: "lead_name", description: "name" },
          { name: "full_message", description: "their full reply" }
        ]
      },
      step
    ]
  });

  it("parses with phoneVar/nameVar produced by an earlier step and templated message", () => {
    const def = parseAiFlowDefinition(
      flowWith({
        id: "fwd",
        type: "notify_lead_owner",
        phoneVar: "lead_phone",
        nameVar: "lead_name",
        message: "Reply from {{vars.lead_name}}: {{vars.full_message}}"
      })
    );
    expect(def.steps[1]).toMatchObject({ type: "notify_lead_owner", phoneVar: "lead_phone" });
  });

  it("both locator vars are optional (owner fallback still delivers)", () => {
    parseAiFlowDefinition(
      flowWith({ id: "fwd", type: "notify_lead_owner", message: "{{trigger.windowText}}" })
    );
  });

  it("rejects a phoneVar or nameVar no earlier step produces", () => {
    for (const bad of [
      { phoneVar: "mystery_phone" },
      { nameVar: "mystery_name" }
    ]) {
      try {
        parseAiFlowDefinition(
          flowWith({ id: "fwd", type: "notify_lead_owner", message: "hi", ...bad })
        );
        expect.unreachable("expected validation to fail");
      } catch (e) {
        expect(e).toBeInstanceOf(AiFlowValidationError);
        expect((e as AiFlowValidationError).issues.join("\n")).toMatch(
          /which no earlier step produces/
        );
      }
    }
  });

  it("rejects a message referencing an unproduced var (template scope check)", () => {
    expect(() =>
      parseAiFlowDefinition(
        flowWith({ id: "fwd", type: "notify_lead_owner", message: "{{vars.never_made}}" })
      )
    ).toThrow();
  });
});

describe("route_to_team ownerDirectNudges", () => {
  const routed = (route: Record<string, unknown>) => ({
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [
      {
        id: "s1",
        type: "extract_text",
        fields: [{ name: "price_band", description: "over_1m or under_1m" }]
      },
      {
        id: "route",
        type: "route_to_team",
        offerTemplate: "New lead",
        ownerFallbackTemplate: "Back to you",
        ...route
      }
    ]
  });

  it("parses alongside the keep-for-owner rule", () => {
    const def = parseAiFlowDefinition(
      routed({
        ownerDirectWhen: { var: "price_band", equals: "over_1m" },
        ownerDirectTemplate: "HIGH-VALUE kept for you",
        ownerDirectNudges: true
      })
    );
    expect(def.steps[1]).toMatchObject({ ownerDirectNudges: true });
  });

  it("rejects nudges without the keep-for-owner rule (nothing to nudge about)", () => {
    try {
      parseAiFlowDefinition(routed({ ownerDirectNudges: true }));
      expect.unreachable("expected validation to fail");
    } catch (e) {
      expect(e).toBeInstanceOf(AiFlowValidationError);
      expect((e as AiFlowValidationError).issues.join("\n")).toMatch(
        /ownerDirectNudges without ownerDirectWhen/
      );
    }
  });
});

describe("doc_extract step", () => {
  const docFlow = (step: Record<string, unknown>) => ({
    version: 1,
    trigger: { channel: "tenant_email", conditions: [] },
    steps: [step, { id: "s2", type: "notify_owner", message: "read {{vars.renewal_date}}" }]
  });

  it("parses with defaulted source and registers its fields for later steps", () => {
    const def = parseAiFlowDefinition(
      docFlow({
        id: "d1",
        type: "doc_extract",
        fields: [{ name: "renewal_date", description: "the renewal date" }]
      })
    );
    const step = def.steps[0];
    expect(step.type === "doc_extract" && step.fields[0].name).toBe("renewal_date");
  });

  it("accepts an explicit source template + fileAs, and validates their scopes", () => {
    const def = parseAiFlowDefinition(
      docFlow({
        id: "d1",
        type: "doc_extract",
        sourceTemplate: "{{trigger.document}}",
        fields: [{ name: "renewal_date" }],
        fileAs: { titleTemplate: "Renewal — {{trigger.document_name}}", audience: "staff" }
      })
    );
    expect(def.steps[0].type).toBe("doc_extract");

    // A sourceTemplate referencing an unproduced var fails scope validation.
    expect(() =>
      parseAiFlowDefinition(
        docFlow({
          id: "d1",
          type: "doc_extract",
          sourceTemplate: "{{vars.never_produced}}",
          fields: [{ name: "renewal_date" }]
        })
      )
    ).toThrow(AiFlowValidationError);

    // Same for the filing title template.
    expect(() =>
      parseAiFlowDefinition(
        docFlow({
          id: "d1",
          type: "doc_extract",
          fields: [{ name: "renewal_date" }],
          fileAs: { titleTemplate: "{{vars.never_produced}}" }
        })
      )
    ).toThrow(AiFlowValidationError);
  });

  it("rejects an empty field list at the shape layer", () => {
    expect(() =>
      parseAiFlowDefinition(docFlow({ id: "d1", type: "doc_extract", fields: [] }))
    ).toThrow(AiFlowValidationError);
  });

  it("is rejected inside voice flows like every other batch step", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "voice", fromE164: "+16025550111" },
        steps: [{ id: "d1", type: "doc_extract", fields: [{ name: "x" }] }]
      })
    ).toThrow(AiFlowValidationError);
  });

  it("record sinks: contactPhoneVar accepts earlier vars AND this step's own fields", () => {
    // Own extracted field (the document carries the customer's number).
    const ownField = parseAiFlowDefinition(
      docFlow({
        id: "d1",
        type: "doc_extract",
        fields: [{ name: "renewal_date" }, { name: "customer_phone" }],
        fileAs: {
          titleTemplate: "Quote",
          contactPhoneVar: "customer_phone",
          recordFieldsFromExtraction: true,
          renewalDateField: "renewal_date"
        }
      })
    );
    expect(ownField.steps[0].type).toBe("doc_extract");

    // An earlier step's var works too.
    const earlierVar = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "tenant_email", conditions: [] },
      steps: [
        {
          id: "e1",
          type: "extract_text",
          fields: [{ name: "lead_phone" }]
        },
        {
          id: "d1",
          type: "doc_extract",
          fields: [{ name: "renewal_date" }],
          fileAs: { titleTemplate: "Quote", contactPhoneVar: "lead_phone" }
        }
      ]
    });
    expect(earlierVar.steps[1].type).toBe("doc_extract");

    // An unproduced var is a scope error.
    const badVar = aiFlowDefinitionSchema.parse(
      docFlow({
        id: "d1",
        type: "doc_extract",
        fields: [{ name: "renewal_date" }],
        fileAs: { titleTemplate: "Quote", contactPhoneVar: "never_produced" }
      })
    );
    expect(
      validateDefinitionSemantics(badVar).some((i) => i.includes("links the filed document"))
    ).toBe(true);
  });

  it("record sinks: renewalDateField must be one of the step's own fields", () => {
    const bad = aiFlowDefinitionSchema.parse(
      docFlow({
        id: "d1",
        type: "doc_extract",
        fields: [{ name: "renewal_date" }],
        fileAs: { titleTemplate: "Quote", renewalDateField: "premium" }
      })
    );
    expect(
      validateDefinitionSemantics(bad).some((i) =>
        i.includes("not one of the step's extracted fields")
      )
    ).toBe(true);
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

  it("preserves preferContactOwner (owner-first routing for repeat leads)", () => {
    const withPref = JSON.parse(JSON.stringify(routedInput));
    withPref.steps[2].preferContactOwner = true;
    const def = parseAiFlowDefinition(withPref);
    const step = def.steps[2];
    expect(step.type === "route_to_team" && step.preferContactOwner).toBe(true);
    expect(validateDefinitionSemantics(def)).toEqual([]);
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

  it("allows {{vars.group_lead_phone}} with no producing step (engine-provided)", () => {
    const def = aiFlowDefinitionSchema.parse({
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        {
          id: "n",
          type: "notify_owner",
          message: "Lead's number: {{vars.group_lead_phone}}",
          // The var is "" when the thread wasn't a group / was ambiguous, so a
          // consuming step guards on the E.164 "+" the same way recall_url
          // consumers guard on "http".
          when: { var: "group_lead_phone", contains: "+" }
        }
      ]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("accepts fromConnectionId and rejects combining it with attachments", () => {
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
    expect(
      validateDefinitionSemantics(
        mk({ attachDocumentTemplate: "business-docs:33333333-3333-4333-8333-333333333333" })
      ).some((i) =>
        i.includes("attachments are only supported when sending from your AI coworker's email")
      )
    ).toBe(true);
  });

  it("scope-checks {{vars.x}} inside attachDocumentTemplate", () => {
    const mk = (attachDocumentTemplate: string, extraSteps: unknown[] = []) =>
      aiFlowDefinitionSchema.parse({
        version: 1,
        trigger: { channel: "tenant_email", conditions: [] },
        steps: [
          ...extraSteps,
          {
            id: "e",
            type: "send_email",
            to: "a@b.com",
            subject: "s",
            body: "b",
            attachDocumentTemplate
          }
        ]
      });
    // A ref built from an earlier run_agent filing var: valid.
    const withAgent = mk("business-docs:{{vars.summary_document_id}}", [
      {
        id: "agent",
        type: "run_agent",
        agentId: "44444444-4444-4444-8444-444444444444",
        documentTemplate: "{{trigger.document}}",
        saveDocument: { titleTemplate: "Summary" },
        saveAs: "summary"
      }
    ]);
    expect(validateDefinitionSemantics(withAgent)).toEqual([]);
    // A var no earlier step produces: flagged.
    expect(
      validateDefinitionSemantics(mk("business-docs:{{vars.ghost_document}}")).some((i) =>
        i.includes("{{vars.ghost_document}}")
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
    ).toBe("Every 1 hour: notify_owner");
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
    expect(
      summarizeDefinition({ version: 1, trigger: { channel: "webhook", conditions: [] }, steps })
    ).toBe("When any webhook event arrives: notify_owner");
    expect(
      summarizeDefinition({
        version: 1,
        trigger: { channel: "webhook", conditions: [{ type: "has_url" }] },
        steps
      })
    ).toBe("When a webhook event matches 1 condition(s): notify_owner");
    expect(
      summarizeDefinition({
        version: 1,
        trigger: { channel: "calendar", on: "event_created", conditions: [] },
        steps
      })
    ).toBe("When a calendar event is created: notify_owner");
    expect(
      summarizeDefinition({
        version: 1,
        trigger: {
          channel: "calendar",
          on: "event_start",
          leadMinutes: 30,
          conditions: [{ type: "has_url" }]
        },
        steps
      })
    ).toBe("30 minutes before a calendar event starts (matching 1 condition(s)): notify_owner");
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

  it("validates sleep: exactly one wait mode", () => {
    const steps = [{ id: "z", type: "sleep", minutes: 300 }];
    expect(parseAiFlowDefinition({ version: 1, trigger: { channel: "manual" }, steps }).steps[0].type).toBe("sleep");
    // untilTime + timezone is the other valid mode.
    parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "manual" },
      steps: [{ id: "z", type: "sleep", untilTime: "08:30", timezone: "America/Toronto" }]
    });
    // Both modes → reject; half a daily mode → reject; neither → reject.
    for (const bad of [
      { id: "z", type: "sleep", minutes: 5, untilTime: "08:30", timezone: "America/Toronto" },
      { id: "z", type: "sleep", untilTime: "08:30" },
      { id: "z", type: "sleep" }
    ]) {
      expect(() =>
        parseAiFlowDefinition({ version: 1, trigger: { channel: "manual" }, steps: [bad] })
      ).toThrow(AiFlowValidationError);
    }
  });

  it("validates wait_for_reply: phoneVar must exist, saveAs feeds later when-branches", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "webhook", conditions: [] },
      steps: [
        { id: "e", type: "extract_text", fields: [{ name: "lead_phone" }] },
        { id: "s", type: "send_sms", to: "{{vars.lead_phone}}", body: "Hi!" },
        { id: "w", type: "wait_for_reply", phoneVar: "lead_phone", timeoutMinutes: 300 },
        {
          id: "nudge",
          type: "send_sms",
          to: "{{vars.lead_phone}}",
          body: "Just checking in!",
          when: { var: "reply_text", equals: "no_reply" }
        }
      ]
    });
    expect(def.steps).toHaveLength(4);
    // phoneVar no earlier step produces → semantic issue.
    try {
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "manual" },
        steps: [{ id: "w", type: "wait_for_reply", phoneVar: "ghost_phone" }]
      });
      expect.unreachable("expected wait_for_reply phoneVar validation to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(AiFlowValidationError);
      expect((err as AiFlowValidationError).issues.join(" ")).toContain(
        "waits for a reply from"
      );
    }
    // A custom saveAs registers that var instead of reply_text.
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "webhook", conditions: [] },
        steps: [
          { id: "e", type: "extract_text", fields: [{ name: "p" }] },
          { id: "w", type: "wait_for_reply", phoneVar: "p", saveAs: "answer" },
          {
            id: "n",
            type: "notify_owner",
            message: "x",
            when: { var: "reply_text", equals: "no_reply" }
          }
        ]
      })
    ).toThrow(AiFlowValidationError);
  });

  it("accepts the engine-provided claimed_agent_phone as a wait_for_reply phoneVar", () => {
    // The bad-phone-report pattern: after a route_to_team claim, park on the
    // CLAIMING teammate's next text and classify it. claimed_agent_phone /
    // claimed_agent_eta_minutes are engine-provided (no step produces them).
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "webhook", conditions: [] },
      steps: [
        { id: "e", type: "extract_text", fields: [{ name: "lead_phone" }] },
        {
          id: "r",
          type: "route_to_team",
          offerTemplate: "New lead {{vars.lead_phone}} — reply 1 to claim.",
          ownerFallbackTemplate: "Back to you.",
          responseMinutes: 10
        },
        {
          id: "m",
          type: "math",
          operation: "add",
          left: "{{vars.claimed_agent_eta_minutes}}",
          right: "60",
          saveAs: "report_wait_minutes",
          when: { var: "claimed_agent_phone", notEquals: "none" }
        },
        {
          id: "w",
          type: "wait_for_reply",
          phoneVar: "claimed_agent_phone",
          saveAs: "agent_report",
          timeoutMinutes: 60,
          timeoutMinutesTemplate: "{{vars.report_wait_minutes}}",
          when: { var: "claimed_agent_phone", notEquals: "none" }
        }
      ]
    });
    const wait = def.steps[3];
    expect(wait.type === "wait_for_reply" && wait.timeoutMinutesTemplate).toBe(
      "{{vars.report_wait_minutes}}"
    );
  });

  it("scope-checks timeoutMinutesTemplate like any other template", () => {
    try {
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "webhook", conditions: [] },
        steps: [
          { id: "e", type: "extract_text", fields: [{ name: "p" }] },
          {
            id: "w",
            type: "wait_for_reply",
            phoneVar: "p",
            timeoutMinutesTemplate: "{{vars.ghost_minutes}}"
          }
        ]
      });
      expect.unreachable("expected timeoutMinutesTemplate scope check to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(AiFlowValidationError);
      expect((err as AiFlowValidationError).issues.join(" ")).toContain("ghost_minutes");
    }
  });

  it("accepts additional triggers (OR set) and summarizes the extra count", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      triggers: [
        { channel: "webhook", conditions: [] },
        { channel: "tenant_email", conditions: [{ type: "has_url" }] }
      ],
      steps: [{ id: "s1", type: "notify_owner", message: "lead!" }]
    });
    expect(def.triggers).toHaveLength(2);
    expect(summarizeDefinition(def)).toContain("(or 2 other triggers)");
    // Singular form for one extra.
    const one = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "manual" },
      triggers: [{ channel: "webhook", conditions: [] }],
      steps: [{ id: "s1", type: "notify_owner", message: "x" }]
    });
    expect(summarizeDefinition(one)).toContain("(or 1 other trigger)");
  });

  it("caps extra triggers at 4 and keeps voice single-trigger (both directions)", () => {
    const step = { id: "s1", type: "notify_owner", message: "x" };
    // 5 extras → zod cap.
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "manual" },
        triggers: Array.from({ length: 5 }, () => ({ channel: "manual" })),
        steps: [step]
      })
    ).toThrow(AiFlowValidationError);
    // A voice PRIMARY cannot carry extras...
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "voice", fromE164: "+16025551234" },
        triggers: [{ channel: "manual" }],
        steps: [{ id: "v1", type: "voice_transfer", toE164: "+16025556789" }]
      })
    ).toThrow(AiFlowValidationError);
    // ...and voice cannot BE an extra.
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "manual" },
        triggers: [{ channel: "voice", fromE164: "+16025551234" }],
        steps: [step]
      })
    ).toThrow(AiFlowValidationError);
  });

  it("applies the from_matches exactly-one-sender rule to EXTRA triggers too", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "manual" },
        triggers: [
          { channel: "sms", conditions: [{ type: "from_matches" }] } // no value, no ref
        ],
        steps: [{ id: "s1", type: "notify_owner", message: "x" }]
      })
    ).toThrow(AiFlowValidationError);
  });

  it("validates classify: textVar scope, unique values, reserved unclear, saveAs registers", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "webhook", conditions: [] },
      steps: [
        { id: "e", type: "extract_text", fields: [{ name: "lead_phone" }] },
        { id: "w", type: "wait_for_reply", phoneVar: "lead_phone" },
        {
          id: "c",
          type: "classify",
          textVar: "reply_text",
          categories: [{ value: "wants_a_call" }, { value: "not_interested" }],
          saveAs: "intent"
        },
        // saveAs is in scope for later when-guards.
        { id: "n", type: "notify_owner", message: "call!", when: { var: "intent", equals: "wants_a_call" } }
      ]
    });
    expect(def.steps[2].type).toBe("classify");
    // textVar no earlier step produces.
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "manual" },
        steps: [
          { id: "c", type: "classify", textVar: "ghost", categories: [{ value: "a" }, { value: "b" }], saveAs: "x" }
        ]
      })
    ).toThrow(AiFlowValidationError);
    // Duplicate category values (case-insensitive) and the reserved "unclear".
    try {
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "manual" },
        steps: [
          {
            id: "c",
            type: "classify",
            categories: [{ value: "Yes" }, { value: "yes" }, { value: "unclear" }],
            saveAs: "x"
          }
        ]
      });
      expect.unreachable("expected classify category validation to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(AiFlowValidationError);
      const joined = (err as AiFlowValidationError).issues.join(" ");
      expect(joined).toContain("more than once");
      expect(joined).toContain("reserved");
    }
  });

  it("validates update_contact: phoneVar scope + must change something", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "webhook", conditions: [] },
      steps: [
        { id: "e", type: "extract_text", fields: [{ name: "lead_phone" }] },
        {
          id: "u",
          type: "update_contact",
          phoneVar: "lead_phone",
          removeTags: ["New Lead"],
          addTags: ["Contacted"]
        }
      ]
    });
    expect(def.steps[1].type).toBe("update_contact");
    // phoneVar no earlier step produces → semantic issue.
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "manual" },
        steps: [{ id: "u", type: "update_contact", phoneVar: "ghost", addTags: ["X"] }]
      })
    ).toThrow(AiFlowValidationError);
    // Neither addTags nor removeTags → changes nothing → rejected.
    try {
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "webhook", conditions: [] },
        steps: [
          { id: "e", type: "extract_text", fields: [{ name: "lead_phone" }] },
          { id: "u", type: "update_contact", phoneVar: "lead_phone" }
        ]
      });
      expect.unreachable("expected changes-nothing validation to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(AiFlowValidationError);
      expect((err as AiFlowValidationError).issues.join(" ")).toContain("changes nothing");
    }
  });

  it("accepts a webhook trigger (push from the public API; conditions only)", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "webhook", conditions: [{ type: "from_matches", value: "facebook" }] },
      steps
    });
    expect(def.trigger.channel).toBe("webhook");
    expect(() =>
      parseAiFlowDefinition({ version: 1, trigger: { channel: "webhook" }, steps })
    ).toThrow(AiFlowValidationError);
  });

  it("accepts a calendar event_created trigger (leadMinutes rejected there)", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "calendar", on: "event_created", calendar: "shared", conditions: [] },
      steps
    });
    expect(def.trigger.channel === "calendar" && def.trigger.calendar).toBe("shared");
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "calendar", on: "event_created", leadMinutes: 30, conditions: [] },
        steps
      })
    ).toThrow(AiFlowValidationError);
  });

  it("accepts a calendar event_start trigger and requires leadMinutes", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "calendar", on: "event_start", leadMinutes: 30, conditions: [] },
      steps
    });
    expect(def.trigger.channel === "calendar" && def.trigger.leadMinutes).toBe(30);
    expect(def.trigger.channel === "calendar" && def.trigger.calendar).toBeUndefined();
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "calendar", on: "event_start", conditions: [] },
        steps
      })
    ).toThrow(AiFlowValidationError);
    // Zero would make the [start - lead, start) due window empty — dead flow.
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "calendar", on: "event_start", leadMinutes: 0, conditions: [] },
        steps
      })
    ).toThrow(AiFlowValidationError);
  });

  it("calendar-triggered steps may reference the calendar trigger scope keys", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "calendar", on: "event_start", leadMinutes: 15, conditions: [] },
      steps: [
        {
          id: "n",
          type: "notify_owner",
          message: "{{trigger.event_title}} starts at {{trigger.starts_at}} ({{trigger.calendar}})"
        }
      ]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
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

  it("send_whatsapp: accepts each recipient source, rejects zero and multiple", () => {
    const ok = baseDef();
    ok.steps = [
      { id: "w1", type: "send_whatsapp", to: "+15551234567", body: "hi" },
      { id: "w2", type: "send_whatsapp", toAgentName: "Dave", body: "hi {{agent.name}}" },
      {
        id: "w3",
        type: "send_whatsapp",
        toRef: { source: "employee", id: "22222222-2222-4222-8222-222222222222", label: "Dave" },
        body: "hi {{agent.name}}"
      }
    ] as AiFlowDefinition["steps"];
    expect(validateDefinitionSemantics(ok)).toEqual([]);

    const none = baseDef();
    none.steps = [
      { id: "w", type: "send_whatsapp", body: "hi" }
    ] as AiFlowDefinition["steps"];
    expect(validateDefinitionSemantics(none)).toContain(
      'Step "w" sends a WhatsApp message but has no recipient; set "to", "toAgentName", or "toRef".'
    );

    const multiple = baseDef();
    multiple.steps = [
      { id: "w", type: "send_whatsapp", to: "{{vars.x}}", toAgentName: "Dave", body: "hi" }
    ] as AiFlowDefinition["steps"];
    expect(validateDefinitionSemantics(multiple)).toContain(
      'Step "w" sets more than one recipient; use only one of "to", "toAgentName", or "toRef".'
    );
  });

  it("send_whatsapp: {{agent.*}} requires an agent-bearing recipient; {{vars.*}} scope-checked", () => {
    const bad = baseDef();
    bad.steps = [
      { id: "w", type: "send_whatsapp", to: "{{vars.x}}", body: "hi {{agent.name}}" }
    ] as AiFlowDefinition["steps"];
    expect(
      validateDefinitionSemantics(bad).some((i) => i.includes("{{agent.name}}"))
    ).toBe(true);

    // The `to` template string participates in the vars scope check.
    const unknownVar = baseDef();
    unknownVar.steps = [
      { id: "w", type: "send_whatsapp", to: "{{vars.never_produced}}", body: "hi" }
    ] as AiFlowDefinition["steps"];
    expect(
      validateDefinitionSemantics(unknownVar).some((i) =>
        i.includes("{{vars.never_produced}}")
      )
    ).toBe(true);
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

  it("accepts agentNameVar as the sole pin when an earlier step produces the var", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
      steps: [
        {
          id: "x",
          type: "extract_text",
          fields: [{ name: "assigned_agent", description: "teammate named, else none" }]
        },
        {
          id: "r",
          type: "route_to_team",
          agentNameVar: "assigned_agent",
          offerTemplate: "Offer to {{agent.name}}",
          ownerFallbackTemplate: "No one took it"
        }
      ]
    });
    const step = def.steps[1];
    expect(step.type === "route_to_team" && step.agentNameVar).toBe("assigned_agent");
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects agentNameVar alongside any static pin or broadcast", () => {
    for (const extra of [
      { agentName: "Dave" },
      { agentRef: employeeRef },
      { agentNames: ["Dave", "Gabby"] },
      { broadcastAll: true }
    ]) {
      const def = aiFlowDefinitionSchema.parse(
        routedWith({ agentNameVar: "assigned_agent", ...extra })
      );
      expect(validateDefinitionSemantics(def)).toContain(
        'Step "r" sets agentNameVar alongside another pin/broadcast option; the dynamic pin is mutually exclusive with agentName/agentRef/agentNames/broadcastAll.'
      );
    }
  });

  it("rejects an agentNameVar no earlier step produces", () => {
    const def = aiFlowDefinitionSchema.parse(routedWith({ agentNameVar: "assigned_agent" }));
    expect(validateDefinitionSemantics(def)).toContain(
      'Step "r" pins via {{vars.assigned_agent}} which no earlier step produces.'
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

describe("calendar event_end trigger", () => {
  const steps = [{ id: "n", type: "notify_owner", message: "hi" }];

  it("accepts event_end with and without followMinutes", () => {
    const withFollow = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "calendar", on: "event_end", followMinutes: 60, conditions: [] },
      steps
    });
    expect(withFollow.trigger.channel === "calendar" && withFollow.trigger.followMinutes).toBe(60);
    // Omitted followMinutes = fire right at the event's end.
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "calendar", on: "event_end", conditions: [] },
        steps
      })
    ).not.toThrow();
  });

  it("rejects followMinutes outside event_end mode and leadMinutes on event_end", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "calendar", on: "event_created", followMinutes: 30, conditions: [] },
        steps
      })
    ).toThrow(AiFlowValidationError);
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: {
          channel: "calendar",
          on: "event_start",
          leadMinutes: 30,
          followMinutes: 30,
          conditions: []
        },
        steps
      })
    ).toThrow(AiFlowValidationError);
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "calendar", on: "event_end", leadMinutes: 30, conditions: [] },
        steps
      })
    ).toThrow(AiFlowValidationError);
  });

  it("summarizes an event_start trigger missing its lead as 0 minutes (defensive)", () => {
    expect(
      summarizeDefinition({
        version: 1,
        trigger: { channel: "calendar", on: "event_start", conditions: [] },
        steps
      } as never)
    ).toBe("0 minutes before a calendar event starts: notify_owner");
  });

  it("summarizes event_end flows with the follow delay in the largest unit", () => {
    expect(
      summarizeDefinition({
        version: 1,
        trigger: { channel: "calendar", on: "event_end", followMinutes: 120, conditions: [] },
        steps
      } as never)
    ).toBe("2 hours after a calendar event ends: notify_owner");
    expect(
      summarizeDefinition({
        version: 1,
        trigger: { channel: "calendar", on: "event_end", conditions: [] },
        steps
      } as never)
    ).toBe("When a calendar event ends: notify_owner");
  });
});

describe("generate_image step + send_sms mediaUrlVar", () => {
  it("accepts a generate_image step and registers its saveAs for later steps", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        { id: "g1", type: "generate_image", promptTemplate: "A flyer for the open house", saveAs: "flyer_url" },
        { id: "s1", type: "send_sms", to: "+15550001111", body: "See {{vars.flyer_url}}", mediaUrlVar: "flyer_url" },
        { id: "e1", type: "send_email", to: "owner@example.com", subject: "Flyer", body: "Link: {{vars.flyer_url}}" }
      ]
    });
    const gen = def.steps[0];
    expect(gen.type === "generate_image" && gen.saveAs).toBe("flyer_url");
    const sms = def.steps[1];
    expect(sms.type === "send_sms" && sms.mediaUrlVar).toBe("flyer_url");
  });

  it("templates in promptTemplate are scope-checked like every other step", () => {
    const issues = validateDefinitionSemantics(
      aiFlowDefinitionSchema.parse({
        version: 1,
        trigger: { channel: "manual" },
        steps: [
          { id: "g1", type: "generate_image", promptTemplate: "A photo of {{vars.nope}}", saveAs: "img" }
        ]
      })
    );
    expect(issues.some((i) => i.includes("{{vars.nope}}"))).toBe(true);
  });

  it("rejects a send_sms mediaUrlVar no earlier step produces", () => {
    const issues = validateDefinitionSemantics(
      aiFlowDefinitionSchema.parse({
        version: 1,
        trigger: { channel: "manual" },
        steps: [
          { id: "s1", type: "send_sms", to: "+15550001111", body: "hi", mediaUrlVar: "missing_img" }
        ]
      })
    );
    expect(issues).toEqual([
      'Step "s1" attaches an image from {{vars.missing_img}} which no earlier step produces.'
    ]);
  });

  it("accepts an inputImageTemplate (editing mode) referencing trigger.image or earlier vars", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        {
          id: "g1",
          type: "generate_image",
          promptTemplate: "Show this face aged 20 years in the sun",
          inputImageTemplate: "{{trigger.image}}",
          saveAs: "aged_url"
        },
        { id: "s1", type: "send_sms", to: "{{trigger.from}}", body: "Here!", mediaUrlVar: "aged_url" }
      ]
    });
    const gen = def.steps[0];
    expect(gen.type === "generate_image" && gen.inputImageTemplate).toBe("{{trigger.image}}");
  });

  it("scope-checks vars referenced in inputImageTemplate", () => {
    const issues = validateDefinitionSemantics(
      aiFlowDefinitionSchema.parse({
        version: 1,
        trigger: { channel: "manual" },
        steps: [
          {
            id: "g1",
            type: "generate_image",
            promptTemplate: "restyle",
            inputImageTemplate: "{{vars.ghost_img}}",
            saveAs: "img"
          }
        ]
      })
    );
    expect(issues.some((i) => i.includes("{{vars.ghost_img}}"))).toBe(true);
  });

  it("summarizeDefinition includes the generate_image step type", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        { id: "g1", type: "generate_image", promptTemplate: "a banner", saveAs: "img" },
        { id: "n1", type: "notify_owner", message: "made {{vars.img}}" }
      ]
    });
    expect(summarizeDefinition(def)).toBe("On demand: generate_image -> notify_owner");
  });
});

describe("share_document steps", () => {
  const DOC_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  function withShareStep(step: Record<string, unknown>) {
    const input = JSON.parse(JSON.stringify(validInput));
    input.steps.push(step);
    return input;
  }

  it("accepts a full share_document step and registers its saveAs for later steps", () => {
    const def = parseAiFlowDefinition(
      withShareStep({
        id: "s7",
        type: "share_document",
        documentId: DOC_ID,
        documentTitle: "Price sheet",
        to: "{{vars.seller_phone}}",
        via: "sms",
        messageTemplate: "Here it is: {{share_url}}",
        saveAs: "price_sheet_url"
      })
    );
    expect(def.steps).toHaveLength(7);
    // The saveAs var is in scope for a later step.
    const withConsumer = withShareStep({
      id: "s7",
      type: "share_document",
      documentId: DOC_ID,
      to: "{{vars.seller_phone}}",
      saveAs: "price_sheet_url"
    });
    withConsumer.steps.push({
      id: "s8",
      type: "notify_owner",
      message: "sent {{vars.price_sheet_url}}"
    });
    expect(() => parseAiFlowDefinition(withConsumer)).not.toThrow();
  });

  it("rejects a non-uuid documentId at the shape layer", () => {
    expect(() =>
      parseAiFlowDefinition(
        withShareStep({
          id: "s7",
          type: "share_document",
          documentId: "not-a-uuid",
          to: "{{trigger.from}}"
        })
      )
    ).toThrow(AiFlowValidationError);
  });

  it("scope-checks the recipient template like any other step", () => {
    const issues = validateDefinitionSemantics(
      aiFlowDefinitionSchema.parse(
        withShareStep({
          id: "s7",
          type: "share_document",
          documentId: DOC_ID,
          to: "{{vars.never_produced}}"
        })
      )
    );
    expect(issues.some((i) => /never_produced/.test(i))).toBe(true);
  });

  it("allows the {{share_url}} placement token but still flags unknown scopes in the message", () => {
    const clean = validateDefinitionSemantics(
      aiFlowDefinitionSchema.parse(
        withShareStep({
          id: "s7",
          type: "share_document",
          documentId: DOC_ID,
          to: "{{trigger.from}}",
          messageTemplate: "Link: {{ share_url }} for {{vars.seller_phone}}"
        })
      )
    );
    expect(clean).toEqual([]);
    const dirty = validateDefinitionSemantics(
      aiFlowDefinitionSchema.parse(
        withShareStep({
          id: "s7",
          type: "share_document",
          documentId: DOC_ID,
          to: "{{trigger.from}}",
          messageTemplate: "Link: {{mystery.token}}"
        })
      )
    );
    expect(dirty.some((i) => /unknown template scope "mystery"/.test(i))).toBe(true);
  });
});
