/**
 * SMS-replay backfill: re-run missed inbound texts through a flow.
 *
 * The SMS twin of src/lib/email/replay.ts. When an sms-triggered flow is
 * disabled (or doesn't exist yet), inbound texts still land in
 * `sms_inbound_jobs` and get the default Coworker reply, but no flow run is
 * enqueued — the lead is never filed or worked by the automation. Once the
 * owner (re-)enables the flow, this module replays a recent window of
 * inbound texts: each one is re-evaluated against the flow's SMS triggers
 * EXACTLY like the live path (`evaluateAndEnqueueAiFlows` in
 * telnyx-sms-inbound) — same correlation-window semantics, evaluated at the
 * message's original receive time — and matches are enqueued as BACKFILL
 * runs. The worker's `upsert_customer` step ends a backfill run without
 * outreach when the lead already exists as a contact, so a replay can never
 * double-text someone the business already reached.
 *
 * Idempotent: the dedupe key is the message's Telnyx event id — the SAME key
 * the live webhook enqueue uses — so a replay can never duplicate a run the
 * webhook already queued, and re-running the replay is a no-op.
 *
 * Unlike email_log there is no flow/run stamp column on sms_inbound_jobs;
 * dedupe alone carries the "already handled" state. One deliberate loss:
 * {{trigger.image}} is not rebuilt (Telnyx MMS media links expire and the
 * durable copy is only captured when a flow matches at receive time).
 *
 * Service-role only. Owner authorization is the API route's job.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { enqueueAiFlowRun } from "@/lib/ai-flows/db";
import { recordSystemLog } from "@/lib/db/system-logs";
import {
  DEFAULT_CORRELATION_WINDOW_MINUTES,
  evaluateSmsTrigger
} from "../../../supabase/functions/_shared/ai_flows/engine";
import type {
  CorrelationMessage,
  SmsTrigger
} from "../../../supabase/functions/_shared/ai_flows/types";
import { inboundSmsBody } from "../../../supabase/functions/_shared/telnyx_sms_compliance";
import {
  telnyxMessagingParticipants,
  telnyxMessagingPhoneString
} from "../../../supabase/functions/_shared/telnyx_messaging_payload";
import { normalizeE164 } from "../../../supabase/functions/_shared/normalize_e164";
import {
  resolveFromMatchesRefValues,
  type ContactRefSupabase
} from "../../../supabase/functions/_shared/ai_flows/contact_ref";
import { BACKFILL_SKIP_EXISTING_TRIGGER_KEY } from "../../../supabase/functions/_shared/ai_flows/backfill";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Longest replayable window: one week of texts. */
export const MAX_REPLAY_LOOKBACK_HOURS = 168;

/** Newest inbound texts considered per request (matches the email cap). */
export const MAX_REPLAY_SMS = 100;

/** Extra rows loaded beyond the candidates, purely as correlation-window
 *  context for the oldest candidates. */
const CONTEXT_ROW_LIMIT = 300;

export type ReplaySmsInput = {
  /** How far back to scan for inbound texts (clamped to 1..168 hours). */
  lookbackHours: number;
};

export type ReplaySmsOutcome = {
  jobId: string;
  /**
   * enqueued  — a backfill run was queued for this text.
   * duplicate — a run with this message's event id already exists on the
   *             flow (live delivery or an earlier replay); nothing new queued.
   * skipped   — no usable sender, or the flow's trigger conditions don't
   *             match this message's correlation window.
   * error     — this row's enqueue failed; other rows still apply.
   */
  status: "enqueued" | "duplicate" | "skipped" | "error";
  reason?: string;
  runId?: string;
};

export type ReplaySmsSummary = {
  /** Inbound texts inside the window that were evaluated. */
  total: number;
  enqueued: number;
  duplicates: number;
  skipped: number;
  errors: number;
  /**
   * True when the window held more texts than one request evaluates (the
   * newest MAX_REPLAY_SMS win, or the row load hit its cap) — older texts
   * were NOT checked. The caller should surface "narrow the window / run
   * again" rather than letting the summary read as complete.
   */
  truncated: boolean;
  outcomes: ReplaySmsOutcome[];
};

