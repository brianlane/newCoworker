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

loadEnv();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const db = createClient(url, key);
const APPLY = process.argv.includes("--apply");

type EventLink = { label: string; href: string; at?: string };

function isRenderableSender(value: string): boolean {
  return value.startsWith("+") || /^\d{3,8}$/.test(value);
}

function counterpartFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const inner = (payload as { data?: { payload?: Record<string, unknown> } }).data?.payload;
  if (!inner) return null;
  const from = inner["from"] as { phone_number?: string } | string | undefined;
  if (typeof from === "string" && isRenderableSender(from)) return from;
  if (
    from &&
    typeof from === "object" &&
    typeof from.phone_number === "string" &&
    isRenderableSender(from.phone_number)
  ) {
    return from.phone_number;
  }
  return null;
}

async function buildEvents(
  businessId: string,
  sinceIso: string,
  untilIso: string
): Promise<EventLink[]> {
  const [chatRes, smsInRes, repliesRes, outLogRes, callsRes, flowsRes, custRes] =
    await Promise.all([
      db
        .from("dashboard_chat_jobs")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .gte("created_at", sinceIso)
        .lt("created_at", untilIso),
      db
        .from("sms_inbound_jobs")
        .select("payload, created_at")
        .eq("business_id", businessId)
        .gte("created_at", sinceIso)
        .lt("created_at", untilIso)
        .order("created_at", { ascending: false })
        .limit(300),
      db
        .from("sms_inbound_jobs")
        .select("payload, updated_at")
        .eq("business_id", businessId)
        .not("assistant_reply_text", "is", null)
        .gte("updated_at", sinceIso)
        .lt("updated_at", untilIso)
        .order("updated_at", { ascending: false })
        .limit(300),
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

  const events: EventLink[] = [];
  for (const c of (callsRes.data ?? []) as Array<{
    caller_e164: string | null;
    status: string;
    started_at: string;
  }>) {
    events.push({
      label: `Call — ${c.caller_e164 ?? "unknown caller"} (${c.status})`,
      href: "/dashboard/calls",
      at: c.started_at
    });
  }
  for (const r of (flowsRes.data ?? []) as Array<{
    status: string;
    created_at: string;
    ai_flows: { name: string } | { name: string }[] | null;
  }>) {
    const flow = Array.isArray(r.ai_flows) ? r.ai_flows[0] : r.ai_flows;
    events.push({
      label: `AiFlow — ${flow?.name ?? "AiFlow"} (${r.status})`,
      href: "/dashboard/aiflows",
      at: r.created_at
    });
  }
  for (const cust of (custRes.data ?? []) as Array<{
    display_name: string | null;
    customer_e164: string;
  }>) {
    const who = cust.display_name
      ? `${cust.display_name} (${cust.customer_e164})`
      : cust.customer_e164;
    events.push({
      label: `New customer — ${who}`,
      href: `/dashboard/customers/${encodeURIComponent(cust.customer_e164)}`
    });
  }
  const threads = new Map<string, { inbound: number; outbound: number; lastAt: string }>();
  const bump = (cp: string, dir: "inbound" | "outbound", at: string) => {
    const t = threads.get(cp) ?? { inbound: 0, outbound: 0, lastAt: at };
    if (dir === "inbound") t.inbound += 1;
    else t.outbound += 1;
    if (at > t.lastAt) t.lastAt = at;
    threads.set(cp, t);
  };
  let smsInbound = 0;
  let smsOutbound = 0;
  for (const r of (smsInRes.data ?? []) as Array<{ payload: unknown; created_at: string }>) {
    smsInbound += 1;
    const cp = counterpartFromPayload(r.payload);
    if (cp) bump(cp, "inbound", r.created_at);
  }
  for (const r of (repliesRes.data ?? []) as Array<{ payload: unknown; updated_at: string }>) {
    smsOutbound += 1;
    const cp = counterpartFromPayload(r.payload);
    if (cp) bump(cp, "outbound", r.updated_at);
  }
  for (const r of (outLogRes.data ?? []) as Array<{ to_e164: string | null; created_at: string }>) {
    smsOutbound += 1;
    if (r.to_e164 && isRenderableSender(r.to_e164)) bump(r.to_e164, "outbound", r.created_at);
  }
  const sortedThreads = Array.from(threads.entries()).sort((a, b) =>
    a[1].lastAt < b[1].lastAt ? 1 : a[1].lastAt > b[1].lastAt ? -1 : 0
  );
  if (sortedThreads.length > 0) {
    for (const [cp, t] of sortedThreads) {
      events.push({
        label: `Texts with ${cp} — ${t.inbound} received, ${t.outbound} sent`,
        href: `/dashboard/messages/${encodeURIComponent(cp)}`,
        at: t.lastAt
      });
    }
  } else if (smsInbound > 0 || smsOutbound > 0) {
    events.push({
      label: `Texts — ${smsInbound} received, ${smsOutbound} sent`,
      href: "/dashboard/messages"
    });
  }
  const chatTurns = chatRes.count ?? 0;
  if (chatTurns > 0) {
    events.push({
      label: `Dashboard chat — ${chatTurns} turn${chatTurns === 1 ? "" : "s"}`,
      href: "/dashboard/chat"
    });
  }
  // Mirror DIGEST_EVENT_LINKS_MAX in supabase/functions/_shared/digest_builder.ts.
  return events.slice(0, 30);
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
