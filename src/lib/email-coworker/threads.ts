/**
 * The email coworker's thread ledger: which conversations it owns, and
 * which inbound messages it has already evaluated.
 *
 * SAFETY MODEL. The coworker answers inbound email ONLY inside a thread it
 * started itself. A row here is created when an owner surface sends mail
 * through the EMAIL_SEND protocol (dashboard chat or the owner-over-SMS
 * operator turn), so the candidate set is exactly "conversations the
 * business opened through the assistant". Receipts, newsletters, and the
 * owner's own correspondence are never candidates, and no allowlist has to
 * be curated. Every function here is best-effort where a failure would
 * otherwise break the SEND that triggered it: losing thread ownership
 * costs an autonomous follow-up, never the email itself.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type EmailCoworkerThread = {
  id: string;
  businessId: string;
  provider: "google" | "microsoft";
  threadId: string;
  subject: string | null;
  correspondentEmail: string | null;
  lastSentMessageRef: string | null;
  turns: number;
  turnsDay: string | null;
  handedOff: boolean;
};

type ThreadRow = {
  id: string;
  business_id: string;
  provider: string;
  thread_id: string;
  subject: string | null;
  correspondent_email: string | null;
  last_sent_message_ref: string | null;
  turns: number;
  turns_day: string | null;
  handed_off: boolean;
};

const COLUMNS =
  "id, business_id, provider, thread_id, subject, correspondent_email, " +
  "last_sent_message_ref, turns, turns_day, handed_off";

/** Autonomous replies the coworker may send on ONE thread in ONE UTC day. */
export const EMAIL_COWORKER_MAX_TURNS_PER_DAY = 5;

/** Threads stop being polled once this quiet: a dead negotiation is not worth mailbox reads. */
export const EMAIL_COWORKER_THREAD_ACTIVE_DAYS = 30;

function mapRow(row: ThreadRow): EmailCoworkerThread {
  return {
    id: row.id,
    businessId: row.business_id,
    provider: row.provider === "microsoft" ? "microsoft" : "google",
    threadId: row.thread_id,
    subject: row.subject,
    correspondentEmail: row.correspondent_email,
    lastSentMessageRef: row.last_sent_message_ref,
    turns: row.turns,
    turnsDay: row.turns_day,
    handedOff: row.handed_off
  };
}

/**
 * Record (or refresh) a thread the assistant just sent into. Best-effort:
 * the mail is already out, so a bookkeeping failure must not surface as a
 * send failure.
 */
export async function rememberSentThread(
  input: {
    businessId: string;
    provider: "google" | "microsoft";
    threadId: string;
    subject?: string | null;
    correspondentEmail?: string | null;
    sentMessageRef?: string | null;
  },
  client?: SupabaseClient
): Promise<void> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { error } = await db.from("email_coworker_threads").upsert(
      {
        business_id: input.businessId,
        provider: input.provider,
        thread_id: input.threadId,
        subject: input.subject ?? null,
        correspondent_email: input.correspondentEmail?.trim().toLowerCase() || null,
        last_sent_message_ref: input.sentMessageRef ?? null,
        updated_at: new Date().toISOString()
      },
      { onConflict: "business_id,thread_id" }
    );
    if (error) throw new Error(error.message);
  } catch (err) {
    logger.warn("email-coworker: thread ownership write failed", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Owned, still-active threads for every business with any, newest first.
 * Handed-off threads are excluded: a human took over.
 */
export async function listActiveThreads(
  client?: SupabaseClient,
  activeDays = EMAIL_COWORKER_THREAD_ACTIVE_DAYS
): Promise<EmailCoworkerThread[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const since = new Date(Date.now() - activeDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("email_coworker_threads")
    .select(COLUMNS)
    .eq("handed_off", false)
    .gte("updated_at", since)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`listActiveThreads: ${error.message}`);
  return ((data ?? []) as unknown as ThreadRow[]).map(mapRow);
}

/**
 * Count one autonomous reply against the thread's daily budget and stamp
 * the message we replied to. Returns the new count for the day.
 */
export async function recordThreadTurn(
  threadRowId: string,
  input: { sentMessageRef?: string | null; day?: string },
  currentTurnsToday: number,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const day = input.day ?? new Date().toISOString().slice(0, 10);
  const { error } = await db
    .from("email_coworker_threads")
    .update({
      turns: currentTurnsToday + 1,
      turns_day: day,
      ...(input.sentMessageRef ? { last_sent_message_ref: input.sentMessageRef } : {}),
      updated_at: new Date().toISOString()
    })
    .eq("id", threadRowId);
  if (error) throw new Error(`recordThreadTurn: ${error.message}`);
}

/** Turns already spent on this thread TODAY (a new day resets the budget). */
export function turnsToday(thread: EmailCoworkerThread, day?: string): number {
  const today = day ?? new Date().toISOString().slice(0, 10);
  return thread.turnsDay === today ? thread.turns : 0;
}

/** Stop answering this thread: a human owns it now. */
export async function markThreadHandedOff(
  threadRowId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("email_coworker_threads")
    .update({ handed_off: true, updated_at: new Date().toISOString() })
    .eq("id", threadRowId);
  if (error) throw new Error(`markThreadHandedOff: ${error.message}`);
}

/** Provider message ids already evaluated for this business. */
export async function filterUnseenMessages(
  businessId: string,
  messageIds: string[],
  client?: SupabaseClient
): Promise<string[]> {
  if (messageIds.length === 0) return [];
  const db = client ?? (await createSupabaseServiceClient());
  const seen = new Set<string>();
  for (let i = 0; i < messageIds.length; i += 100) {
    const chunk = messageIds.slice(i, i + 100);
    const { data, error } = await db
      .from("email_coworker_seen")
      .select("message_id")
      .eq("business_id", businessId)
      .in("message_id", chunk);
    if (error) throw new Error(`filterUnseenMessages: ${error.message}`);
    for (const row of (data ?? []) as Array<{ message_id: string }>) {
      seen.add(row.message_id);
    }
  }
  return messageIds.filter((id) => !seen.has(id));
}

/**
 * Mark messages evaluated. Written BEFORE the turn runs: a crash mid-turn
 * must not re-answer the same email on the next tick (an owner would
 * rather lose one reply than send two).
 */
export async function markMessagesSeen(
  businessId: string,
  messageIds: string[],
  client?: SupabaseClient
): Promise<void> {
  if (messageIds.length === 0) return;
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("email_coworker_seen").upsert(
    messageIds.map((id) => ({ business_id: businessId, message_id: id })),
    { onConflict: "business_id,message_id", ignoreDuplicates: true }
  );
  if (error) throw new Error(`markMessagesSeen: ${error.message}`);
}
