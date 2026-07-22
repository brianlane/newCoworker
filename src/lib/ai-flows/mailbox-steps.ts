/**
 * Write-time validation for mailbox bindings in AiFlow steps —
 * `send_email.fromConnectionId` and the send_sms quiet-hours email fallback's
 * `emailFromConnectionId`.
 *
 * The schema (schema.ts) can only check SHAPE — that the id is a uuid.
 * Whether that connection exists for THIS business and is an email provider
 * requires a DB read, so the flows CRUD routes, the MCP tools, and the
 * compile pipeline call this AFTER parseAiFlowDefinition (same layering as
 * the share_document / run_agent checks). The runtime re-checks at send time
 * (`connection_not_found` / `not_email_connection`); this validator exists so
 * a stale or wrong mailbox id surfaces in the builder instead of as a failed
 * run that pages the owner mid-cadence (the KYP Ads incident of Jul 22 2026).
 */

import type { AiFlowDefinition, FlowStep } from "./schema";
import {
  listWorkspaceOAuthConnections,
  type WorkspaceOAuthConnectionRow
} from "@/lib/db/workspace-oauth-connections";
import { isEmailProviderConfigKey } from "@/lib/voice-tools/connections";

export type MailboxConnectionRef = {
  stepId: string;
  connectionId: string;
  /** Which field carried the binding (both resolve through the same send path). */
  use: "send_email" | "quiet_hours_email";
};

/** Every mailbox-bound step in the tree (trunk + branch arms + elses). */
export function collectMailboxConnectionRefs(def: AiFlowDefinition): MailboxConnectionRef[] {
  const out: MailboxConnectionRef[] = [];
  const walk = (steps: FlowStep[]): void => {
    for (const step of steps) {
      if (step.type === "send_email" && step.fromConnectionId) {
        out.push({ stepId: step.id, connectionId: step.fromConnectionId, use: "send_email" });
      } else if (step.type === "send_sms" && step.quietHours?.emailFromConnectionId) {
        out.push({
          stepId: step.id,
          connectionId: step.quietHours.emailFromConnectionId,
          use: "quiet_hours_email"
        });
      } else if (step.type === "branch") {
        for (const arm of step.branches) walk(arm.steps);
        walk(step.else);
      }
    }
  };
  walk(def.steps);
  return out;
}

export type ValidateMailboxConnectionDeps = {
  /** Injectable connections lookup (tests). */
  fetchConnections?: (businessId: string) => Promise<WorkspaceOAuthConnectionRow[]>;
};

/**
 * Human-readable issues for every mailbox binding that doesn't resolve to an
 * email connection of this business. Empty array = valid.
 */
export async function validateMailboxConnectionSteps(
  businessId: string,
  def: AiFlowDefinition,
  deps: ValidateMailboxConnectionDeps = {}
): Promise<string[]> {
  const refs = collectMailboxConnectionRefs(def);
  if (refs.length === 0) return [];
  /* c8 ignore next -- production default; tests inject fetchConnections */
  const fetchConnections = deps.fetchConnections ?? listWorkspaceOAuthConnections;
  const connections = await fetchConnections(businessId);
  const byId = new Map(connections.map((c) => [c.id, c]));

  const issues: string[] = [];
  for (const ref of refs) {
    const conn = byId.get(ref.connectionId);
    if (!conn) {
      issues.push(
        `Step "${ref.stepId}" sends email from a mailbox that is no longer connected — pick a connected mailbox in the step's From field (or leave it as your AI coworker's email), reconnecting under Settings → Integrations if needed.`
      );
      continue;
    }
    if (!isEmailProviderConfigKey(conn.provider_config_key)) {
      issues.push(
        `Step "${ref.stepId}" sends email from the "${conn.provider_config_key}" connection, which is not an email mailbox — pick a connected Gmail/Outlook mailbox instead.`
      );
    }
  }
  return issues;
}
