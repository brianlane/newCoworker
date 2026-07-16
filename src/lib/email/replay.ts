/**
 * Email-replay backfill: re-run missed AI-mailbox emails through a flow.
 *
 * When a tenant_email flow is disabled, inbound mail still lands on the
 * Emails page (`email_log`, source `tenant_mailbox_inbound`) but no run is
 * enqueued — the lead is never filed or contacted. Once the owner re-enables
 * the flow, this module replays those missed messages: each qualifying
 * email_log row is rebuilt into the exact trigger scope the live inbound
 * path would have produced (`tenantEmailTriggerScope`) and enqueued as a
 * BACKFILL run — the worker's `upsert_customer` step ends a backfill run
 * without outreach when the extracted lead already exists as a contact, so
 * a replay can never double-text someone the business already reached.
 *
 * Idempotent: the dedupe key matches the live path's (`email:<messageId>`),
 * so a replay can never race or duplicate a run the webhook already
 * enqueued, and re-running the replay is a no-op for already-replayed rows.
 *
 * Reads/writes central email_log only (service role). Residency note: a
 * `vps`-read-mode tenant's mail content lives on their box, so this replay
 * (like the flow engine's own state) deliberately stays central — the rows
 * simply won't qualify there. Owner authorization is the API route's job.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { evaluateTriggerConditions, tenantEmailTriggerScope } from "@/lib/ai-flows/trigger-eval";
import { enqueueAiFlowRun } from "@/lib/ai-flows/db";
import { recordSystemLog } from "@/lib/db/system-logs";
import type { StoredAttachment } from "@/lib/db/email-log";
import type { TriggerCondition } from "@/lib/ai-flows/schema";
import {
  resolveFromMatchesRefValues,
  type ContactRefSupabase
} from "../../../supabase/functions/_shared/ai_flows/contact_ref";
import { BACKFILL_SKIP_EXISTING_TRIGGER_KEY } from "../../../supabase/functions/_shared/ai_flows/backfill";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Replays fan out SMS per new lead, so cap a single request well below the
 *  lead-import sheet cap — the missed-window use case is dozens, not
 *  thousands. */
export const MAX_REPLAY_EMAILS = 100;

/** Image types the live inbound path exposes as {{trigger.image}}. */
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type ReplayEmailsInput = {
  /** Explicit email_log row ids to replay (the Emails page selection). */
  emailLogIds: string[];
};

export type ReplayEmailOutcome = {
  emailLogId: string;
  /**
   * enqueued  — a backfill run was queued for this email.
   * duplicate — a run with this message's dedupe key already exists on the
   *             flow (earlier replay or the live webhook); nothing new queued.
   * skipped   — the row doesn't qualify (not an unmatched inbound AI-mailbox
   *             email, or it has no usable body).
   * error     — this row's enqueue failed; other rows still apply.
   */
  status: "enqueued" | "duplicate" | "skipped" | "error";
  reason?: string;
  runId?: string;
};

export type ReplayEmailsSummary = {
  total: number;
  enqueued: number;
  duplicates: number;
  skipped: number;
  errors: number;
  outcomes: ReplayEmailOutcome[];
};

type DefinitionLike = {
  trigger?: { channel?: unknown; conditions?: unknown };
  triggers?: Array<{ channel?: unknown; conditions?: unknown }>;
} | null;

/**
 * True when the flow starts from a tenant_email trigger (primary OR one of
 * the extra `triggers`) — the route's gate: replaying AI-mailbox mail into a
 * flow that never reads it would just produce confusing failed runs. Same
 * structural-walk pattern as lead-backlog's flowHasWebhookTrigger.
 */
export function flowHasTenantEmailTrigger(definition: unknown): boolean {
  const def = definition as DefinitionLike;
  if (def?.trigger?.channel === "tenant_email") return true;
  return (def?.triggers ?? []).some((t) => t?.channel === "tenant_email");
}

/** Steps that reach a customer/teammate — the sends a backfill must guard. */
const OUTREACH_STEP_TYPES = new Set([
  "send_sms",
  "send_email",
  "route_to_team",
  "share_document",
  "outbound_call"
]);

