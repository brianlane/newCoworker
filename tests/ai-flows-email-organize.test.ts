import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, AiFlowValidationError } from "@/lib/ai-flows/schema";
import { scrubDefinition } from "@/lib/ai-flows/scrub";
import { planStep } from "../supabase/functions/_shared/ai_flows/steps";
import { simulateTestAction } from "../supabase/functions/_shared/ai_flows/test_mode";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";
import type { StepAction } from "../supabase/functions/_shared/ai_flows/steps";

const CONN = "16cff2b9-b4d3-421c-b25d-b40edd80c9a8";

describe("email_organize schema + planner", () => {
  it("parses a tenant-mailbox organize step", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "tenant_email", conditions: [] },
      steps: [
        {
          id: "org1",
          type: "email_organize",
          archive: true,
          markRead: true,
          addLabels: ["Sales"]
        }
      ]
    });
    expect(def.steps[0]).toMatchObject({
      type: "email_organize",
      archive: true,
      markRead: true,
      addLabels: ["Sales"]
    });
  });

  it("rejects a step with no actions", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "tenant_email", conditions: [] },
        steps: [{ id: "org1", type: "email_organize" }]
      })
    ).toThrow(AiFlowValidationError);
  });

  it("rejects markRead+markUnread and archive+unarchive conflicts", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "tenant_email", conditions: [] },
        steps: [{ id: "org1", type: "email_organize", markRead: true, markUnread: true }]
      })
    ).toThrow(AiFlowValidationError);
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "tenant_email", conditions: [] },
        steps: [{ id: "org1", type: "email_organize", archive: true, unarchive: true }]
      })
    ).toThrow(AiFlowValidationError);
  });

  it("plans message id and email_log_id from the trigger scope", () => {
    const plan = planStep(
      {
        id: "org1",
        type: "email_organize",
        archive: true,
        addLabels: ["{{vars.bucket}}"]
      } as FlowStep,
      {
        vars: { bucket: "Billing" },
        trigger: {
          channel: "tenant_email",
          windowText: "hi",
          url: null,
          from: "a@b.com",
          message_id: "rfc-123",
          email_log_id: "00000000-0000-4000-8000-000000000099"
        }
      }
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action).toMatchObject({
      kind: "email_organize",
      messageId: "rfc-123",
      emailLogId: "00000000-0000-4000-8000-000000000099",
      archive: true,
      addLabels: ["Billing"]
    });
  });

  it("falls back to trigger.connection_id on connected email triggers", () => {
    const plan = planStep(
      {
        id: "org1",
        type: "email_organize",
        archive: true
      } as FlowStep,
      {
        vars: {},
        trigger: {
          channel: "email",
          windowText: "hi",
          url: null,
          from: "a@b.com",
          message_id: "gmail-1",
          connection_id: CONN
        }
      }
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action).toMatchObject({
      kind: "email_organize",
      messageId: "gmail-1",
      connectionId: CONN,
      archive: true
    });
  });

  it("plans with empty message id when tenant email_log_id is present", () => {
    const plan = planStep(
      {
        id: "org1",
        type: "email_organize",
        messageIdTemplate: "{{vars.missing}}",
        markRead: true
      } as FlowStep,
      {
        vars: {},
        trigger: {
          channel: "tenant_email",
          email_log_id: "00000000-0000-4000-8000-000000000099"
        }
      }
    );
    expect(plan.ok).toBe(true);
  });

  it("fails when connected mailbox has no message id", () => {
    const plan = planStep(
      {
        id: "org1",
        type: "email_organize",
        connectionId: CONN,
        messageIdTemplate: "{{vars.missing}}",
        markRead: true
      } as FlowStep,
      { vars: {}, trigger: { channel: "email" } }
    );
    expect(plan).toEqual({
      ok: false,
      error: "email_organize: message id is empty after templating"
    });
  });

  it("fails tenant path when message id and email_log_id are both missing", () => {
    const plan = planStep(
      {
        id: "org1",
        type: "email_organize",
        messageIdTemplate: "{{vars.missing}}",
        markRead: true
      } as FlowStep,
      { vars: {}, trigger: { channel: "tenant_email" } }
    );
    expect(plan.ok).toBe(false);
  });

  it("scrubs connectionId from library copies", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "tenant_email", conditions: [] },
      steps: [
        {
          id: "org1",
          type: "email_organize",
          connectionId: CONN,
          archive: true
        }
      ]
    });
    const scrubbed = scrubDefinition(def) as {
      steps: Array<{ type: string; connectionId?: string }>;
    };
    const step = scrubbed.steps[0];
    expect(step.type).toBe("email_organize");
    expect(step.connectionId).toBeUndefined();
  });

  it("simulates in test mode", () => {
    const action = {
      kind: "email_organize",
      messageId: "m1",
      connectionId: CONN,
      archive: true,
      markRead: true
    } as StepAction;
    expect(simulateTestAction(action, { vars: {} })).toMatchObject({
      simulated: "email_organize",
      messageId: "m1",
      archive: true,
      markRead: true
    });
    expect(
      simulateTestAction(
        { kind: "email_organize", messageId: "m2" } as StepAction,
        { vars: {} }
      )
    ).toMatchObject({
      simulated: "email_organize",
      connectionId: null,
      archive: false,
      markRead: false
    });
  });

  it("plans removeLabels and moveToFolder templates", () => {
    const plan = planStep(
      {
        id: "org1",
        type: "email_organize",
        connectionId: CONN,
        removeLabels: ["{{vars.old}}"],
        moveToFolder: "{{vars.folder}}",
        unarchive: true,
        markUnread: true
      } as FlowStep,
      {
        vars: { old: "Stale", folder: "Inbox" },
        trigger: { message_id: "m9" }
      }
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action).toMatchObject({
      kind: "email_organize",
      connectionId: CONN,
      removeLabels: ["Stale"],
      moveToFolder: "Inbox",
      unarchive: true,
      markUnread: true
    });
  });
});
