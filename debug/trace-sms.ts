#!/usr/bin/env tsx
/**
 * "They say they never got the text." Trace one phone number end to end.
 *
 * This investigation came up over and over ("Selena says her phone did not
 * receive this message", "why did the AI send this twice", "did the lead ever
 * get the follow-up") and each time it was re-derived by hand: find the
 * business, query the outbound log, query the inbound jobs, pull the Telnyx
 * message id, open the Telnyx portal, line the timestamps up. Same procedure,
 * same joins, every time. It is one command now.
 *
 * What it shows, merged into a single timeline:
 *   - outbound rows from `sms_outbound_log` (what WE tried to send, and why:
 *     source, flow, run),
 *   - inbound rows from `sms_inbound_jobs` (what the customer sent, plus the
 *     assistant reply the worker generated and its job status),
 *   - the carrier's verdict per outbound message from the Telnyx API
 *     (`delivered`, `sending_failed`, `delivery_unconfirmed`, …), which is the
 *     only source that can distinguish "we never sent it" from "we sent it and
 *     the carrier dropped it". That distinction is the whole question.
 *
 * Strictly READ-ONLY: no sends, no writes, no SSH. Safe on any tenant.
 *
 * Usage:
 *   tsx debug/trace-sms.ts --to +14805551234
 *   tsx debug/trace-sms.ts --to +14805551234 --since 7d --business <uuid>
 *   tsx debug/trace-sms.ts --to +14805551234 --no-carrier      # skip Telnyx
 *   tsx debug/trace-sms.ts --to +14805551234 --json
 *
 * Env (repo-root `.env`): SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, and
 * TELNYX_API_KEY for the carrier column.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";

/* -------------------------------------------------------------------------- */
/* args                                                                        */
/* -------------------------------------------------------------------------- */

type Args = {
  to: string;
  businessId: string | null;
  since: string;
  carrier: boolean;
  json: boolean;
};

/** Parse "36h" / "7d" / "90m" into milliseconds. */
export function parseSince(since: string): number {
  const m = /^(\d+)\s*([mhd])$/i.exec(since.trim());
  if (!m) throw new Error(`--since must look like 90m, 36h, or 7d (got "${since}")`);
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const ms = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * ms;
}

/**
 * Accept a number however it was pasted (from a text, a spreadsheet, the
 * dashboard) and return E.164. The stored columns are always E.164, so a
 * mismatch here is the difference between "no messages found" and the truth,
 * which is exactly the wrong answer to give on this question.
 */