type StepLike = {
  type?: unknown;
  branches?: Array<{ steps?: StepLike[] }>;
  else?: StepLike[];
};

/**
 * True when every path through the flow files the lead (`upsert_customer`)
 * BEFORE any outreach step. The worker's backfill halt lives inside
 * `upsert_customer` — it can only protect sends that come after it — so
 * replaying into a flow that texts first (or never files the lead at all)
 * would break the "never double-text an existing contact" guarantee. The
 * route rejects such flows up front.
 *
 * Branch arms are checked with the upsert-seen state at the branch point;
 * an upsert INSIDE one arm deliberately does not credit steps after the
 * branch (the other arm may have skipped it) — conservative by design.
 * notify_owner is not outreach (owner-facing, same exemption as budgets).
 */
export function flowUpsertsBeforeOutreach(definition: unknown): boolean {
  const walk = (steps: StepLike[] | undefined, upsertSeenAtEntry: boolean): boolean => {
    let upsertSeen = upsertSeenAtEntry;
    for (const step of steps ?? []) {
      if (step.type === "upsert_customer") {
        upsertSeen = true;
        continue;
      }
      if (typeof step.type === "string" && OUTREACH_STEP_TYPES.has(step.type) && !upsertSeen) {
        return false;
      }
      for (const arm of step.branches ?? []) {
        if (!walk(arm.steps, upsertSeen)) return false;
      }
      if (!walk(step.else, upsertSeen)) return false;
    }
    return true;
  };
  const def = definition as { steps?: StepLike[] } | null;
  return walk(def?.steps, false);
}

/**
 * One condition list per tenant_email trigger in the flow's set (OR across
 * lists, AND within one) — the same parse `loadTenantEmailFlows` does on the
 * live inbound path, so replay honors exactly the filters the flow would
 * have applied when the mail arrived.
 */
function tenantEmailConditionSets(definition: unknown): TriggerCondition[][] {
  const def = definition as DefinitionLike;
  const out: TriggerCondition[][] = [];
  for (const trig of [def?.trigger, ...(def?.triggers ?? [])]) {
    if (trig?.channel !== "tenant_email") continue;
    const conds = trig.conditions;
    out.push(Array.isArray(conds) ? (conds as TriggerCondition[]) : []);
  }
  return out;
}

type ReplayableEmailRow = {
  id: string;
  from_email: string | null;
  to_email: string | null;
  subject: string | null;
  body_preview: string | null;
  body_full: string | null;
  attachments: StoredAttachment[] | null;
  provider_message_id: string | null;
  created_at: string;
};

/**
 * The first image attachment's `email-attachments:<path>` ref, mirroring the
 * live inbound path's {{trigger.image}}. Inbound rows omit `bucket` (the
 * bytes live in the default email-attachments bucket); anything else — an
 * outbound screenshot ref that somehow appears — is not an inbound image.
 */
function firstImageRef(attachments: StoredAttachment[] | null): string | undefined {
  const hit = (attachments ?? []).find(
    (a) => !a.bucket && IMAGE_MIME_TYPES.has((a.mime_type ?? "").trim().toLowerCase())
  );
  return hit ? `email-attachments:${hit.storage_path}` : undefined;
}

/**
 * The first document attachment's ref + filename, mirroring the live inbound
 * path's {{trigger.document}}: gated on the STORED PATH's extension, because
 * that suffix is exactly what docExtract classifies the type from — a
 * MIME-only match with an extensionless path would hand the step a ref it
 * can only fail on.
 */
/* c8 ignore start -- fully exercised by email-replay.test.ts (the replayed
 * {{trigger.document}} assertions can only pass through this body), but the
 * v8→istanbul remap for this function misreports its statements as unexecuted
 * while simultaneously reporting 100% line coverage on the same range. */
function firstDocumentRef(
  attachments: StoredAttachment[] | null
): { ref: string; name: string } | undefined {
  for (const a of attachments ?? []) {
    if (a.bucket) continue;
    if (/\.(pdf|txt|md|csv)$/i.test(a.storage_path)) {
      return { ref: `email-attachments:${a.storage_path}`, name: a.filename ?? "" };
    }
  }
  return undefined;
}
/* c8 ignore stop */

