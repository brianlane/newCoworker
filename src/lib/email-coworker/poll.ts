/**
 * The email coworker's poll: one pass over every business that owns an
 * active email thread, answering replies that landed on those threads.
 *
 * Deliberately separate from the AiFlow trigger poll: that one asks "does
 * this message match a flow's conditions", this one asks "is this message
 * a reply on a conversation we started". Both read the same mailboxes, and
 * both are failure-isolated per business so one broken connection cannot
 * stall the rest.
 *
 * Rails, in order of application:
 *   1. The thread must be OWNED (started by the assistant) and not handed off.
 *   2. The message must not be from the mailbox itself (no self-answering).
 *   3. The message must be unseen, and is marked seen BEFORE the turn runs:
 *      an owner would rather lose a reply than receive two.
 *   4. The thread's daily turn budget must not be spent; hitting it hands
 *      the thread to a human and alerts the owner once.
 */

import { threadsAnsweredByFlow } from "@/lib/db/email-log";
import { tenantEmailDomain } from "@/lib/email/tenant-mailbox";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { resolveEmailConnection } from "@/lib/voice-tools/connections";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { recordFailure, recordSystemLog } from "@/lib/db/system-logs";
import { providerFailureDetail } from "@/lib/workspace/failure-detail";
import {
  fetchInboxWithThreads,
  fetchMailboxAddress,
  INBOX_LOOKBACK_MINUTES
} from "@/lib/email-coworker/mailbox";
import {
  EMAIL_COWORKER_MAX_TURNS_PER_DAY,
  claimMessage,
  filterUnseenMessages,
  listActiveThreads,
  markThreadHandedOff,
  recordThreadTurn,
  turnsToday,
  type EmailCoworkerThread
} from "@/lib/email-coworker/threads";
import { runEmailCoworkerTurn } from "@/lib/email-coworker/turn";
import { noteProspectReply } from "@/lib/outreach/reply";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type EmailCoworkerPollResult = {
  businesses: number;
  threads: number;
  messages: number;
  replied: number;
  handedOff: number;
};

/**
 * Every address that IS us, so we never answer our own mail. The connected
 * mailbox is authoritative (a tenant can sign in as one address and
 * correspond from a shared one), with the dashboard login kept as a weaker
 * fallback for when the provider will not report a profile.
 */
/**
 * Is this message from us?
 *
 * Set membership alone is not enough. `selfAddresses` collects the Gmail
 * profile address and the dashboard login, and for a shared mailbox BOTH can
 * be the account (HQ: newcoworkerteam@gmail.com) while the correspondence
 * address is a send-as alias on the tenant domain (team@newcoworker.com). The
 * Cloudflare catch-all forwards that alias back into this very mailbox, so a
 * reply arrives as genuinely received mail and the coworker answers itself.
 *
 * Anything on the tenant email domain is therefore ours by construction: that
 * domain is where the AI mailbox and the catch-all aliases live.
 */
export function isSelfSender(fromEmail: string, ourAddresses: Set<string>): boolean {
  const from = fromEmail.trim().toLowerCase();
  if (!from) return false;
  if (ourAddresses.has(from)) return true;
  const at = from.lastIndexOf("@");
  return at !== -1 && from.slice(at + 1) === tenantEmailDomain();
}

async function selfAddresses(
  businessId: string,
  provider: "google" | "microsoft",
  link: { connectionId: string; providerConfigKey: string },
  db: SupabaseClient
): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const mailbox = await fetchMailboxAddress(businessId, provider, link);
    if (mailbox) out.add(mailbox);
  } catch {
    // A profile read failure must not stop the poll; the login below still
    // catches the common case.
  }
  try {
    const { data } = await db
      .from("businesses")
      .select("owner_email")
      .eq("id", businessId)
      .maybeSingle();
    const email = (data as { owner_email?: string } | null)?.owner_email;
    if (typeof email === "string" && email.trim()) out.add(email.trim().toLowerCase());
  } catch {
    // Same posture.
  }
  return out;
}

async function businessTimezone(businessId: string, db: SupabaseClient): Promise<string | null> {
  try {
    const { data } = await db
      .from("businesses")
      .select("timezone")
      .eq("id", businessId)
      .maybeSingle();
    const tz = (data as { timezone?: string } | null)?.timezone;
    return typeof tz === "string" && tz.trim() ? tz : null;
  } catch {
    return null;
  }
}

