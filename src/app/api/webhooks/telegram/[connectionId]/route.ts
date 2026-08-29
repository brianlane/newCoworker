/**
 * Telegram Bot API receiver, one URL per connected bot.
 *
 * WHY THE CONNECTION IS IN THE PATH. Telegram has no signature and no
 * organisation id. An update carries the sender and the chat, and nothing
 * that says which bot received it, so a single shared URL could not tell
 * one tenant's traffic from another's. The bot is therefore identified by
 * the path segment, and authenticated by the per-connection `secret_token`
 * Telegram echoes back in `X-Telegram-Bot-Api-Secret-Token`. That header is
 * the ONLY thing standing between this route and anybody who guesses a
 * connection id, which is why it is compared in constant time and why a
 * connection with no stored secret is refused outright rather than
 * defaulting to open.
 *
 * ALWAYS ANSWER 200 to an authentic delivery, even one we do nothing with.
 * Telegram retries a non-2xx and, on sustained failures, backs the webhook
 * off entirely.
 */

import { after } from "next/server";
import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { getCoworkerConnection } from "@/lib/db/coworker-connections";
import { handleTelegramMessage, type TelegramUpdate } from "@/lib/telegram/inbound";
import { kickCoworkerWorker } from "@/lib/coworker-channels/kick";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Telegram updates are small; anything larger is not one of ours. */
const MAX_BODY_BYTES = 256 * 1024;

/** Constant-time, and false for anything missing or mis-sized. */
export function secretMatches(presented: string | null, expected: string | null): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on a length mismatch, and the length itself is
  // not a secret worth protecting here.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string }> }
) {
  const { connectionId } = await context.params;

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }

  let connection;
  try {
    connection = await findConnection(connectionId);
  } catch (err) {
    // A read failure must NOT read as "unknown bot": Telegram would keep
    // the webhook and we would silently drop every message until someone
    // noticed. 500 makes it redeliver.
    logger.error("telegram webhook: connection read failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return NextResponse.json({ ok: false, error: "read_failed" }, { status: 500 });
  }

  // Unknown id and bad secret answer identically, on purpose: telling them
  // apart would let someone enumerate live connection ids.
  if (
    !connection ||
    !secretMatches(request.headers.get("x-telegram-bot-api-secret-token"), connection.webhookSecret)
  ) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (!connection.is_active || connection.credential.length === 0) {
    // Paused or awaiting a reconnect. Authentic, so 200; just nothing to do.
    return NextResponse.json({ ok: true, skipped: "inactive" });
  }

  let update: TelegramUpdate;
  try {
    update = JSON.parse(raw) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: true, skipped: "unparseable" });
  }

  try {
    const result = await handleTelegramMessage({ connection, update });
    if (result.enqueued) after(() => kickCoworkerWorker("telegram"));
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // 500 so Telegram redelivers: the message is real and unanswered.
    logger.error("telegram webhook: handler failed", {
      businessId: connection.business_id,
      error: err instanceof Error ? err.message : String(err)
    });
    return NextResponse.json({ ok: false, error: "handler_failed" }, { status: 500 });
  }
}

/**
 * The connection id is a uuid from our own table, so a malformed one is a
 * miss rather than a query error.
 */
async function findConnection(connectionId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return null;
  const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
  const db = await createSupabaseServiceClient();
  const { data, error } = await db
    .from("coworker_connections")
    .select("business_id")
    .eq("id", connectionId)
    .eq("channel", "telegram")
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as { business_id?: string } | null;
  if (!row?.business_id) return null;
  return getCoworkerConnection(row.business_id, "telegram", db);
}
