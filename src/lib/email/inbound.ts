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
import { linkTenantMailboxInboundRun, recordTenantMailboxInbound } from "@/lib/db/email-log";
import { recordSystemLog } from "@/lib/db/system-logs";
import { extractConversationGraph } from "@/lib/memory/graph-conversational";
import {
  findCustomerByEmail,
  recordInteractionAndIncrement
} from "@/lib/customer-memory/db";
import type { TriggerCondition } from "@/lib/ai-flows/schema";
import {
  resolveFromMatchesRefValues,
  type ContactRefSupabase
} from "../../../supabase/functions/_shared/ai_flows/contact_ref";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

const EMAIL_ATTACHMENTS_BUCKET = "email-attachments";

/**
 * The object-key namespace the Cloudflare worker uploads this message's
 * attachments under. We only ever persist/delete paths inside this prefix so a
 * caller with the inbound secret can't bind an unrelated message's storage key
 * (which the dashboard would otherwise resolve to a signed download URL). Must
 * mirror the worker's path scheme exactly.
 */
function attachmentPrefix(messageId: string): string {
  const safeMsg = messageId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return `inbound/${safeMsg}/`;
}

export type InboundEmailPayload = {
  /** Recipient address the mail was sent to (the tenant mailbox). */
  to: string;
  /** Raw From header value (display name or bare address). */
  from: string;
  subject: string;
  /** Plain-text body (the worker collapses HTML before posting). */
  text: string;
  /** Raw HTML alternative, when the message had one (sanitized at display). */
  html?: string;
  /** Provider/RFC Message-Id — drives the run dedupe key. */
  messageId: string;
  /**
   * Attachments the worker already uploaded to the email-attachments bucket.
   * `path` is the object key; `size` is bytes. Absent when the mail had none.
   */
  attachments?: { filename: string; mimeType: string; size: number; path: string }[];
};

export type InboundEmailResult =
  | { matched: false }
  | { matched: true; businessId: string; enqueued: number };

/** "Display Name <user@host>" → "user@host" (bare addresses pass through). */
function bareEmail(raw: string): string {
  const m = /<([^<>]+)>/.exec(raw);
  return (m ? m[1] : raw).trim();
}

type TenantEmailFlow = {
  id: string;
  /** One condition list per tenant_email trigger in the flow's set (OR). */
  conditionSets: TriggerCondition[][];
};

/**
 * Enabled flows with a tenant_email trigger anywhere in their trigger set:
 * primary `trigger` via the SQL channel filter, plus any flow carrying an
 * additional `triggers` array (rare; filtered by channel here).
 */
async function loadTenantEmailFlows(
  db: SupabaseClient,
  businessId: string
): Promise<TenantEmailFlow[]> {
  const { data, error } = await db
    .from("ai_flows")
    .select("id, definition")
    .eq("business_id", businessId)
    .eq("enabled", true)
    .or("definition->trigger->>channel.eq.tenant_email,definition->triggers.not.is.null");
  if (error) throw new Error(`loadTenantEmailFlows: ${error.message}`);
  const out: TenantEmailFlow[] = [];
  for (const row of (data ?? []) as Array<{ id: string; definition: unknown }>) {
    const def = row.definition as {
      trigger?: { channel?: unknown; conditions?: unknown };
      triggers?: Array<{ channel?: unknown; conditions?: unknown }>;
    } | null;
    const conditionSets: TriggerCondition[][] = [];
    for (const trig of [def?.trigger, ...(def?.triggers ?? [])]) {
      if (trig?.channel !== "tenant_email") continue;
      const conds = trig.conditions;
      conditionSets.push(Array.isArray(conds) ? (conds as TriggerCondition[]) : []);
    }
    if (conditionSets.length > 0) out.push({ id: row.id, conditionSets });
  }
  return out;
}

