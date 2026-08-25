/**
 * One email coworker turn: read an inbound reply on a thread the assistant
 * owns, act on it (calendar tools), and answer inside the same thread.
 *
 * This is the email sibling of the owner-over-SMS operator turn: same
 * inline engine (runInlineChatTurn), different audience. The correspondent
 * is a THIRD PARTY (a prospect, or a prospect's assistant), not the owner,
 * so the tool surface is deliberately narrow: calendar lifecycle plus
 * business knowledge, and nothing that can text, silence, or reconfigure
 * anything. See EMAIL_SURFACE_BLOCK for the behavioral half of that.
 */

import { runInlineChatTurn } from "@/lib/dashboard-chat/inline-turn";
import {
  buildBusinessContextBlock,
  buildIntegrationsStatusLine
} from "@/lib/dashboard-chat/context-blocks";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import { sendFromMailboxConnection } from "@/lib/email/owner-mailbox";
import { recordOutboundAssistantEmail } from "@/lib/db/email-log";
import { NO_EM_DASH_PROMPT_LINE } from "../../../supabase/functions/_shared/sms_prompt_lines";
import { currentDateTimeLine } from "../../../supabase/functions/_shared/datetime_line";
import type { EmailCoworkerThread } from "@/lib/email-coworker/threads";
import type { InboxMessage } from "@/lib/email-coworker/mailbox";
import { bookingLinkPromptLine } from "@/lib/booking-page/prompt-line";
import { logger } from "@/lib/logger";

/**
 * Sentinel the model appends when it escalates. Stripped before sending;
 * its presence is what actually pulls a human in (marks the thread handed
 * off and alerts the owner), so "I am bringing in a colleague" cannot be an
 * empty promise. Same shape as the EMAIL_SEND protocol on the owner
 * surfaces: a deterministic marker beats classifying prose after the fact.
 */
export const NEEDS_HUMAN_SENTINEL = "<<NEEDS_HUMAN>>";

/** Strip the escalation sentinel, reporting whether it was there. */
export function splitHandoffSentinel(reply: string): { text: string; handoff: boolean } {
  if (!reply.includes(NEEDS_HUMAN_SENTINEL)) return { text: reply, handoff: false };
  return {
    text: reply.split(NEEDS_HUMAN_SENTINEL).join("").replace(/\n{3,}/g, "\n\n").trim(),
    handoff: true
  };
}

/**
 * The surface contract, exported so the live-AI e2e suite replays the EXACT
 * production string (same convention as SMS_SURFACE_BLOCK).
 *
 * The third-party rule is the load-bearing part: the Beth thread (Jul 2026)
 * is an executive assistant arranging a call for someone else, and booking
 * the ASSISTANT sends the invite and the video link to the wrong person.
 */
export const EMAIL_SURFACE_BLOCK = `THIS CONVERSATION IS OVER EMAIL, and the person writing is NOT the business owner. They are a customer, a prospect, or someone arranging on another person's behalf. You are answering inside a thread the business already started with them.

- Write like a person continuing that thread: a short plain-text email, no markdown, no bullet lists unless you are listing times, and a brief sign-off. Never greet them as if this were first contact.
- Whoever the meeting is FOR is the attendee, and that may NOT be the person emailing you. When an assistant arranges for their principal, book the PRINCIPAL: their name on the appointment and their email address on the invite, so the invitation and any video link reach the person actually attending. If you do not have that person's email, ask for it before booking.
- Always name the time zone for any time you mention, and when you know the other person's zone, give their local time.
- When a booking result carries a video meeting link, put that exact link in your reply, even when the calendar invitation goes to someone else. The person writing is usually coordinating and needs something they can forward. Never invent a link: use the one the tool returned, or say the invitation is on its way.
- Only state that something is booked, moved, or canceled after the matching tool call succeeded in this conversation. If a booking fails, say the time is no longer available and offer another, never blame a technical problem.
- You cannot send text messages, change any settings, or take any action beyond your calendar tools and this reply. If the request needs a person (pricing negotiation, anything you are unsure of, anything angry), say plainly that you are bringing in a colleague and stop there.
- Whenever you hand off to a person like that, end your reply with ${NEEDS_HUMAN_SENTINEL} on its own final line. It is removed before the email is sent and is how the team is actually pulled in, so a handoff without it is an empty promise. Never use it on a reply you handled yourself.`;

