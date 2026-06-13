#!/usr/bin/env tsx
/**
 * One-off: backfill `payload.events` deep links into already-sent digest
 * notification rows. The events feature shipped in PR #153 but the
 * notifications-digest edge function wasn't redeployed until 2026-06-12, so
 * existing rows expand into nothing clickable. Replays the same activity
 * queries (fetchActivity + buildDigestEventLinks) for each row's window.
 */
import { loadEnv } from "./_shared.ts";
import { createClient } from "@supabase/supabase-js";
import {
  buildDigestEventLinks,
  groupSmsThreads,
  isRenderableSmsSender,
  smsCounterpartFromPayload,
  type DigestActivity,
  type DigestEventLink,
  type DigestSmsMessage
} from "../supabase/functions/_shared/digest_builder.ts";

loadEnv();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const db = createClient(url, key);
const APPLY = process.argv.includes("--apply");

// Reuse the live builder so backfilled rows match what the edge function would
// now write (per-thread deep links + cap/roll-up handling).
async function buildEvents(
  businessId: string,
  sinceIso: string,
  untilIso: string
): Promise<DigestEventLink[]> {
  const [
    chatRes,
    smsInCountRes,
    repliesCountRes,
    outLogCountRes,
    smsJobRowsRes,
    outLogRowsRes,
    callsRes,
    flowsRes,
    custRes
  ] = await Promise.all([
      db
        .from("dashboard_chat_jobs")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .gte("created_at", sinceIso)
        .lt("created_at", untilIso),
      // Exact totals (head counts) — mirror the live function.
      db
        .from("sms_inbound_jobs")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .gte("created_at", sinceIso)
        .lt("created_at", untilIso),
      db
        .from("sms_inbound_jobs")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .not("assistant_reply_text", "is", null)
        .gte("updated_at", sinceIso)
        .lt("updated_at", untilIso),
      db
        .from("sms_outbound_log")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .gte("created_at", sinceIso)
        .lt("created_at", untilIso),
      // Rows for per-thread detail; reply side read off the same row as the
      // received side (no split-query skew).
      db
        .from("sms_inbound_jobs")
        .select("payload, created_at, assistant_reply_text, updated_at")
        .eq("business_id", businessId)
        .gte("created_at", sinceIso)
        .lt("created_at", untilIso)
        .order("created_at", { ascending: false })
        .limit(400),
      db
        .from("sms_outbound_log")
        .select("to_e164, created_at")
        .eq("business_id", businessId)
        .gte("created_at", sinceIso)
        .lt("created_at", untilIso)
        .order("created_at", { ascending: false })
        .limit(500),
      db
        .from("voice_call_transcripts")
        .select("caller_e164, status, started_at")
        .eq("business_id", businessId)
        .gte("started_at", sinceIso)
        .lt("started_at", untilIso)
        .order("started_at", { ascending: false })
        .limit(50),
      db
        .from("ai_flow_runs")
        .select("status, created_at, ai_flows(name)")
        .eq("business_id", businessId)
        .gte("created_at", sinceIso)
        .lt("created_at", untilIso)
        .order("created_at", { ascending: false })
        .limit(25),
      db
        .from("customer_memories")
        .select("display_name, customer_e164")
        .eq("business_id", businessId)
        .gte("created_at", sinceIso)
        .lt("created_at", untilIso)
        .order("created_at", { ascending: false })
        .limit(25)
    ]);

  const sinceMs = Date.parse(sinceIso);
  const untilMs = Date.parse(untilIso);
  const smsMessages: DigestSmsMessage[] = [];
  for (const r of (smsJobRowsRes.data ?? []) as Array<{
    payload: unknown;
    created_at: string;
    assistant_reply_text: string | null;
    updated_at: string;
  }>) {
    const cp = smsCounterpartFromPayload(r.payload);
    if (!cp) continue;
    smsMessages.push({ counterpart: cp, direction: "inbound", at: r.created_at });
    // Only count the reply when its updated_at is inside the window, matching
    // the authoritative smsOutbound head count.
    const replyAtMs = Date.parse(r.updated_at);
    if (
      typeof r.assistant_reply_text === "string" &&
      r.assistant_reply_text.length > 0 &&
      replyAtMs >= sinceMs &&
      replyAtMs < untilMs
    ) {
      smsMessages.push({ counterpart: cp, direction: "outbound", at: r.updated_at });
    }
  }
  for (const r of (outLogRowsRes.data ?? []) as Array<{
    to_e164: string | null;
    created_at: string;
  }>) {
    if (r.to_e164 && isRenderableSmsSender(r.to_e164)) {
      smsMessages.push({ counterpart: r.to_e164, direction: "outbound", at: r.created_at });
    }
  }

  const activity: DigestActivity = {
    chatTurns: chatRes.count ?? 0,
    smsInbound: smsInCountRes.count ?? 0,
    smsOutbound: (repliesCountRes.count ?? 0) + (outLogCountRes.count ?? 0),
    smsThreads: groupSmsThreads(smsMessages),
    calls: (callsRes.data ?? []) as DigestActivity["calls"],
    aiFlowRuns: ((flowsRes.data ?? []) as Array<{
      status: string;
      created_at: string;
      ai_flows: { name: string } | { name: string }[] | null;
    }>).map((r) => {
      const flow = Array.isArray(r.ai_flows) ? r.ai_flows[0] : r.ai_flows;
      return { flowName: flow?.name ?? "AiFlow", status: r.status, created_at: r.created_at, context: {} };
    }),
    newCustomers: (custRes.data ?? []) as DigestActivity["newCustomers"],
    urgentAlerts: 0,
    notificationsDelivered: 0
  };

  return buildDigestEventLinks(activity);
}

const { data: rows, error } = await db
  .from("notifications")
  .select("id, business_id, created_at, summary, payload")
  .eq("kind", "digest")
  .eq("status", "sent")
  .order("created_at", { ascending: false })
  .limit(50);
if (error) throw new Error(error.message);

for (const row of rows ?? []) {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  if (Array.isArray(payload.events)) {
    console.log(`skip (already has events): ${row.summary}`);
    continue;
  }
  const windowKind = payload.window === "weekly" ? "weekly" : "daily";
  const until = new Date(row.created_at);
  const since = new Date(
    until.getTime() - (windowKind === "weekly" ? 7 * 24 : 24) * 3600 * 1000
  );
  const events = await buildEvents(
    row.business_id as string,
    since.toISOString(),
    until.toISOString()
  );
  console.log(
    `${APPLY ? "apply" : "dry-run"}: ${row.created_at} "${row.summary}" → ${events.length} events`
  );
  for (const ev of events) console.log(`   - ${ev.label}`);
  if (APPLY) {
    const { error: upErr } = await db
      .from("notifications")
      .update({ payload: { ...payload, events } })
      .eq("id", row.id);
    if (upErr) throw new Error(upErr.message);
  }
}