export function normalizeE164(input: string): string {
  const trimmed = input.trim();
  if (/^\+\d{10,15}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  throw new Error(`could not read "${input}" as a phone number; pass E.164 like +14805551234`);
}

function parseArgs(argv: string[]): Args {
  const out: Args = { to: "", businessId: null, since: "72h", carrier: true, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--to") out.to = argv[++i] ?? "";
    else if (a === "--business") out.businessId = argv[++i] ?? null;
    else if (a === "--since") out.since = argv[++i] ?? out.since;
    else if (a === "--no-carrier") out.carrier = false;
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: tsx debug/trace-sms.ts --to +1… [--business <uuid>] [--since 72h] [--no-carrier] [--json]\n"
      );
      process.exit(0);
    }
  }
  if (!out.to) {
    process.stderr.write("--to is required. Example: tsx debug/trace-sms.ts --to +14805551234\n");
    process.exit(2);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* carrier status                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Ask Telnyx what happened to one message. Returns null when the id is
 * unknown, the key is missing, or the API is unhappy: the database timeline is
 * still worth printing without it.
 */
async function telnyxStatus(messageId: string, apiKey: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telnyx.com/v2/messages/${encodeURIComponent(messageId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) return `http ${res.status}`;
    const body = (await res.json()) as {
      data?: { to?: Array<{ status?: string; carrier?: string }>; errors?: Array<{ detail?: string }> };
    };
    const leg = body.data?.to?.[0];
    const err = body.data?.errors?.[0]?.detail;
    if (!leg?.status) return err ?? "unknown";
    return err ? `${leg.status} (${err})` : leg.status;
  } catch (e) {
    return `lookup failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/* -------------------------------------------------------------------------- */
/* timeline                                                                    */
/* -------------------------------------------------------------------------- */

type OutboundRow = {
  id: string;
  business_id: string;
  to_e164: string;
  from_e164: string | null;
  body: string | null;
  source: string | null;
  flow_id: string | null;
  run_id: string | null;
  telnyx_message_id: string | null;
  channel: string | null;
  created_at: string;
};

type InboundRow = {
  id: string;
  business_id: string;
  payload: Record<string, unknown> | null;
  status: string | null;
  assistant_reply_text: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type TimelineEntry = {
  at: string;
  direction: "outbound" | "inbound" | "reply";
  businessId: string;
  detail: string;
  body: string;
  carrier?: string | null;
};

/** Inbound text lives in the raw Telnyx envelope; shapes have drifted over time. */
export function inboundBody(payload: Record<string, unknown> | null): string {
  if (!payload) return "";
  const data = (payload.data ?? payload) as Record<string, unknown>;
  const payloadInner = (data.payload ?? data) as Record<string, unknown>;
  const text = payloadInner.text ?? payloadInner.body ?? "";
  return typeof text === "string" ? text : "";
}

function truncate(text: string, max = 110): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

async function buildTimeline(db: SupabaseClient, args: Args, sinceIso: string): Promise<TimelineEntry[]> {
  const e164 = normalizeE164(args.to);

  let outboundQuery = db
    .from("sms_outbound_log")
    .select("id, business_id, to_e164, from_e164, body, source, flow_id, run_id, telnyx_message_id, channel, created_at")
    .eq("to_e164", e164)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true });
  if (args.businessId) outboundQuery = outboundQuery.eq("business_id", args.businessId);

  let inboundQuery = db
    .from("sms_inbound_jobs")
    .select("id, business_id, payload, status, assistant_reply_text, last_error, created_at, updated_at")
    .eq("customer_e164", e164)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true });
  if (args.businessId) inboundQuery = inboundQuery.eq("business_id", args.businessId);

  const [outbound, inbound] = await Promise.all([outboundQuery, inboundQuery]);
  if (outbound.error) throw new Error(`sms_outbound_log: ${outbound.error.message}`);
  if (inbound.error) throw new Error(`sms_inbound_jobs: ${inbound.error.message}`);

  const apiKey = process.env.TELNYX_API_KEY ?? "";
  const entries: TimelineEntry[] = [];

  for (const row of (outbound.data ?? []) as OutboundRow[]) {
    const bits = [row.channel ?? "sms", `from ${row.from_e164 ?? "?"}`, `source ${row.source ?? "?"}`];
    if (row.flow_id) bits.push(`flow ${row.flow_id.slice(0, 8)}`);
    if (row.run_id) bits.push(`run ${row.run_id.slice(0, 8)}`);
    const carrier =
      args.carrier && apiKey && row.telnyx_message_id ? await telnyxStatus(row.telnyx_message_id, apiKey) : null;
    entries.push({
      at: row.created_at,
      direction: "outbound",
      businessId: row.business_id,
      detail: bits.join(", "),
      body: row.body ?? "",
      carrier: row.telnyx_message_id ? carrier : "no telnyx id recorded"
    });
  }

  for (const row of (inbound.data ?? []) as InboundRow[]) {
    entries.push({
      at: row.created_at,
      direction: "inbound",
      businessId: row.business_id,
      detail: `job ${row.status ?? "?"}${row.last_error ? `, error: ${truncate(row.last_error, 60)}` : ""}`,
      body: inboundBody(row.payload)
    });
    if (row.assistant_reply_text) {
      entries.push({
        at: row.updated_at,
        direction: "reply",
        businessId: row.business_id,
        detail: "assistant reply generated for the inbound above",
        body: row.assistant_reply_text
      });
    }
  }

  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadEnv();

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    process.stderr.write("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (repo-root .env)\n");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const e164 = normalizeE164(args.to);
  const sinceIso = new Date(Date.now() - parseSince(args.since)).toISOString();
  const entries = await buildTimeline(db, args, sinceIso);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ to: e164, since: sinceIso, entries }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`\nSMS trace for ${e164} since ${sinceIso}\n`);
  if (!process.env.TELNYX_API_KEY && args.carrier) {
    process.stdout.write("(no TELNYX_API_KEY in .env, so no carrier verdicts: DB rows only)\n");
  }
  if (entries.length === 0) {
    process.stdout.write(
      "\nNothing found. Before concluding nothing was sent, check:\n" +
        "  - the window (--since 7d), the number's format, and --business scoping\n" +
        "  - whether the row was soft-deleted (this tool does not filter deleted_at,\n" +
        "    so a truly absent row means the send never reached the log at all)\n"
    );
    return;
  }

  const arrow = { outbound: "-->", inbound: "<--", reply: " ->" } as const;
  for (const e of entries) {
    const carrier = e.carrier ? `  [carrier: ${e.carrier}]` : "";
    process.stdout.write(
      `\n${e.at}  ${arrow[e.direction]} ${e.direction.padEnd(8)} ${e.detail}${carrier}\n` +
        `                              ${truncate(e.body)}\n`
    );
  }

  const outbound = entries.filter((e) => e.direction === "outbound");
  const undelivered = outbound.filter((e) => e.carrier && !/^delivered/i.test(e.carrier));
  process.stdout.write(
    `\n${entries.length} events: ${outbound.length} outbound, ` +
      `${entries.filter((e) => e.direction === "inbound").length} inbound.\n`
  );
  if (undelivered.length > 0) {
    process.stdout.write(
      `${undelivered.length} outbound message(s) the carrier did NOT confirm as delivered. ` +
        "That is a carrier/number problem, not a flow problem.\n"
    );
  }
}

if (process.argv[1] && process.argv[1].endsWith("trace-sms.ts")) {
  main().catch((err: unknown) => {
    process.stderr.write(`trace-sms failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