export type EmailTurnResult =
  | {
      ok: true;
      reply: string;
      handoff: boolean;
      /**
       * False when nothing was emailed: a reply consisting only of the
       * escalation sentinel still hands the thread to a human (the signal
       * must not be lost), but there is no body worth sending.
       */
      sent: boolean;
    }
  | { ok: false; detail: string };

/**
 * Wall-clock budget for the model half of one turn. Sized against the poll
 * route's 60s maxDuration: the reply send (and, on a booking turn, the
 * calendar writes it already made) has to finish inside what is left.
 */
export const EMAIL_TURN_BUDGET_MS = 40_000;

/**
 * The narrow tool set. Every owner-power tool is hard-false here, not
 * merely un-toggled: a prompt-injected email must not be able to text
 * anyone, flag a contact, or run an automation.
 */
async function emailToolGates(businessId: string) {
  const [find, book, reschedule, cancel, waitlist] = await Promise.all([
    isAgentToolEnabled(businessId, "email", "calendar_find_slots"),
    isAgentToolEnabled(businessId, "email", "calendar_book_appointment"),
    isAgentToolEnabled(businessId, "email", "calendar_reschedule_appointment"),
    isAgentToolEnabled(businessId, "email", "calendar_cancel_appointment"),
    isAgentToolEnabled(businessId, "email", "calendar_join_waitlist")
  ]);
  return {
    send_sms: false,
    send_whatsapp: false,
    calendar_find_slots: find,
    calendar_book_appointment: book,
    calendar_reschedule_appointment: reschedule,
    calendar_cancel_appointment: cancel,
    calendar_join_waitlist: waitlist,
    list_aiflows: false,
    run_aiflow: false,
    edit_aiflow: false,
    undo_aiflow_edit: false,
    generate_image: false,
    update_notification_preferences: false,
    flag_contact_spam: false,
    set_contact_reply_mode: false,
    // The correspondent here is a delegate or prospect, not the owner, so
    // this surface never holds roster CRUD.
    manage_employee: false,
    // Nor the owner's own tables, for the same reason and more sharply: a
    // prospect emailing in must never be able to read a table called
    // "Vendor pricing", let alone write to one.
    custom_table_list: false,
    custom_table_find_rows: false,
    custom_table_history: false,
    custom_table_add_row: false,
    custom_table_update_row: false,
    custom_table_delete_row: false,
    custom_table_undo: false,
    custom_table_create: false,
    custom_table_update_schema: false,
    custom_table_delete: false,
    custom_table_restore: false
  };
}

