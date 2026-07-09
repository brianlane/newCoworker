import { describe, expect, it } from "vitest";
import {
  EMPLOYEE_NAME_PLACEHOLDER,
  LIBRARY_STRIPPED_PLACEHOLDER,
  NAME_PLACEHOLDER,
  NIL_UUID,
  OWNER_EMAIL_PLACEHOLDER,
  OWNER_PHONE_PLACEHOLDER,
  applyLibrarySubstitutions,
  containsLikelyPii,
  hasUnresolvedPlaceholders,
  redactText,
  scrubDefinition,
  templateKeyFromName
} from "@/lib/ai-flows/scrub";
import { parseAiFlowDefinition, type AiFlowDefinition } from "@/lib/ai-flows/schema";

describe("redactText", () => {
  it("redacts E.164 and US-formatted phone numbers", () => {
    expect(redactText("call +15826866672 now")).toBe(`call ${OWNER_PHONE_PLACEHOLDER} now`);
    expect(redactText("ph (555) 123-4567 ok")).toBe(`ph ${OWNER_PHONE_PLACEHOLDER} ok`);
  });

  it("redacts email addresses", () => {
    expect(redactText("mail amy@emylaidlaw.com please")).toBe(
      `mail ${OWNER_EMAIL_PLACEHOLDER} please`
    );
  });

  it("redacts known names case-insensitively on word boundaries", () => {
    expect(redactText("Hi Amy, thanks", ["Amy"])).toBe(`Hi ${NAME_PLACEHOLDER}, thanks`);
    // \b prevents matching inside another word
    expect(redactText("Amybeth stays", ["Amy"])).toBe("Amybeth stays");
  });

  it("leaves templates and short numbers alone", () => {
    expect(redactText("Reply within 10 minutes to {{vars.lead_phone}}")).toBe(
      "Reply within 10 minutes to {{vars.lead_phone}}"
    );
  });

  it("skips 1-char known names", () => {
    expect(redactText("hi A there", ["A"])).toBe("hi A there");
  });
});

describe("templateKeyFromName", () => {
  it("slugifies and strips a trailing (copy) suffix", () => {
    expect(templateKeyFromName("ReferralExchange lead")).toBe("referralexchange-lead");
    expect(templateKeyFromName("ReferralExchange lead (copy)")).toBe("referralexchange-lead");
    expect(templateKeyFromName("Clever Re-enroll SMS")).toBe("clever-re-enroll-sms");
  });
});

const piiDefinition = {
  version: 1 as const,
  trigger: { channel: "email" as const, connectionId: "11111111-1111-1111-1111-111111111111", conditions: [] },
  steps: [
    { id: "s1", type: "extract_text" as const, fields: [{ name: "lead_phone" }] },
    {
      id: "s2",
      type: "send_sms" as const,
      to: "+15826866672",
      body: "Hi {{vars.lead_phone}}, this is Amy at amy@emylaidlaw.com"
    },
    {
      id: "s2b",
      type: "send_sms" as const,
      toAgentName: "Amy",
      body: "Lead for {{agent.name}}"
    },
    {
      id: "s3",
      type: "send_email" as const,
      to: "amy@emylaidlaw.com",
      fromConnectionId: "22222222-2222-2222-2222-222222222222",
      subject: "Lead",
      body: "From Amy"
    },
    {
      id: "s4",
      type: "route_to_team" as const,
      offerTemplate: "claim {{offer.deadline}}",
      ownerFallbackTemplate: "back to you",
      agentName: "Amy"
    },
    {
      id: "s5",
      type: "http_call" as const,
      label: "Post to webhook",
      method: "POST" as const,
      path: "https://hooks.example.com/t/abc?token=SECRET123",
      bodyTemplate: '{"key":"sk_live_DEADBEEF"}'
    }
  ]
};