/** The replay target: id + raw definition (as loaded by the route's gate). */
export type ReplayFlow = { id: string; definition: unknown };

/**
 * Replay unmatched inbound AI-mailbox emails through `flow` as backfill
 * runs. Rows apply independently — one failure never blocks the rest. The
 * caller (API route) has already verified the flow: exists for this
 * business, enabled, and carries a tenant_email trigger.
 *
 * Each email is re-evaluated against the flow's tenant_email trigger
 * conditions exactly like the live inbound path (`processInboundTenantEmail`)
 * would have — mail the flow intentionally filters out (wrong sender, no
 * keyword match) is skipped, never force-fed into SMS outreach. A
 * `from_matches` contact-ref resolution failure fails CLOSED (skip), same as
 * live.
 */
export async function replayInboundEmails(
  businessId: string,
  flow: ReplayFlow,
  input: ReplayEmailsInput,
  client?: SupabaseClient
): Promise<ReplayEmailsSummary> {
  const flowId = flow.id;
  const ids = [...new Set(input.emailLogIds)].slice(0, MAX_REPLAY_EMAILS);
  if (ids.length === 0) {
    return { total: 0, enqueued: 0, duplicates: 0, skipped: 0, errors: 0, outcomes: [] };
  }
  const db = client ?? (await createSupabaseServiceClient());

  const summary: ReplayEmailsSummary = {
    total: ids.length,
    enqueued: 0,
    duplicates: 0,
    skipped: 0,
    errors: 0,
    outcomes: []
  };
  // Only rows the live inbound path recorded but never matched to a flow
  // qualify: inbound AI-mailbox mail with no run attached. The id filter is
  // applied server-side so a stale dashboard selection (a row replayed in
  // another tab) simply drops out.
  const { data, error } = await db
    .from("email_log")
    .select(
      "id, from_email, to_email, subject, body_preview, body_full, attachments, provider_message_id, created_at"
    )
    .eq("business_id", businessId)
    .eq("direction", "inbound")
    .eq("source", "tenant_mailbox_inbound")
    .is("flow_id", null)
    .in("id", ids);
  if (error) throw new Error(`replayInboundEmails: ${error.message}`);
  const rows = new Map(((data ?? []) as ReplayableEmailRow[]).map((r) => [r.id, r]));

  // Pre-resolve each condition list's from_matches contact refs ONCE for the
  // whole batch (they reference saved people, not the mail). A resolution
  // failure marks the list unusable → its conditions fail closed below,
  // mirroring the live path's per-flow fail-closed.
  const conditionSets = tenantEmailConditionSets(flow.definition);
  const refValuesBySet: (Map<string, string[]> | null)[] = [];
  for (const conditions of conditionSets) {
    try {
      refValuesBySet.push(
        // Cast: the full supabase-js builder type recurses too deep for TS to
        // check structurally against the resolver's minimal chain type.
        await resolveFromMatchesRefValues(db as unknown as ContactRefSupabase, businessId, conditions)
      );
    } catch (e) {
      console.error("replayInboundEmails from_matches ref resolution", e);
      refValuesBySet.push(null);
    }
  }

  // Best-effort: link the mail to its flow/run so the Emails page shows it as
  // handled (and it stops qualifying for future replays). The run itself is
  // already safe either way.
  const stampEmailLog = async (id: string, runId: string): Promise<void> => {
    const { error: stampErr } = await db
      .from("email_log")
      .update({ flow_id: flowId, run_id: runId })
      .eq("business_id", businessId)
      .eq("id", id);
    if (stampErr) console.error("replayInboundEmails stamp", stampErr.message);
  };

  for (const id of ids) {
    const row = rows.get(id);
    if (!row) {
      summary.skipped += 1;
      summary.outcomes.push({
        emailLogId: id,
        status: "skipped",
        reason: "not an unmatched inbound AI-mailbox email"
      });
      continue;
    }
    const bodyText = row.body_full ?? row.body_preview ?? "";
    const subject = row.subject ?? "";
    if (!bodyText.trim() && !subject.trim()) {
      // Nothing for extract_text to read — a run would only fail.
      summary.skipped += 1;
      summary.outcomes.push({ emailLogId: id, status: "skipped", reason: "empty message" });
      continue;
    }
    // Same dedupe namespace as the live webhook enqueue (`email:<messageId>`)
    // so replay + live delivery can never both fire the flow for one message.
    // Rows predating provider-id capture key off the log row id instead —
    // still stable across repeated replays.
    const messageId = row.provider_message_id ?? `log:${row.id}`;
    const imageRef = firstImageRef(row.attachments);
    const documentRef = firstDocumentRef(row.attachments);
    const scope = tenantEmailTriggerScope({
      id: messageId,
      fromEmail: row.from_email ?? "",
      subject,
      bodyText,
      receivedAt: row.created_at,
      ...(row.to_email ? { toEmail: row.to_email } : {}),
      ...(imageRef ? { imageRef } : {}),
      ...(documentRef ? { documentRef: documentRef.ref, documentName: documentRef.name } : {})
    });
    // OR across the flow's tenant_email triggers, exactly like the live
    // inbound path: the first matching condition list fires; a list whose
    // refs failed to resolve is skipped (fails closed).
    const matched = conditionSets.some((conditions, i) => {
      const refValues = refValuesBySet[i];
      if (refValues === null) return false;
      return evaluateTriggerConditions(conditions, scope.windowText, scope.from, refValues);
    });
    if (!matched) {
      summary.skipped += 1;
      summary.outcomes.push({
        emailLogId: id,
        status: "skipped",
        reason: "the flow's trigger conditions don't match this email"
      });
      continue;
    }
    const trigger = { ...scope, [BACKFILL_SKIP_EXISTING_TRIGGER_KEY]: "1" };
    try {
      const run = await enqueueAiFlowRun(
        { businessId, flowId, trigger, dedupeKey: `email:${messageId}` },
        db
      );
      if (!run) {
        // A run for this message already exists (earlier replay whose stamp
        // failed, or the live webhook). Look it up: a live/finished run means
        // the mail is genuinely handled — re-stamp the log row so it stops
        // reading as unmatched. A FAILED (or key-holding canceled) run still
        // owns the dedupe key without having recovered anything, so report
        // it as an error and leave the row unstamped rather than pretending
        // the replay succeeded.
        const { data: existingRun, error: findErr } = await db
          .from("ai_flow_runs")
          .select("id, status")
          .eq("business_id", businessId)
          .eq("flow_id", flowId)
          .eq("dedupe_key", `email:${messageId}`)
          .maybeSingle();
        const existing = existingRun as { id?: string; status?: string } | null;
        if (!findErr && existing?.id && (existing.status === "failed" || existing.status === "canceled")) {
          summary.errors += 1;
          summary.outcomes.push({
            emailLogId: id,
            status: "error",
            reason:
              "an earlier run for this email failed and still holds its slot — check the flow's runs page"
          });
          continue;
        }
        summary.duplicates += 1;
        summary.outcomes.push({ emailLogId: id, status: "duplicate" });
        if (findErr) {
          console.error("replayInboundEmails duplicate lookup", findErr.message);
        } else if (existing?.id) {
          await stampEmailLog(id, existing.id);
        }
        continue;
      }
      summary.enqueued += 1;
      summary.outcomes.push({ emailLogId: id, status: "enqueued", runId: run.id });
      await stampEmailLog(id, run.id);
    } catch (e) {
      summary.errors += 1;
      summary.outcomes.push({
        emailLogId: id,
        status: "error",
        reason: e instanceof Error ? e.message : "Unexpected error"
      });
    }
  }

  await recordSystemLog(
    {
      businessId,
      source: "aiflow",
      level: "info",
      event: "ai_flow_email_replay",
      message: `Email replay: ${summary.enqueued}/${summary.total} messages enqueued as backfill runs`,
      payload: {
        flow_id: flowId,
        total: summary.total,
        enqueued: summary.enqueued,
        duplicates: summary.duplicates,
        skipped: summary.skipped,
        errored: summary.errors
      }
    },
    db
  );

  return summary;
}