/** "Re: x" once, however many times the thread has bounced. */
export function replySubject(subject: string | null | undefined): string {
  const base = (subject ?? "").trim();
  if (!base) return "Re: your message";
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

/**
 * Build the turn's system instruction. Exported for the e2e replay, which
 * must exercise the real assembly rather than a paraphrase.
 */
export function buildEmailTurnSystem(args: {
  businessTimezone: string | null;
  correspondentEmail: string;
  subject: string | null;
  integrationsLine?: string | null;
  /** Public booking page hint (see booking-page/prompt-line.ts). */
  bookingLinkLine?: string | null;
  businessContextBlock?: string | null;
  now?: Date;
}): string {
  return [
    EMAIL_SURFACE_BLOCK,
    `You are replying to ${args.correspondentEmail}${args.subject ? ` on the thread "${args.subject}"` : ""}.`,
    NO_EM_DASH_PROMPT_LINE,
    currentDateTimeLine(args.now ?? new Date(), args.businessTimezone),
    args.integrationsLine ?? "",
    args.bookingLinkLine ?? "",
    args.businessContextBlock ?? ""
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/**
 * Run one turn and send the answer into the same thread. Returns the reply
 * text (for logging/tests) and whether the model handed off to a human.
 */
export async function runEmailCoworkerTurn(args: {
  thread: EmailCoworkerThread;
  message: InboxMessage;
  link: { connectionId: string; providerConfigKey: string; provider: "google" | "microsoft" };
  businessTimezone: string | null;
  now?: Date;
}): Promise<EmailTurnResult> {
  const { thread, message } = args;
  const businessId = thread.businessId;

  const [integrationsLine, businessContextBlock, gates, bookingLinkLine] = await Promise.all([
    buildIntegrationsStatusLine(businessId),
    // Deliberately WITHOUT the custom-tables digest: the correspondent here
    // is a prospect or a delegate, not the owner, so the names of the
    // owner's own tables and columns are none of their business. The table
    // tools are off on this surface for the same reason.
    buildBusinessContextBlock(businessId),
    emailToolGates(businessId),
    // The booking page link, so "just send me the calendar" from a
    // correspondent gets the real URL, never an invented one.
    bookingLinkPromptLine(businessId)
  ]);

  const systemInstruction = buildEmailTurnSystem({
    businessTimezone: args.businessTimezone,
    correspondentEmail: message.fromEmail,
    subject: thread.subject ?? message.subject,
    integrationsLine,
    bookingLinkLine,
    businessContextBlock,
    ...(args.now ? { now: args.now } : {})
  });

  const inline = await runInlineChatTurn({
    businessId,
    systemInstruction,
    userMessage: `[Email from ${message.fromEmail}] Subject: ${message.subject}\n\n${message.bodyText}`,
    // No builder UI on this surface, and no owner to hand a draft card to.
    includeCreationTools: false,
    knowledgeToolEnabled: await isAgentToolEnabled(
      businessId,
      "email",
      "business_knowledge_lookup"
    ),
    actionToolGates: gates,
    // MUST leave room under the poll route's 60s maxDuration for the reply
    // send that follows. Without a budget the engine would happily spend the
    // whole request on model steps, and the route would die after the
    // message was already marked seen: no reply, no retry.
    budgetMs: EMAIL_TURN_BUDGET_MS,
    flowEditSource: "ai_edit_email",
    flowEditActor: message.fromEmail,
    flowEditSurfaceKind: "text"
  });

  if (!inline.ok) {
    logger.warn("email-coworker: inline turn failed", {
      businessId,
      error: inline.error,
      detail: inline.detail
    });
    return { ok: false, detail: inline.detail ?? inline.error ?? "turn_failed" };
  }

  const { text: reply, handoff } = splitHandoffSentinel(inline.content.trim());
  if (!reply) {
    // Sentinel with no prose: there is nothing to email, but the escalation
    // it signals must still reach a person. Dropping it here would claim the
    // message, send nothing, and leave the thread live with no owner alert.
    if (handoff) return { ok: true, reply: "", handoff: true, sent: false };
    return { ok: false, detail: "empty_reply" };
  }

  const sent = await sendFromMailboxConnection(
    businessId,
    {
      provider: args.link.provider,
      providerConfigKey: args.link.providerConfigKey,
      connectionId: args.link.connectionId
    },
    {
      toEmail: message.fromEmail,
      subject: replySubject(thread.subject ?? message.subject),
      bodyText: reply,
      thread: {
        threadId: thread.threadId,
        inReplyToMessageRef: message.messageRef,
        providerMessageId: message.id
      }
    }
  );
  if (!sent.ok) return { ok: false, detail: sent.detail };

  await recordOutboundAssistantEmail({
    businessId,
    toEmail: message.fromEmail,
    subject: replySubject(thread.subject ?? message.subject),
    bodyText: reply,
    source: "email_coworker",
    fromEmail: sent.fromEmail,
    providerMessageId: sent.messageId,
    // The conversation, so this row can answer "have we already replied
    // here". Graph's /reply echoes no ids, so fall back to the thread we
    // replied into, which the caller already resolved.
    threadId: sent.threadId ?? message.threadId
  });

  return { ok: true, reply, handoff, sent: true };
}
