/**
 * Inbound tenant-mailbox processing.
 *
 * The Cloudflare Email Worker catches mail to `<tenant>@<platform domain>` and
 * POSTs it to /api/email/inbound, which calls `processInboundTenantEmail`.
 * Here we:
 *   1. resolve the recipient address back to a business,
 *   2. record the inbound mail on the dashboard Emails page,
 *   3. enqueue an ai_flow_run for every ENABLED `tenant_email` flow whose
 *      conditions match (exactly-once via dedupe_key `email:<messageId>`).
 *
 * Unknown recipients are accepted-and-ignored (the route returns 200) so we
 * never generate backscatter for mis-addressed mail.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { resolveBusinessByAddress } from "@/lib/email/tenant-mailbox";
import {
  evaluateTriggerConditions,
  tenantEmailTriggerScope
} from "@/lib/ai-flows/trigger-eval";
import { enqueueAiFlowRun } from "@/lib/ai-flows/db";
import { recordTenantMailboxInbound } from "@/lib/db/email-log";
import { recordSystemLog } from "@/lib/db/system-logs";
import type { TriggerCondition } from "@/lib/ai-flows/schema";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type InboundEmailPayload = {
  /** Recipient address the mail was sent to (the tenant mailbox). */
  to: string;
  /** Raw From header value (display name or bare address). */
  from: string;
  subject: string;
  /** Plain-text body (the worker collapses HTML before posting). */
  text: string;
  /** Provider/RFC Message-Id — drives the run dedupe key. */
  messageId: string;
};

export type InboundEmailResult =
  | { matched: false }
  | { matched: true; businessId: string; enqueued: number };

/** "Display Name <user@host>" → "user@host" (bare addresses pass through). */
function bareEmail(raw: string): string {
  const m = /<([^<>]+)>/.exec(raw);
  return (m ? m[1] : raw).trim();
}

type TenantEmailFlow = { id: string; conditions: TriggerCondition[] };

/** Enabled tenant_email flows for a business (paged so none is skipped). */
async function loadTenantEmailFlows(
  db: SupabaseClient,
  businessId: string
): Promise<TenantEmailFlow[]> {
  const { data, error } = await db
    .from("ai_flows")
    .select("id, definition")
    .eq("business_id", businessId)
    .eq("enabled", true)
    .eq("definition->trigger->>channel", "tenant_email");
  if (error) throw new Error(`loadTenantEmailFlows: ${error.message}`);
  const out: TenantEmailFlow[] = [];
  for (const row of (data ?? []) as Array<{ id: string; definition: unknown }>) {
    const def = row.definition as { trigger?: { conditions?: unknown } } | null;
    const conds = def?.trigger?.conditions;
    out.push({ id: row.id, conditions: Array.isArray(conds) ? (conds as TriggerCondition[]) : [] });
  }
  return out;
}

export async function processInboundTenantEmail(
  payload: InboundEmailPayload,
  client?: SupabaseClient
): Promise<InboundEmailResult> {
  const db = client ?? (await createSupabaseServiceClient());
  const businessId = await resolveBusinessByAddress(payload.to, db);
  if (!businessId) return { matched: false };

  const fromEmail = bareEmail(payload.from);
  const scope = tenantEmailTriggerScope({
    id: payload.messageId,
    fromEmail,
    subject: payload.subject,
    bodyText: payload.text,
    toEmail: payload.to
  });

  const flows = await loadTenantEmailFlows(db, businessId);

  let enqueued = 0;
  let firstFlowId: string | null = null;
  let firstRunId: string | null = null;
  for (const flow of flows) {
    if (!evaluateTriggerConditions(flow.conditions, scope.windowText, scope.from)) continue;
    const run = await enqueueAiFlowRun(
      { businessId, flowId: flow.id, trigger: scope, dedupeKey: `email:${payload.messageId}` },
      db
    );
    if (!run) continue; // already enqueued by an earlier delivery/retry
    enqueued += 1;
    if (!firstFlowId) {
      firstFlowId = flow.id;
      firstRunId = run.id;
    }
    await recordSystemLog({
      businessId,
      source: "aiflow",
      level: "info",
      event: "ai_flow_run_enqueued_tenant_email",
      message: `Inbound mail to the AI mailbox from ${scope.from} triggered a run`,
      payload: { flow_id: flow.id, message_id: payload.messageId, subject: scope.subject }
    });
  }

  // Always surface the inbound mail on the Emails page, even when nothing
  // matched — the owner should see what their AI mailbox received.
  await recordTenantMailboxInbound(
    {
      businessId,
      toEmail: payload.to,
      fromEmail,
      subject: payload.subject,
      bodyText: payload.text,
      flowId: firstFlowId,
      runId: firstRunId,
      providerMessageId: payload.messageId
    },
    db
  );

  return { matched: true, businessId, enqueued };
}
