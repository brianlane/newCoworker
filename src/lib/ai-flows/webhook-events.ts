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
import { recordLeadSubmission } from "@/lib/leads/submissions";
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

type WebhookFlow = {
  id: string;
  /** One condition list per webhook trigger in the flow's set (OR semantics). */
  conditionSets: TriggerCondition[][];
};

/**
 * Enabled flows with a `webhook` trigger anywhere in their trigger set: the
 * primary `trigger` (SQL channel filter) OR the additional `triggers` array
 * (fetched broadly — flows carrying extras are rare — then filtered here).
 * A flow with several webhook triggers matches when ANY of its condition
 * lists does, so each flow appears once with all its lists.
 */
async function loadWebhookFlows(
  db: SupabaseClient,
  businessId: string
): Promise<WebhookFlow[]> {
  const { data, error } = await db
    .from("ai_flows")
    .select("id, definition")
    .eq("business_id", businessId)
    .eq("enabled", true)
    .or("definition->trigger->>channel.eq.webhook,definition->triggers.not.is.null");
  if (error) throw new Error(`loadWebhookFlows: ${error.message}`);
  const out: WebhookFlow[] = [];
  for (const row of (data ?? []) as Array<{ id: string; definition: unknown }>) {
    const def = row.definition as {
      trigger?: { channel?: unknown; conditions?: unknown };
      triggers?: Array<{ channel?: unknown; conditions?: unknown }>;
    } | null;
    const conditionSets: TriggerCondition[][] = [];
    for (const trig of [def?.trigger, ...(def?.triggers ?? [])]) {
      if (trig?.channel !== "webhook") continue;
      const conds = trig.conditions;
      conditionSets.push(Array.isArray(conds) ? (conds as TriggerCondition[]) : []);
    }
    if (conditionSets.length > 0) out.push({ id: row.id, conditionSets });
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

/**
 * How many enabled flows would evaluate a webhook event right now — the
 * lead-backlog import's preview uses this to warn "0 webhook flows enabled,
 * nothing will fire" before the owner commits an upload.
 */
export async function countEnabledWebhookFlows(
  businessId: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  return (await loadWebhookFlows(db, businessId)).length;
}

export type ProcessWebhookFlowEventOptions = {
  /**
   * When set, enqueued runs carry this `earliest_claim_at`, so the worker's
   * claim RPC leaves them queued until the time passes — how the lead-backlog
   * import drips a spreadsheet of events out instead of firing all at once.
   */
  earliestClaimAt?: string;
};

export async function processWebhookFlowEvent(
  businessId: string,
  event: WebhookEventInput,
  client?: SupabaseClient,
  options?: ProcessWebhookFlowEventOptions
): Promise<WebhookFlowEventResult> {
  const db = client ?? (await createSupabaseServiceClient());

  const scope = webhookTriggerScope(event);
  const eventKey = webhookEventKey(event);
  const dedupeKey = `webhook:${eventKey}`;
  // Durable per-lead record for the Tasks Data view + Meta CAPI feedback.
  // Best-effort (never throws) and idempotent per event key.
  await recordLeadSubmission(businessId, {
    source: event.source,
    data: event.data,
    eventKey
  }, db);
  const flows = await loadWebhookFlows(db, businessId);

  let enqueued = 0;
  let matched = 0;
  const enqueuedFlowIds: string[] = [];
  for (const flow of flows) {
    // OR across the flow's webhook triggers: the first condition list that
    // matches fires the flow (one run — the dedupe key is per event).
    let anyMatched = false;
    for (const conditions of flow.conditionSets) {
      // Pre-resolve any from_matches saved-contact refs (fail CLOSED per flow,
      // same policy as the tenant-email path).
      let refValues: Map<string, string[]> | undefined;
      try {
        // Cast: the full supabase-js builder type recurses too deep for TS to
        // check structurally against the resolver's minimal chain type.
        refValues = await resolveFromMatchesRefValues(
          db as unknown as ContactRefSupabase,
          businessId,
          conditions
        );
      } catch (e) {
        console.error("webhook from_matches ref resolution", e);
        refValues = undefined;
      }
      if (evaluateTriggerConditions(conditions, scope.windowText, scope.from, refValues)) {
        anyMatched = true;
        break;
      }
    }
    if (!anyMatched) continue;
    matched += 1;
    const run = await enqueueAiFlowRun(
      {
        businessId,
        flowId: flow.id,
        trigger: scope,
        dedupeKey,
        ...(options?.earliestClaimAt ? { earliestClaimAt: options.earliestClaimAt } : {})
      },
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