export async function pollEmailCoworker(
  client?: SupabaseClient
): Promise<EmailCoworkerPollResult> {
  const db = client ?? (await createSupabaseServiceClient());
  const result: EmailCoworkerPollResult = {
    businesses: 0,
    threads: 0,
    messages: 0,
    replied: 0,
    handedOff: 0
  };

  const threads = await listActiveThreads(db);
  result.threads = threads.length;
  if (threads.length === 0) return result;

  const byBusiness = new Map<string, EmailCoworkerThread[]>();
  for (const t of threads) {
    byBusiness.set(t.businessId, [...(byBusiness.get(t.businessId) ?? []), t]);
  }

  const sinceMs = Date.now() - INBOX_LOOKBACK_MINUTES * 60_000;
  for (const [businessId, owned] of byBusiness) {
    result.businesses += 1;
    try {
      const conn = await resolveEmailConnection(businessId);
      if (!conn) continue;
      const link = {
        connectionId: conn.connectionId,
        providerConfigKey: conn.providerConfigKey
      };
      const [ourAddresses, timezone] = await Promise.all([
        selfAddresses(businessId, conn.provider, link, db),
        businessTimezone(businessId, db)
      ]);

      const messages = await fetchInboxWithThreads(businessId, conn.provider, link, sinceMs);

      const ownedByThreadId = new Map(owned.map((t) => [t.threadId, t]));
      const candidates = messages.filter((m) => {
        if (!m.threadId || !ownedByThreadId.has(m.threadId)) return false;
        // Our own sent copy can appear in some mailbox views; answering it
        // would be an infinite conversation with ourselves.
        if (isSelfSender(m.fromEmail, ourAddresses)) return false;
        return true;
      });
      if (candidates.length === 0) continue;

      // NEVER auto-answer a conversation we have already replied to.
      //
      // Live, Aug 10 2026: the triage flow answered James's introduction and
      // CLAIMED the thread, which retroactively made the triggering message
      // eligible here (still in the lookback window, now on an owned thread,
      // never seen by this poll). James got two replies a minute apart, the
      // second off-script.
      //
      // Keyed on the THREAD, and specifically on threads a GATED FLOW answered:
      // once Brian has approved a reply on a conversation, every later message
      // goes back through the same gate rather than out unseen. He did not
      // gate the first email to a stranger and then mean "send whatever you
      // like after that". The flow still runs on these messages, so they are
      // classified, filed and put in front of him; only the silent send stops.
      //
      // Deliberately NOT "any outbound row on the thread": the coworker's own
      // replies are outbound too, so that rule would have stopped it after its
      // FIRST reply on a conversation it owns and quietly broken the multi-turn
      // budget it is built around (an outreach pitch, a booking follow-up).
      const repliedThreads = await threadsAnsweredByFlow(
        businessId,
        candidates.map((m) => m.threadId).filter((t): t is string => Boolean(t)),
        db
      );
      const notFlowHandled = candidates.filter(
        (m) => !m.threadId || !repliedThreads.has(m.threadId)
      );
      if (notFlowHandled.length === 0) continue;

      const unseenIds = new Set(
        await filterUnseenMessages(
          businessId,
          notFlowHandled.map((m) => m.id),
          db
        )
      );
      const fresh = notFlowHandled.filter((m) => unseenIds.has(m.id));
      if (fresh.length === 0) continue;
      result.messages += fresh.length;

      for (const message of fresh) {
        const thread = ownedByThreadId.get(message.threadId)!;
        // Claimed PER MESSAGE, immediately before we act on it, and
        // atomically: claiming the whole batch up front meant a pass that
        // died partway left later replies consumed but unanswered, while a
        // check-then-write would let two overlapping passes both answer.
        // Losing the claim means another pass owns this message.
        //
        // Claimed even when the thread is handed off below, because the row
        // is also what the AiFlow email poll honors: a thread a human took
        // over must not get an automated answer from the other side of the
        // house either.
        if (!(await claimMessage(businessId, message.id, db))) continue;

        // If this is a cold-outreach prospect answering, the ledger has to know
        // before the follow-up sweep runs again: a nudge sent to somebody who
        // already replied reads as a machine talking over them. Also catches
        // "take me off your list", which suppresses rather than just records.
        // Best-effort, and independent of whether we answer below.
        await noteProspectReply(
          businessId,
          [message.fromEmail, thread.correspondentEmail],
          message.bodyText,
          db
        );

        // A batch can carry several replies on the SAME thread; once it is
        // handed off, the rest are the human's to answer (and re-alerting
        // per message would spam the owner).
        if (thread.handedOff) continue;

        const spent = turnsToday(thread);
        if (spent >= EMAIL_COWORKER_MAX_TURNS_PER_DAY) {
          // A conversation this long is not converging: hand it to a human
          // rather than keep answering.
          await markThreadHandedOff(thread.id, db);
          thread.handedOff = true;
          result.handedOff += 1;
          await dispatchUrgentNotification({
            businessId,
            summary: `Email thread needs you: ${thread.subject ?? "(no subject)"}`,
            kind: "email_coworker_handoff",
            payload: { thread_id: thread.threadId, from: message.fromEmail },
            emailSubject: `Take over the email thread with ${message.fromEmail}`,
            emailBody:
              `Your coworker has answered ${EMAIL_COWORKER_MAX_TURNS_PER_DAY} times today on ` +
              `"${thread.subject ?? "(no subject)"}" with ${message.fromEmail} and has stopped ` +
              "so it does not talk in circles. The thread is in your mailbox.",
            smsBody:
              `[Coworker] Email thread with ${message.fromEmail} needs you: ` +
              `${thread.subject ?? "(no subject)"}`
          }).catch(() => {});
          continue;
        }

        const turn = await runEmailCoworkerTurn({
          thread,
          message,
          link: {
            provider: conn.provider,
            connectionId: conn.connectionId,
            providerConfigKey: conn.providerConfigKey
          },
          businessTimezone: timezone
        });
        if (!turn.ok) {
          await recordSystemLog({
            businessId,
            source: "email",
            level: "warn",
            event: "email_coworker_turn_failed",
            message: `Email coworker could not answer ${message.fromEmail}: ${turn.detail}`,
            payload: { thread_id: thread.threadId, message_id: message.id }
          });
          continue;
        }
        // A sentinel-only escalation sends nothing: it counts as neither a
        // reply nor a spent turn, but the handoff below still runs.
        if (turn.sent) {
          result.replied += 1;
          // The reply is already out, so a bookkeeping failure must not abort
          // the pass: that would leave the count stale AND skip the remaining
          // businesses. Logged and carried in memory instead, which still
          // bounds this pass; a persistently failing write can overshoot the
          // daily cap across ticks, and losing a reply is the worse outcome.
          try {
            await recordThreadTurn(thread.id, {}, spent, db);
          } catch (err) {
            logger.warn("email-coworker: turn count write failed after sending", {
              businessId,
              threadId: thread.threadId,
              error: err instanceof Error ? err.message : String(err)
            });
          }
          // Keep the in-memory copy honest: several replies can land on one
          // thread in a single poll, and each must count against the budget.
          thread.turns = spent + 1;
          thread.turnsDay = new Date().toISOString().slice(0, 10);
        }

        // The model escalated. Its reply already told the correspondent a
        // colleague is coming, so the thread must actually change hands: no
        // further autonomous turns, and the owner hears about it once.
        if (turn.handoff) {
          await markThreadHandedOff(thread.id, db).catch((err: unknown) => {
            logger.warn("email-coworker: handoff write failed after escalating", {
              businessId,
              threadId: thread.threadId,
              error: err instanceof Error ? err.message : String(err)
            });
          });
          thread.handedOff = true;
          result.handedOff += 1;
          await dispatchUrgentNotification({
            businessId,
            summary: `Email needs you: ${thread.subject ?? "(no subject)"}`,
            kind: "email_coworker_handoff",
            payload: { thread_id: thread.threadId, from: message.fromEmail, reason: "escalated" },
            emailSubject: `Take over the email thread with ${message.fromEmail}`,
            emailBody:
              `Your coworker told ${message.fromEmail} that a colleague would follow up on ` +
              `"${thread.subject ?? "(no subject)"}" and stopped answering. Their message:\n\n` +
              message.bodyText.slice(0, 800),
            smsBody:
              `[Coworker] ${message.fromEmail} needs a person on: ` +
              `${thread.subject ?? "(no subject)"}`
          }).catch(() => {});
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("email-coworker: poll failed for business", { businessId, error: message });
      // recordFailure, not recordSystemLog: this poll runs every minute, so one
      // failure has already been retried by the time anyone could read it. Only
      // a failure that repeats inside the window reaches the fleet error feed.
      await recordFailure({
        businessId,
        source: "email",
        event: "email_coworker_poll_failed",
        message: `Email coworker poll failed: ${message}`,
        payload: providerFailureDetail(err)
      });
    }
  }

  return result;
}
