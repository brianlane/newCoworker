import { describe, expect, it } from "vitest";
import {
  EMPLOYEE_NAME_PLACEHOLDER,
  NAME_PLACEHOLDER,
  NIL_UUID,
  OWNER_EMAIL_PLACEHOLDER,
  OWNER_PHONE_PLACEHOLDER,
  applyLibrarySubstitutions,
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
    expect(json).toContain(OWNER_PHONE_PLACEHOLDER);
    expect(json).toContain(OWNER_EMAIL_PLACEHOLDER);
  });

  it("blanks tenant-specific connection ids and pins", () => {
    const steps = scrubbed.steps as Record<string, unknown>[];
    const trigger = scrubbed.trigger as Record<string, unknown>;
    expect(trigger.connectionId).toBe(NIL_UUID);
    expect(steps[2].toAgentName).toBe(EMPLOYEE_NAME_PLACEHOLDER);
    expect(steps[3].fromConnectionId).toBeUndefined();
    expect(steps[4].agentName).toBeUndefined();
  });

  it("drops http_call endpoint path and bodyTemplate (tenant secrets)", () => {
    expect(json).not.toContain("SECRET123");
    expect(json).not.toContain("sk_live_DEADBEEF");
    const steps = scrubbed.steps as Record<string, unknown>[];
    expect(steps[5].path).toBeUndefined();
    expect(steps[5].bodyTemplate).toBeUndefined();
    expect(steps[5].label).toBe("Post to webhook");
  });

  it("does not mutate the input definition", () => {
    expect((piiDefinition.steps[1] as { to: string }).to).toBe("+15826866672");
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
