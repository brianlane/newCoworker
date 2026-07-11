/**
 * Write-time validation for `share_document` AiFlow steps.
 *
 * The schema (schema.ts) can only check SHAPE — that documentId is a uuid.
 * Whether that document exists, is ingested, is client-audience, and is not
 * already expired requires a DB read, so the flows CRUD routes call this
 * AFTER parseAiFlowDefinition (same layering as the connectionId ownership
 * checks). The runtime engine re-checks at execution; this validator exists
 * so authoring mistakes surface in the builder instead of as failed runs.
 */

import type { AiFlowDefinition, FlowStep } from "./schema";
import { listBusinessDocuments, type BusinessDocumentRow } from "@/lib/documents/db";
import { isDocumentExpired } from "@/lib/documents/core";

export type ShareDocumentStepRef = {
  stepId: string;
  documentId: string;
};

/** Every share_document step in the tree (trunk + branch arms + elses). */
export function collectShareDocumentSteps(def: AiFlowDefinition): ShareDocumentStepRef[] {
  const out: ShareDocumentStepRef[] = [];
  const walk = (steps: FlowStep[]): void => {
    for (const step of steps) {
      if (step.type === "share_document") {
        out.push({ stepId: step.id, documentId: step.documentId });
      } else if (step.type === "branch") {
        for (const arm of step.branches) walk(arm.steps);
        walk(step.else);
      }
    }
  };
  walk(def.steps);
  return out;
}

export type ValidateShareDocumentDeps = {
  /** Injectable documents lookup (tests). */
  fetchDocuments?: (businessId: string) => Promise<BusinessDocumentRow[]>;
  now?: () => Date;
};

/**
 * Human-readable issues for every share_document step whose document is
 * missing, not ready, staff-only, or already expired. Empty array = valid.
 * Flow recipients are customers, so staff-only documents are rejected at
 * write time (the runtime enforces the same rule).
 */
export async function validateShareDocumentSteps(
  businessId: string,
  def: AiFlowDefinition,
  deps: ValidateShareDocumentDeps = {}
): Promise<string[]> {
  const refs = collectShareDocumentSteps(def);
  if (refs.length === 0) return [];
  /* c8 ignore next -- production default; tests inject fetchDocuments */
  const fetchDocuments = deps.fetchDocuments ?? listBusinessDocuments;
  const now = (deps.now ?? (() => new Date()))();
  const docs = await fetchDocuments(businessId);
  const byId = new Map(docs.map((d) => [d.id, d]));

  const issues: string[] = [];
  for (const ref of refs) {
    const doc = byId.get(ref.documentId);
    if (!doc) {
      issues.push(
        `Step "${ref.stepId}" shares a document that is not on file; upload it under Dashboard → Memory → Documents first.`
      );
      continue;
    }
    if (doc.status !== "ready") {
      issues.push(
        `Step "${ref.stepId}" shares "${doc.title}", which is not ready (status: ${doc.status}).`
      );
      continue;
    }
    if (doc.audience === "staff") {
      issues.push(
        `Step "${ref.stepId}" shares "${doc.title}", which is marked internal-only; flows deliver to customers, so switch its audience to clients first.`
      );
      continue;
    }
    if (isDocumentExpired(doc, now)) {
      issues.push(
        `Step "${ref.stepId}" shares "${doc.title}", which has expired; extend or replace it first.`
      );
    }
  }
  return issues;
}
