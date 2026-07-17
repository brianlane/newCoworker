/**
 * Write-time validation for share_document AiFlow steps
 * (src/lib/ai-flows/document-steps.ts): tree-wide collection (branch arms
 * included) and the exist/ready/audience/expiry checks against the
 * business's documents.
 */
import { describe, expect, it } from "vitest";
import {
  collectShareDocumentSteps,
  validateShareDocumentSteps
} from "@/lib/ai-flows/document-steps";
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";
import type { BusinessDocumentRow } from "@/lib/documents/db";

const BIZ = "11111111-1111-4111-8111-111111111111";
const DOC_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-07-11T12:00:00Z");

function doc(overrides: Partial<BusinessDocumentRow> = {}): BusinessDocumentRow {
  return {
    id: DOC_ID,
    business_id: BIZ,
    title: "Price sheet",
    category: "pricing",
    audience: "both",
    storage_path: "p",
    mime_type: "application/pdf",
    byte_size: 10,
    content_md: "c",
    summary: "s",
    status: "ready",
    error_detail: null,
    expires_at: null,
    expiring_soon_notified_at: null,
    expired_notified_at: null,
    contact_id: null,
    renewal_date: null,
    assigned_employee_id: null,
    renewal_due_notified_at: null,
    renewal_final_notified_at: null,
    renewal_overdue_notified_at: null,
    renewal_outreach_enqueued_at: null,
    record_fields: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

function defWithShare(documentId: string): AiFlowDefinition {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [
      { id: "s1", type: "share_document", documentId, to: "{{trigger.from}}" }
    ]
  } as AiFlowDefinition;
}

describe("collectShareDocumentSteps", () => {
  it("walks trunk, branch arms, and else paths", () => {
    const def = {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        { id: "t1", type: "extract_text", fields: [{ name: "x" }] },
        { id: "t2", type: "share_document", documentId: "d-1", to: "{{trigger.from}}" },
        {
          id: "b1",
          type: "branch",
          question: "?",
          branches: [
            {
              id: "arm1",
              label: "A",
              condition: { var: "x", equals: "y" },
              steps: [{ id: "a1", type: "share_document", documentId: "d-2", to: "{{trigger.from}}" }]
            }
          ],
          else: [{ id: "e1", type: "share_document", documentId: "d-3", to: "{{trigger.from}}" }]
        }
      ]
    } as unknown as AiFlowDefinition;
    expect(collectShareDocumentSteps(def)).toEqual([
      { stepId: "t2", documentId: "d-1" },
      { stepId: "a1", documentId: "d-2" },
      { stepId: "e1", documentId: "d-3" }
    ]);
  });
});

describe("validateShareDocumentSteps", () => {
  it("skips the DB read entirely when the flow has no share steps", async () => {
    const def = {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [{ id: "s1", type: "notify_owner", message: "hi" }]
    } as unknown as AiFlowDefinition;
    const fetchDocuments = async () => {
      throw new Error("must not be called");
    };
    expect(await validateShareDocumentSteps(BIZ, def, { fetchDocuments })).toEqual([]);
  });

  it("flags a document that is not on file", async () => {
    const issues = await validateShareDocumentSteps(BIZ, defWithShare("99999999-9999-4999-8999-999999999999"), {
      fetchDocuments: async () => [doc()],
      now: () => NOW
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("not on file");
  });

  it("flags a document that is not ready", async () => {
    const issues = await validateShareDocumentSteps(BIZ, defWithShare(DOC_ID), {
      fetchDocuments: async () => [doc({ status: "processing" })],
      now: () => NOW
    });
    expect(issues[0]).toContain("not ready");
  });

  it("flags a staff-only document (flow recipients are customers)", async () => {
    const issues = await validateShareDocumentSteps(BIZ, defWithShare(DOC_ID), {
      fetchDocuments: async () => [doc({ audience: "staff" })],
      now: () => NOW
    });
    expect(issues[0]).toContain("internal-only");
  });

  it("flags an already-expired document", async () => {
    const issues = await validateShareDocumentSteps(BIZ, defWithShare(DOC_ID), {
      fetchDocuments: async () => [doc({ expires_at: "2026-01-01T00:00:00Z" })],
      now: () => NOW
    });
    expect(issues[0]).toContain("expired");
  });

  it("passes a healthy client-facing document (default clock)", async () => {
    const issues = await validateShareDocumentSteps(BIZ, defWithShare(DOC_ID), {
      fetchDocuments: async () => [doc()]
    });
    expect(issues).toEqual([]);
  });
});