export async function processInboundTenantEmail(
  payload: InboundEmailPayload,
  client?: SupabaseClient
): Promise<InboundEmailResult> {
  const db = client ?? (await createSupabaseServiceClient());

  // Only trust attachment objects within this message's own path namespace.
  const prefix = attachmentPrefix(payload.messageId);
  const ownAttachments = (payload.attachments ?? []).filter((a) => a.path.startsWith(prefix));

  const businessId = await resolveBusinessByAddress(payload.to, db);
  if (!businessId) {
    // No tenant owns this address. The worker already uploaded any attachment
    // bytes before posting here, so remove them to avoid orphaning objects in
    // the bucket (best-effort). Scoped to this message's own paths only.
    const orphanPaths = ownAttachments.map((a) => a.path);
    if (orphanPaths.length > 0) {
      await db.storage.from(EMAIL_ATTACHMENTS_BUCKET).remove(orphanPaths);
    }
    return { matched: false };
  }

  const fromEmail = bareEmail(payload.from);
  // First image attachment → {{trigger.image}} (an `email-attachments:<path>`
  // ref the AiFlow worker can resolve as a generate_image edit source).
  const firstImage = ownAttachments.find((a) =>
    ["image/jpeg", "image/png", "image/webp"].includes(a.mimeType.trim().toLowerCase())
  );
  // First DOCUMENT attachment (pdf/docx/text) → {{trigger.document}} — the
  // doc_extract step's default source. Gated on the STORED PATH's extension
  // (which the email worker derives from the filename), because that suffix
  // is exactly what docExtract classifies the type from — a MIME-only match
  // whose path lacks the extension would hand the step a ref it can only
  // fail on. Covers octet-stream PDFs (extension present) by construction;
  // an extensionless attachment simply leaves the trigger document-less and
  // the step skips gracefully.
  const firstDocument = ownAttachments.find((a) => /\.(pdf|docx|txt|md|csv)$/i.test(a.path));

  // Record the inbound mail on the Emails page BEFORE enqueueing any run:
  // doc_extract's tenant-ownership gate reads this row's attachment paths,
  // so a worker that claims a freshly-enqueued run must already find the
  // row (previously the log write came after the enqueue loop — a run
  // racing ahead would fail its document read). The flow/run linkage is
  // backfilled below once the first run exists. Always written, matched or
  // not — the owner should see what their AI mailbox received.
  const attachments = ownAttachments.map((a) => ({
    filename: a.filename,
    mime_type: a.mimeType,
    size_bytes: a.size,
    storage_path: a.path
  }));
  const emailLogId = await recordTenantMailboxInbound(
    {
      businessId,
      toEmail: payload.to,
      fromEmail,
      subject: payload.subject,
      bodyText: payload.text,
      bodyHtml: payload.html ?? null,
      attachments,
      flowId: null,
      runId: null,
      providerMessageId: payload.messageId
    },
    db
  );

  const scope = tenantEmailTriggerScope({
    id: payload.messageId,
    fromEmail,
    subject: payload.subject,
    bodyText: payload.text,
    toEmail: payload.to,
    ...(firstImage ? { imageRef: `email-attachments:${firstImage.path}` } : {}),
    // {{trigger.document}} is only exposed when the log row LANDED — the
    // ownership gate trusts email_log.attachments alone, so a ref without
    // its row could only fail permanently. A (rare, best-effort) log
    // failure degrades to a document-less trigger and a graceful step skip;
    // the owner can re-run via the email replay once the row exists.
    ...(firstDocument && emailLogId
      ? {
          documentRef: `email-attachments:${firstDocument.path}`,
          documentName: firstDocument.filename
        }
      : {}),
    // Filenames ride into windowText + {{trigger.attachments}} so
    // document-receipt flows can condition on and confirm them.
    attachmentNames: ownAttachments.map((a) => a.filename)
  });

  const flows = await loadTenantEmailFlows(db, businessId);

  let enqueued = 0;
  let firstFlowId: string | null = null;
  let firstRunId: string | null = null;
  for (const flow of flows) {
    // OR across the flow's tenant_email triggers: the first matching
    // condition list fires the flow (one run — dedupe key is per message).
    let anyMatched = false;
    for (const conditions of flow.conditionSets) {
      // Pre-resolve any from_matches saved-contact refs to live identity values
      // (phones + emails). A resolution failure fails CLOSED for this flow only.
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
        console.error("tenant_email from_matches ref resolution", e);
        refValues = undefined;
      }
      if (evaluateTriggerConditions(conditions, scope.windowText, scope.from, refValues)) {
        anyMatched = true;
        break;
      }
    }
    if (!anyMatched) continue;
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

  // Backfill the flow/run linkage now that runs exist (the row itself was
  // written before the enqueue loop — see above). Best-effort.
  if (emailLogId && firstFlowId && firstRunId) {
    await linkTenantMailboxInboundRun(
      businessId,
      emailLogId,
      { flowId: firstFlowId, runId: firstRunId },
      db
    );
  }

  // Cross-channel rollup: if the sender's address is linked to a customer
  // profile, record an `email` interaction so the customer list reflects it
  // ("last via email") and the profile counts mail alongside SMS/voice. The
  // mail already shows on the profile via address match; this just keeps the
  // unified counters honest. Best-effort — never block on it.
  let linkedCustomer = false;
  try {
    const customer = await findCustomerByEmail(businessId, fromEmail, db);
    if (customer) {
      linkedCustomer = true;
      await recordInteractionAndIncrement(
        businessId,
        customer.customerE164,
        "email",
        {},
        db
      );
    }
  } catch (err) {
    try {
      await recordSystemLog({
        businessId,
        source: "aiflow",
        level: "warn",
        event: "customer_email_rollup_failed",
        message: "Failed to roll inbound email up to a customer profile",
        payload: {
          from: fromEmail,
          error: err instanceof Error ? err.message : String(err)
        }
      });
    } catch {
      // best-effort: never let logging the rollup miss break the inbound path
    }
  }

  // Knowledge graph (kg-source: email_unanswered): cold inbound mail from a
  // sender with NO linked contact extracts at ANONYMOUS trust (0) — the
  // upstream email reply-gate as attribution, not exclusion: everything is
  // captured, but a cold email can never masquerade as a relationship.
  // Linked senders are skipped here — their mail extracts at trust 1
  // through the customer-memory summarizer window (the interaction rollup
  // above is exactly what schedules it). Never-throws + daily-capped inside.
  if (!linkedCustomer) {
    await extractConversationGraph(businessId, {
      transcript: `CUSTOMER EMAIL from ${fromEmail}\nSubject: ${payload.subject}\n\n${payload.text}`,
      source: "email_unanswered",
      attributedTo: fromEmail
    });
  }

  return { matched: true, businessId, enqueued };
}