describe("scrubDefinition", () => {
  const scrubbed = scrubDefinition(piiDefinition as unknown as AiFlowDefinition, {
    knownNames: ["Amy"]
  });
  const json = JSON.stringify(scrubbed);

  it("removes literal phones, emails, and names from copy", () => {
    expect(json).not.toContain("15826866672");
    expect(json).not.toContain("amy@emylaidlaw.com");
    expect(json).not.toContain("From Amy");
    // Recipient fields are kept (redacted to placeholders) for substitution.
    expect(json).toContain(OWNER_PHONE_PLACEHOLDER);
    expect(json).toContain(OWNER_EMAIL_PLACEHOLDER);
  });

  it("blanks every author-written prose field (bodies/subjects)", () => {
    const steps = scrubbed.steps as Record<string, unknown>[];
    // send_sms bodies, send_email subject + body, route_to_team templates.
    expect(steps[1].body).toBe(LIBRARY_STRIPPED_PLACEHOLDER);
    expect(steps[2].body).toBe(LIBRARY_STRIPPED_PLACEHOLDER);
    expect(steps[3].subject).toBe(LIBRARY_STRIPPED_PLACEHOLDER);
    expect(steps[3].body).toBe(LIBRARY_STRIPPED_PLACEHOLDER);
    expect(steps[4].offerTemplate).toBe(LIBRARY_STRIPPED_PLACEHOLDER);
    expect(steps[4].ownerFallbackTemplate).toBe(LIBRARY_STRIPPED_PLACEHOLDER);
    // No body prose survives anywhere.
    expect(json).not.toContain("this is");
    expect(json).not.toContain("Lead for");
  });

  it("keeps the flow's structure (step types, recipients, var names)", () => {
    const steps = scrubbed.steps as Record<string, unknown>[];
    expect(steps[0].type).toBe("extract_text");
    expect((steps[0].fields as { name: string }[])[0].name).toBe("lead_phone");
    expect(steps[1].type).toBe("send_sms");
    expect(steps[1].to).toBe(OWNER_PHONE_PLACEHOLDER);
  });

  it("blanks tenant-specific connection ids and pins", () => {
    const steps = scrubbed.steps as Record<string, unknown>[];
    const trigger = scrubbed.trigger as Record<string, unknown>;
    expect(trigger.connectionId).toBe(NIL_UUID);
    expect(steps[2].toAgentName).toBe(EMPLOYEE_NAME_PLACEHOLDER);
    expect(steps[3].fromConnectionId).toBeUndefined();
    expect(steps[4].agentName).toBeUndefined();
  });

  it("drops http_call endpoint path and bodyTemplate (tenant secrets) and blanks the label", () => {
    expect(json).not.toContain("SECRET123");
    expect(json).not.toContain("sk_live_DEADBEEF");
    const steps = scrubbed.steps as Record<string, unknown>[];
    expect(steps[5].path).toBeUndefined();
    expect(steps[5].bodyTemplate).toBeUndefined();
    expect(steps[5].label).toBe(LIBRARY_STRIPPED_PLACEHOLDER);
  });

  it("does not mutate the input definition", () => {
    expect((piiDefinition.steps[1] as { to: string }).to).toBe("+15826866672");
    expect((piiDefinition.steps[1] as { body: string }).body).toContain("Amy");
  });
});

describe("scrubDefinition strips prose across all step/condition shapes", () => {
  it("blanks descriptions, condition values, when comparisons, and integration labels", () => {
    const def = {
      version: 1 as const,
      trigger: {
        channel: "email" as const,
        connectionId: "11111111-1111-1111-1111-111111111111",
        conditions: [
          { type: "from_matches" as const, value: "amy@amylaidlaw.com" },
          { type: "contains" as const, value: "Phoenix listing" }
        ]
      },
      steps: [
        { id: "u", type: "extract_url" as const, saveAs: "leadUrl" },
        {
          id: "b",
          type: "browse_extract" as const,
          urlVar: "leadUrl",
          auth: { integrationLabel: "Amy's private portal" },
          fields: [{ name: "lead_type", description: "Buyer or seller for Amy Laidlaw?" }]
        },
        {
          id: "n",
          type: "notify_owner" as const,
          message: "Tell Brian at PhoenixAreasBestRealtor.com",
          when: { var: "lead_type", equals: "buyer" }
        },
        {
          id: "a",
          type: "approval_gate" as const,
          prompt: "Approve sending to HomeSmart?"
        }
      ]
    };
    const scrubbed = scrubDefinition(def as unknown as AiFlowDefinition);
    const json = JSON.stringify(scrubbed);
    for (const leak of [
      "amylaidlaw",
      "Phoenix",
      "private portal",
      "Buyer or seller",
      "Brian",
      "PhoenixAreasBestRealtor",
      "HomeSmart",
      "buyer"
    ]) {
      expect(json).not.toContain(leak);
    }
    const steps = scrubbed.steps as Record<string, unknown>[];
    expect((steps[1].auth as Record<string, unknown>).integrationLabel).toBe(
      LIBRARY_STRIPPED_PLACEHOLDER
    );
    expect((steps[1].fields as Record<string, unknown>[])[0].description).toBe(
      LIBRARY_STRIPPED_PLACEHOLDER
    );
    expect((steps[2].when as Record<string, unknown>).equals).toBe(LIBRARY_STRIPPED_PLACEHOLDER);
    // condition values are blanked but the condition TYPE is kept (structure).
    const conds = (scrubbed.trigger as Record<string, unknown>).conditions as Record<
      string,
      unknown
    >[];
    expect(conds[0].type).toBe("from_matches");
    expect(conds[0].value).toBe(LIBRARY_STRIPPED_PLACEHOLDER);
  });
});

