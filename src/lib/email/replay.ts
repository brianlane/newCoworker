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
import { tenantEmailTriggerScope } from "@/lib/ai-flows/trigger-eval";
import { enqueueAiFlowRun } from "@/lib/ai-flows/db";
import { recordSystemLog } from "@/lib/db/system-logs";
import type { StoredAttachment } from "@/lib/db/email-log";
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

/**
 * True when the flow starts from a tenant_email trigger (primary OR one of
 * the extra `triggers`) — the route's gate: replaying AI-mailbox mail into a
 * flow that never reads it would just produce confusing failed runs. Same
 * structural-walk pattern as lead-backlog's flowHasWebhookTrigger.
 */
export function flowHasTenantEmailTrigger(definition: unknown): boolean {
  const def = definition as {
    trigger?: { channel?: unknown };
    triggers?: Array<{ channel?: unknown }>;
  } | null;
  if (def?.trigger?.channel === "tenant_email") return true;
  return (def?.triggers ?? []).some((t) => t?.channel === "tenant_email");
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
 * Replay unmatched inbound AI-mailbox emails through `flowId` as backfill
 * runs. Rows apply independently — one failure never blocks the rest. The
 * caller (API route) has already verified the flow: exists for this
 * business, enabled, and carries a tenant_email trigger.
 */
export async function replayInboundEmails(
  businessId: string,
  flowId: string,
  input: ReplayEmailsInput,
  client?: SupabaseClient
): Promise<ReplayEmailsSummary> {
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
    const trigger = {
      ...tenantEmailTriggerScope({
        id: messageId,
        fromEmail: row.from_email ?? "",
        subject,
        bodyText,
        receivedAt: row.created_at,
        ...(row.to_email ? { toEmail: row.to_email } : {}),
        ...(imageRef ? { imageRef } : {})
      }),
      [BACKFILL_SKIP_EXISTING_TRIGGER_KEY]: "1"
    };
    try {
      const run = await enqueueAiFlowRun(
        { businessId, flowId, trigger, dedupeKey: `email:${messageId}` },
        db
      );
      if (!run) {
        summary.duplicates += 1;
        summary.outcomes.push({ emailLogId: id, status: "duplicate" });
        continue;
      }
      summary.enqueued += 1;
      summary.outcomes.push({ emailLogId: id, status: "enqueued", runId: run.id });
      // Stamp the run back onto the mail so the Emails page shows it as
      // handled (and it stops qualifying for future replays). Best-effort:
      // the run is already queued, so a stamp failure only logs.
      const { error: stampErr } = await db
        .from("email_log")
        .update({ flow_id: flowId, run_id: run.id })
        .eq("business_id", businessId)
        .eq("id", id);
      if (stampErr) console.error("replayInboundEmails stamp", stampErr.message);
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
