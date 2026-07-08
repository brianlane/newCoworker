/**
 * Inbound public-API flow events (the `webhook` trigger channel).
 *
 * POST /api/public/v1/flow-events authenticates a tenant's `nck_` API key and
 * calls `processWebhookFlowEvent`. Here we:
 *   1. flatten the event payload into windowText (webhookTriggerScope),
 *   2. enqueue an ai_flow_run for every ENABLED `webhook` flow whose
 *      conditions match (exactly-once via dedupe_key `webhook:<eventKey>`),
 *   3. record a `webhook_event_received` system log even when nothing matched,
 *      so the dashboard How-To guide can show "your test lead arrived".
 *
 * Mirrors processInboundTenantEmail (src/lib/email/inbound.ts) — the other
 * push-based enqueue path — deliberately, minus the mailbox-specific parts.
 */
import { createHash } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  evaluateTriggerConditions,
  webhookTriggerScope,
  type WebhookEventInput
} from "@/lib/ai-flows/trigger-eval";
import { enqueueAiFlowRun } from "@/lib/ai-flows/db";
import { recordSystemLog } from "@/lib/db/system-logs";
import type { TriggerCondition } from "@/lib/ai-flows/schema";
import {
  resolveFromMatchesRefValues,
  type ContactRefSupabase
} from "../../../supabase/functions/_shared/ai_flows/contact_ref";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type WebhookFlowEventResult = {
  /** Runs actually enqueued this delivery (0 on duplicate redelivery). */
  enqueued: number;
  /** Enabled webhook flows evaluated (helps a Zap author see "0 flows"). */
  flowsEvaluated: number;
  /**
   * Flows whose conditions matched this event, whether or not a run was
   * enqueued. matched > 0 with enqueued === 0 means a duplicate redelivery
   * (the first delivery already ran) — NOT a broken setup, so the guide's
   * readout must not report "no flow matched".
   */
  flowsMatched: number;
};

type WebhookFlow = { id: string; conditions: TriggerCondition[] };

/** Enabled `webhook` flows for a business. */
async function loadWebhookFlows(
  db: SupabaseClient,
  businessId: string
): Promise<WebhookFlow[]> {
  const { data, error } = await db
    .from("ai_flows")
    .select("id, definition")
    .eq("business_id", businessId)
    .eq("enabled", true)
    .eq("definition->trigger->>channel", "webhook");
  if (error) throw new Error(`loadWebhookFlows: ${error.message}`);
  const out: WebhookFlow[] = [];
  for (const row of (data ?? []) as Array<{ id: string; definition: unknown }>) {
    const def = row.definition as { trigger?: { conditions?: unknown } } | null;
    const conds = def?.trigger?.conditions;
    out.push({ id: row.id, conditions: Array.isArray(conds) ? (conds as TriggerCondition[]) : [] });
  }
  return out;
}

/**
 * The event's idempotency key: the caller-supplied `event_id` when present
 * (e.g. the Meta leadgen id a bridge forwards), else a payload digest so an
 * exact redelivery (bridge retry) never double-enqueues.
 */
export function webhookEventKey(event: WebhookEventInput): string {
  if (event.eventId && event.eventId.trim()) return event.eventId.trim().slice(0, 180);
  return createHash("sha256")
    .update(`${event.source}\n${JSON.stringify(event.data)}`)
    .digest("hex");
}

export async function processWebhookFlowEvent(
  businessId: string,
  event: WebhookEventInput,
  client?: SupabaseClient
): Promise<WebhookFlowEventResult> {
  const db = client ?? (await createSupabaseServiceClient());

  const scope = webhookTriggerScope(event);
  const dedupeKey = `webhook:${webhookEventKey(event)}`;
  const flows = await loadWebhookFlows(db, businessId);

  let enqueued = 0;
  let matched = 0;
  const enqueuedFlowIds: string[] = [];
  for (const flow of flows) {
    // Pre-resolve any from_matches saved-contact refs (fail CLOSED per flow,
    // same policy as the tenant-email path).
    let refValues: Map<string, string[]> | undefined;
    try {
      // Cast: the full supabase-js builder type recurses too deep for TS to
      // check structurally against the resolver's minimal chain type.
      refValues = await resolveFromMatchesRefValues(
        db as unknown as ContactRefSupabase,
        businessId,
        flow.conditions
      );
    } catch (e) {
      console.error("webhook from_matches ref resolution", e);
      refValues = undefined;
    }
    if (!evaluateTriggerConditions(flow.conditions, scope.windowText, scope.from, refValues))
      continue;
    matched += 1;
    const run = await enqueueAiFlowRun(
      { businessId, flowId: flow.id, trigger: scope, dedupeKey },
      db
    );
    if (!run) continue; // already enqueued by an earlier delivery/retry
    enqueued += 1;
    enqueuedFlowIds.push(flow.id);
    await recordSystemLog(
      {
        businessId,
        source: "aiflow",
        level: "info",
        event: "ai_flow_run_enqueued_webhook",
        message: `Webhook event from ${scope.from} triggered a run`,
        payload: { flow_id: flow.id, event_key: dedupeKey }
      },
      db
    );
  }

  // Always log the delivery — the guide page's "recent events" readout shows
  // the owner their test lead arrived even before any flow is enabled.
  await recordSystemLog(
    {
      businessId,
      source: "aiflow",
      level: "info",
      event: "webhook_event_received",
      message: `Webhook event received from ${scope.from}`,
      payload: {
        source_label: scope.from,
        event_key: dedupeKey,
        flows_evaluated: flows.length,
        flows_matched: matched,
        runs_enqueued: enqueued,
        flow_ids: enqueuedFlowIds,
        // First lines only: enough for the owner to recognize the test lead,
        // small enough to keep log rows lean.
        preview: scope.windowText.slice(0, 500)
      }
    },
    db
  );

  return { enqueued, flowsEvaluated: flows.length, flowsMatched: matched };
}
