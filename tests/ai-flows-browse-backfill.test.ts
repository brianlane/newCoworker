import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, validateDefinitionSemantics } from "@/lib/ai-flows/schema";
import { planStep } from "../supabase/functions/_shared/ai_flows/steps";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";

/**
 * browse_extract.fillOnlyEmpty exists for RE-READING a page that releases its
 * details late (a referral portal that withholds the customer's contact info
 * until after the call). Without it the second read, which still shows a blank
 * card, overwrites everything the first read established.
 */
describe("browse_extract: fillOnlyEmpty", () => {
  const plan = (step: Record<string, unknown>) =>
    planStep(
      {
        id: "recheck",
        type: "browse_extract",
        urlVar: "leadUrl",
        fields: [{ name: "lead_phone", description: "the phone" }],
        ...step
      } as FlowStep,
      { vars: { leadUrl: "https://portal.example/lead/1" }, trigger: {} } as never
    );

  it("passes the flag through to the worker when set", () => {
    const p = plan({ fillOnlyEmpty: true });
    expect(p.ok && p.action).toMatchObject({ kind: "browse", fillOnlyEmpty: true });
  });

  it("stays absent when unset, so the default overwrite behaviour is unchanged", () => {
    const p = plan({});
    expect(p.ok).toBe(true);
    expect(p.ok && (p.action as Record<string, unknown>).fillOnlyEmpty).toBeUndefined();
    const off = plan({ fillOnlyEmpty: false });
    expect(off.ok && (off.action as Record<string, unknown>).fillOnlyEmpty).toBeUndefined();
  });

  it("is authorable alongside a screenshot on the same re-read", () => {
    // The re-read is also what produces the good screenshot (the card with the
    // details on it), so the two have to coexist on one step.
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
      steps: [
        { id: "url", type: "extract_url", saveAs: "leadUrl" },
        {
          id: "card",
          type: "browse_extract",
          urlVar: "leadUrl",
          fields: [{ name: "lead_phone", description: "the phone" }]
        },
        {
          id: "recheck",
          type: "browse_extract",
          urlVar: "leadUrl",
          fillOnlyEmpty: true,
          screenshot: true,
          fields: [{ name: "lead_phone", description: "the phone" }]
        },
        {
          id: "qt",
          type: "send_email",
          to: "amy@example.com",
          subject: "QT",
          body: "Phone: {{vars.lead_phone}}",
          attachScreenshot: true
        }
      ]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });
});