/**
 * True when the flow starts from an inbound-SMS trigger (primary OR one of
 * the extra `triggers`) — the route's gate, mirroring
 * flowHasTenantEmailTrigger for the email replay.
 */
export function flowHasSmsTrigger(definition: unknown): boolean {
  return smsTriggersOf(definition).length > 0;
}

/**
 * Every structurally usable SMS trigger in the definition's OR set, in
 * declaration order — the same set the live webhook iterates (first match
 * wins). Malformed entries (no conditions array) are dropped, matching
 * isExecutableTrigger's posture.
 */
export function smsTriggersOf(definition: unknown): SmsTrigger[] {
  const def = definition as {
    trigger?: { channel?: unknown; conditions?: unknown };
    triggers?: Array<{ channel?: unknown; conditions?: unknown }>;
  } | null;
  const out: SmsTrigger[] = [];
  for (const trig of [def?.trigger, ...(def?.triggers ?? [])]) {
    if (trig?.channel !== "sms" || !Array.isArray(trig.conditions)) continue;
    out.push(trig as SmsTrigger);
  }
  return out;
}

/** The replay target: id + raw definition (as loaded by the route's gate). */
export type ReplayFlow = { id: string; definition: unknown };

type InboundJobRow = {
  id: string;
  payload: Record<string, unknown>;
  created_at: string;
};

type ParsedInbound = {
  jobId: string;
  /** Telnyx event id (the live dedupe key), or a stable per-row fallback. */
  eventId: string;
  from: string | null;
  to: string;
  text: string;
  participants: string[];
  atMs: number;
};

/** Decode one persisted Telnyx envelope into the fields the trigger scope needs. */
function parseInboundJob(row: InboundJobRow): ParsedInbound {
  const env = row.payload as {
    data?: { id?: unknown; payload?: Record<string, unknown> };
  };
  const p = env?.data?.payload ?? {};
  const eventId =
    typeof env?.data?.id === "string" && env.data.id ? env.data.id : `sms-log:${row.id}`;
  const seen = new Set<string>();
  const participants: string[] = [];
  for (const raw of telnyxMessagingParticipants(p)) {
    const n = normalizeE164(raw);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    participants.push(n);
  }
  const atMs = Date.parse(row.created_at);
  return {
    jobId: row.id,
    eventId,
    from: normalizeE164(telnyxMessagingPhoneString(p, "from")),
    to: normalizeE164(telnyxMessagingPhoneString(p, "to")) ?? "",
    text: inboundSmsBody(p),
    participants,
    atMs: Number.isFinite(atMs) ? atMs : Date.now()
  };
}

/**
 * Replay recent inbound texts through `flow` as backfill runs. Rows apply
 * independently — one failure never blocks the rest. The caller (API route)
 * has already verified the flow: exists for this business, enabled, carries
 * an SMS trigger, and files the lead before any outreach
 * (flowUpsertsBeforeOutreach).
 */