describe("scrubDefinition recurses into branch arms", () => {
  it("applies the structural fixups to steps nested inside branches", () => {
    const def = {
      version: 1 as const,
      trigger: { channel: "sms" as const, conditions: [] },
      steps: [
        { id: "x", type: "extract_text" as const, fields: [{ name: "kind" }] },
        {
          id: "br",
          type: "branch" as const,
          question: "Which kind of lead is this for Amy?",
          branches: [
            {
              id: "arm1",
              label: "Buyer",
              condition: { var: "kind", equals: "buyer" },
              steps: [
                {
                  id: "e1",
                  type: "send_email" as const,
                  to: "{{owner_email}}",
                  subject: "s",
                  body: "b",
                  fromConnectionId: "22222222-2222-2222-2222-222222222222"
                }
              ]
            }
          ],
          else: [
            {
              id: "h1",
              type: "http_call" as const,
              label: "crm",
              path: "https://hooks.example.com/secret-token",
              bodyTemplate: "{\"k\":\"secret\"}"
            }
          ]
        }
      ]
    };
    const scrubbed = scrubDefinition(def as unknown as AiFlowDefinition);
    const steps = scrubbed.steps as Record<string, unknown>[];
    const branch = steps[1] as {
      question: string;
      branches: Array<{ steps: Record<string, unknown>[] }>;
      else: Record<string, unknown>[];
    };
    // The question is author prose → blanked.
    expect(branch.question).toBe(LIBRARY_STRIPPED_PLACEHOLDER);
    // Nested arm step: tenant mailbox binding dropped.
    expect(branch.branches[0].steps[0].fromConnectionId).toBeUndefined();
    // Nested else step: endpoint secrets dropped.
    expect(branch.else[0].path).toBeUndefined();
    expect(branch.else[0].bodyTemplate).toBeUndefined();
  });
});

describe("containsLikelyPii", () => {
  it("flags a literal email or phone", () => {
    expect(containsLikelyPii({ a: "reach me at amy@amylaidlaw.com" })).toBe(true);
    expect(containsLikelyPii({ a: "call +15826866672" })).toBe(true);
  });

  it("ignores uuids, times, and bounded numbers", () => {
    expect(
      containsLikelyPii({
        connectionId: NIL_UUID,
        other: "00000000-0000-0000-0000-000000000000",
        time: "22:00",
        everyMinutes: 10080,
        responseMinutes: 1440
      })
    ).toBe(false);
  });

  it("returns false for a fully scrubbed definition", () => {
    expect(containsLikelyPii(scrubDefinition(piiDefinition as unknown as AiFlowDefinition))).toBe(
      false
    );
  });

  it("returns false when the value can't be stringified", () => {
    // JSON.stringify(undefined) === undefined -> the `?? ""` fallback.
    expect(containsLikelyPii(undefined)).toBe(false);
  });
});

describe("applyLibrarySubstitutions", () => {
  const scrubbed = scrubDefinition(piiDefinition as unknown as AiFlowDefinition, {
    knownNames: ["Amy"]
  });

  it("fills placeholders and yields a schema-valid definition", () => {
    const filled = applyLibrarySubstitutions(scrubbed, {
      ownerPhone: "+14805551234",
      ownerEmail: "new@owner.com",
      employeeName: "Jordan"
    });
    expect(hasUnresolvedPlaceholders(filled)).toBe(false);
    const parsed = parseAiFlowDefinition(filled);
    const send = parsed.steps.find((s) => s.id === "s2");
    expect(send && send.type === "send_sms" && send.to).toBe("+14805551234");
  });

  it("leaves placeholders when a value is missing", () => {
    const filled = applyLibrarySubstitutions(scrubbed, { ownerPhone: "+14805551234" });
    expect(hasUnresolvedPlaceholders(filled)).toBe(true);
  });

  it("returns the input unchanged when no values are provided", () => {
    expect(applyLibrarySubstitutions(scrubbed, {})).toBe(scrubbed);
  });
});

describe("scrubDefinition edge cases", () => {
  it("handles non-email triggers, quiet-hours, and primitive values", () => {
    const def = {
      version: 1 as const,
      trigger: { channel: "sms" as const, conditions: [{ type: "has_url" as const }] },
      steps: [
        {
          id: "s1",
          type: "send_sms" as const,
          to: "+15826866672",
          body: "ping",
          // attachScreenshot-style boolean exercises the primitive walk path;
          // quietHours.emailFromConnectionId must be stripped.
          quietHours: {
            timezone: "America/Phoenix",
            noSendAfter: "21:00",
            resumeAt: "08:00",
            emailFromConnectionId: "44444444-4444-4444-4444-444444444444"
          },
          replyToGroup: false
        }
      ]
    };
    const scrubbed = scrubDefinition(def as unknown as AiFlowDefinition);
    const steps = scrubbed.steps as Record<string, unknown>[];
    const trigger = scrubbed.trigger as Record<string, unknown>;
    // Non-email trigger: connectionId untouched (absent).
    expect(trigger.connectionId).toBeUndefined();
    expect((steps[0].quietHours as Record<string, unknown>).emailFromConnectionId).toBeUndefined();
    expect(steps[0].replyToGroup).toBe(false);
    expect(steps[0].to).toBe(OWNER_PHONE_PLACEHOLDER);
  });
});

describe("hasUnresolvedPlaceholders", () => {
  it("returns false for undefined input", () => {
    expect(hasUnresolvedPlaceholders(undefined)).toBe(false);
  });
});
