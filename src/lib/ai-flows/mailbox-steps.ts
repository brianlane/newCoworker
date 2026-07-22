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
import { createSupabaseServiceClient } from "@/lib/supabase/server";

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

// ---------------------------------------------------------------------------
// Disconnect-time usage check: which flows reference a workspace connection?
// ---------------------------------------------------------------------------

/**
 * Every workspace-connection reference in a RAW (untyped) definition:
 * send_email `fromConnectionId`, send_sms quiet-hours `emailFromConnectionId`,
 * `email_extract` `connectionId`, and email-trigger `connectionId` (primary
 * trigger + the additional `triggers` array), recursing into branch arms.
 *
 * Deliberately schema-tolerant: stored definitions can predate the current
 * schema, and a disconnect guard that throws on a legacy flow would block the
 * owner from disconnecting anything. Unknown shapes contribute nothing.
 */
export function collectRawWorkspaceConnectionRefs(definition: unknown): string[] {
  const out = new Set<string>();
  const def = (definition ?? {}) as {
    trigger?: { channel?: unknown; connectionId?: unknown };
    triggers?: Array<{ channel?: unknown; connectionId?: unknown }>;
    steps?: unknown[];
  };
  for (const trig of [def.trigger, ...(Array.isArray(def.triggers) ? def.triggers : [])]) {
    if (trig?.channel === "email" && typeof trig.connectionId === "string" && trig.connectionId) {
      out.add(trig.connectionId);
    }
  }
  const walk = (steps: unknown[]): void => {
    for (const raw of steps) {
      if (!raw || typeof raw !== "object") continue;
      const step = raw as {
        type?: unknown;
        fromConnectionId?: unknown;
        connectionId?: unknown;
        quietHours?: { emailFromConnectionId?: unknown };
        branches?: Array<{ steps?: unknown[] }>;
        else?: unknown[];
      };
      if (step.type === "send_email" && typeof step.fromConnectionId === "string" && step.fromConnectionId) {
        out.add(step.fromConnectionId);
      } else if (step.type === "send_sms") {
        const qh = step.quietHours;
        if (qh && typeof qh.emailFromConnectionId === "string" && qh.emailFromConnectionId) {
          out.add(qh.emailFromConnectionId);
        }
      } else if (step.type === "email_extract" && typeof step.connectionId === "string" && step.connectionId) {
        out.add(step.connectionId);
      } else if (step.type === "branch") {
        for (const arm of Array.isArray(step.branches) ? step.branches : []) {
          if (Array.isArray(arm?.steps)) walk(arm.steps);
        }
        if (Array.isArray(step.else)) walk(step.else);
      }
    }
  };
  if (Array.isArray(def.steps)) walk(def.steps);
  return [...out];
}

export type FlowConnectionUsage = { id: string; name: string; enabled: boolean };

/**
 * The business's flows that reference the given workspace connection row id
 * anywhere (sender bindings, email triggers, email_extract). Disabled flows
 * count too — re-enabling one later would break just as silently.
 */
export async function flowsReferencingWorkspaceConnection(
  businessId: string,
  connectionRowId: string,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<FlowConnectionUsage[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("ai_flows")
    .select("id, name, enabled, definition")
    .eq("business_id", businessId);
  if (error) throw new Error(`flowsReferencingWorkspaceConnection: ${error.message}`);
  const rows = (data ?? []) as Array<{
    id: string;
    name: string;
    enabled: boolean;
    definition: unknown;
  }>;
  return rows
    .filter((row) => collectRawWorkspaceConnectionRefs(row.definition).includes(connectionRowId))
    .map((row) => ({ id: row.id, name: row.name, enabled: row.enabled }));
}

/** Owner-facing refusal copy for disconnecting a mailbox flows still use. */
export function connectionInUseMessage(flows: FlowConnectionUsage[]): string {
  const names = flows.map((f) => `"${f.name}"${f.enabled ? "" : " (disabled)"}`).join(", ");
  const plural = flows.length === 1 ? "automation still uses" : "automations still use";
  return (
    `${flows.length} ${plural} this mailbox: ${names}. ` +
    "Update those automations first (change the email step's From mailbox, or the email trigger), then disconnect."
  );
}