export async function replayInboundSms(
  businessId: string,
  flow: ReplayFlow,
  input: ReplaySmsInput,
  client?: SupabaseClient
): Promise<ReplaySmsSummary> {
  const summary: ReplaySmsSummary = {
    total: 0,
    enqueued: 0,
    duplicates: 0,
    skipped: 0,
    errors: 0,
    truncated: false,
    outcomes: []
  };
  const triggers = smsTriggersOf(flow.definition);
  if (triggers.length === 0) return summary;

  const db = client ?? (await createSupabaseServiceClient());
  const hours = Math.min(MAX_REPLAY_LOOKBACK_HOURS, Math.max(1, Math.floor(input.lookbackHours)));
  const nowMs = Date.now();
  const cutoffMs = nowMs - hours * 3_600_000;
  // Load past the cutoff by the widest correlation window so the OLDEST
  // candidate still sees its earlier same-sender messages, exactly like the
  // live evaluation did at receive time.
  const maxWindowMinutes = Math.max(
    ...triggers.map((t) => t.correlationWindowMinutes ?? DEFAULT_CORRELATION_WINDOW_MINUTES)
  );
  const loadFromIso = new Date(cutoffMs - maxWindowMinutes * 60_000).toISOString();

  // staff_kind IS NULL: owner/team texts never go through the live flow-eval
  // path (telnyx-sms-inbound only calls evaluateAndEnqueueAiFlows for
  // customer texts), so a replay must not treat a teammate's message as a
  // lead either.
  const { data, error } = await db
    .from("sms_inbound_jobs")
    .select("id, payload, created_at")
    .eq("business_id", businessId)
    .is("staff_kind", null)
    .gte("created_at", loadFromIso)
    .order("created_at", { ascending: false })
    .limit(CONTEXT_ROW_LIMIT);
  if (error) throw new Error(`replayInboundSms: ${error.message}`);
  const loaded = (data ?? []) as InboundJobRow[];
  // Chronological (oldest first) so correlation windows and outcomes read in
  // conversation order.
  const rows = loaded.map(parseInboundJob).reverse();

  // Newest MAX_REPLAY_SMS texts inside the window are the candidates. A
  // busier window than one request evaluates (more candidates than the cap,
  // or the newest-first row load maxing out before reaching the cutoff) is
  // reported as truncated so the caller can say "narrow the window" instead
  // of the summary reading as complete.
  const inWindow = rows.filter((r) => r.atMs >= cutoffMs);
  const candidates = inWindow.slice(-MAX_REPLAY_SMS);
  summary.total = candidates.length;
  summary.truncated =
    inWindow.length > candidates.length || loaded.length >= CONTEXT_ROW_LIMIT;
  if (candidates.length === 0) return summary;

  // Live parity: an inbound text consumed by a parked wait_for_reply run
  // never reaches trigger evaluation (the flow owns that turn — see
  // resumeAwaitingReplyRun in telnyx-sms-inbound), so a replay must not
  // treat it as a fresh lead either. The consumption isn't stamped on the
  // job row, but the resumed run persists it: waiting_reply.result="reply",
  // waiting_reply.from=<sender>, and vars[save_as]=<the consumed text>.
  // Rebuild that as a (sender, text) set and skip matching candidates.
  // Conservative on purpose: if the same sender sent the identical text
  // twice and one answered a wait, both are skipped — skipping a lead beats
  // double-processing one. A read failure fails the request loudly (replay
  // is an explicit owner action) rather than risking duplicates.
  const senders = [...new Set(candidates.flatMap((c) => (c.from ? [c.from] : [])))];
  const consumedByWait = new Set<string>();
  if (senders.length > 0) {
    const { data: waitRows, error: waitErr } = await db
      .from("ai_flow_runs")
      .select("context")
      .eq("business_id", businessId)
      .eq("context->waiting_reply->>result", "reply")
      .in("context->waiting_reply->>from", senders)
      // updated_at only moves forward, so every run that consumed a text
      // inside the replay window is still >= loadFrom.
      .gte("updated_at", loadFromIso)
      .limit(1000);
    if (waitErr) throw new Error(`replayInboundSms: wait-consumption read: ${waitErr.message}`);
    for (const row of (waitRows ?? []) as Array<{ context: Record<string, unknown> | null }>) {
      const waiting = row.context?.waiting_reply as
        | { from?: unknown; save_as?: unknown }
        | undefined;
      const from = typeof waiting?.from === "string" ? waiting.from : "";
      if (!from) continue;
      const saveAs =
        typeof waiting?.save_as === "string" && waiting.save_as.trim()
          ? waiting.save_as
          : "reply_text";
      const vars = row.context?.vars as Record<string, unknown> | undefined;
      const consumed = vars?.[saveAs];
      if (typeof consumed === "string" && consumed) consumedByWait.add(`${from}\n${consumed}`);
    }
  }

  // Pre-resolve each trigger's from_matches contact refs ONCE for the whole
  // batch (they reference saved people, not the message). A resolution
  // failure marks that trigger unusable → it fails closed, mirroring the
  // live path's per-flow fail-closed.
  const refValuesByTrigger: (Map<string, string[]> | null)[] = [];
  for (const trigger of triggers) {
    try {
      refValuesByTrigger.push(
        // Cast: the full supabase-js builder type recurses too deep for TS to
        // check structurally against the resolver's minimal chain type.
        await resolveFromMatchesRefValues(
          db as unknown as ContactRefSupabase,
          businessId,
          trigger.conditions
        )
      );
    } catch (e) {
      console.error("replayInboundSms from_matches ref resolution", e);
      refValuesByTrigger.push(null);
    }
  }

  for (const msg of candidates) {
    const sender = msg.from;
    if (!sender) {
      summary.skipped += 1;
      summary.outcomes.push({ jobId: msg.jobId, status: "skipped", reason: "no usable sender" });
      continue;
    }
    if (consumedByWait.has(`${sender}\n${msg.text.slice(0, 4000)}`)) {
      summary.skipped += 1;
      summary.outcomes.push({
        jobId: msg.jobId,
        status: "skipped",
        reason: "this text answered a flow that was waiting for the sender's reply"
      });
      continue;
    }
    // The sender's messages up to (and including) this one — drawn from
    // everything loaded (candidates + pre-window context), chronological.
    // evaluateSmsTrigger applies each trigger's own window cutoff against
    // nowMs = the original receive time, reproducing the live evaluation.
    const messages: CorrelationMessage[] = rows
      .filter((r) => r.from === sender && r.atMs <= msg.atMs)
      .map((r) => ({ text: r.text, from: sender, atMs: r.atMs }));
    let matched: { windowText: string; url: string | null } | null = null;
    for (let i = 0; i < triggers.length; i++) {
      const refValues = refValuesByTrigger[i];
      if (refValues === null) continue;
      const res = evaluateSmsTrigger(triggers[i], { messages, nowMs: msg.atMs }, refValues);
      if (res.matched) {
        matched = { windowText: res.windowText, url: res.url };
        break;
      }
    }
    if (!matched) {
      summary.skipped += 1;
      summary.outcomes.push({
        jobId: msg.jobId,
        status: "skipped",
        reason: "the flow's trigger conditions don't match this text"
      });
      continue;
    }
    // Same trigger-scope shape the live webhook enqueue writes, plus the
    // backfill marker. image stays "" (see module comment).
    const trigger = {
      url: matched.url,
      windowText: matched.windowText,
      from: sender,
      to: msg.to,
      participants: msg.participants,
      group: msg.participants.length > 2,
      event_id: msg.eventId,
      image: "",
      [BACKFILL_SKIP_EXISTING_TRIGGER_KEY]: "1"
    };
    try {
      const run = await enqueueAiFlowRun(
        { businessId, flowId: flow.id, trigger, dedupeKey: msg.eventId },
        db
      );
      if (!run) {
        // The live webhook (or an earlier replay) already queued this
        // message. A FAILED (or key-holding canceled) run still owns the
        // dedupe key without having recovered anything — surface that
        // honestly instead of counting it as handled.
        const { data: existingRun, error: findErr } = await db
          .from("ai_flow_runs")
          .select("id, status")
          .eq("business_id", businessId)
          .eq("flow_id", flow.id)
          .eq("dedupe_key", msg.eventId)
          .maybeSingle();
        if (findErr) console.error("replayInboundSms duplicate lookup", findErr.message);
        const existing = existingRun as { id?: string; status?: string } | null;
        if (existing?.status === "failed" || existing?.status === "canceled") {
          summary.errors += 1;
          summary.outcomes.push({
            jobId: msg.jobId,
            status: "error",
            reason:
              "an earlier run for this text failed and still holds its slot — check the flow's runs page"
          });
          continue;
        }
        summary.duplicates += 1;
        summary.outcomes.push({ jobId: msg.jobId, status: "duplicate" });
        continue;
      }
      summary.enqueued += 1;
      summary.outcomes.push({ jobId: msg.jobId, status: "enqueued", runId: run.id });
    } catch (e) {
      summary.errors += 1;
      summary.outcomes.push({
        jobId: msg.jobId,
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
      event: "ai_flow_sms_replay",
      message: `SMS replay: ${summary.enqueued}/${summary.total} texts enqueued as backfill runs`,
      payload: {
        flow_id: flow.id,
        lookback_hours: hours,
        total: summary.total,
        enqueued: summary.enqueued,
        duplicates: summary.duplicates,
        skipped: summary.skipped,
        errored: summary.errors,
        truncated: summary.truncated
      }
    },
    db
  );

  return summary;
}
