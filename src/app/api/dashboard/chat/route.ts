/**
 * Owner chat endpoint for /dashboard/chat — central-Gemini PRIMARY, VPS
 * chat-worker FALLBACK.
 *
 * POST   Resolve the turn's route (src/lib/dashboard-chat/routing.ts):
 *          - INLINE (primary): call central Gemini directly (function
 *            calling: create_aiflow / create_agent draft tools; native PDF
 *            attachment understanding), persist BOTH turns, and return the
 *            assistant reply in the response body. No VPS dependency.
 *          - WORKER (fallback): budget-exhausted turns (the worker owns the
 *            local-model degrade), a missing platform API key, or an inline
 *            failure — ENQUEUE a job exactly as before (PR #79 pipeline):
 *            the per-tenant VPS chat-worker (vps/chat-worker/) writes the
 *            assistant message back to dashboard_chat_messages and the
 *            browser sees it via Supabase Realtime / job polling.
 *          - REFUSE: attachment turns that can't run inline (attachments
 *            need the cloud model) get an honest stored reply.
 * GET    Hydrate the active thread + flag state for the client.
 * DELETE End the active thread so the next POST starts fresh.
 *
 * Auth: getAuthUser + requireBusinessRole(businessId, "operate_messages"). Kill switch (is_paused)
 * soft-blocks POST with a 409 so the UI can show a Resume CTA; Safe Mode
 * is deliberately NOT gated (the whole point is the owner stays online
 * while customer channels forward to their cell).
 *
 * Why we offload to a VPS worker instead of streaming on Vercel:
 * Vercel's Hobby plan caps a single function at maxDuration=300s and
 * Pro at 800s. Our local Rowboat sometimes takes 60-120s on the first
 * cold-tenant turn (vault load + Ollama page-in) and another 5-30s for
 * subsequent turns. ANY disconnect inside that window — Cloudflare
 * Tunnel hiccup, browser tab backgrounded, function eviction — meant
 * the assistant reply was generated on the VPS but never persisted,
 * because the route only wrote the message after the stream closed
 * cleanly. Three post-mortems (#76, #77, #78) couldn't close the
 * dropping-messages bug without a different architecture.
 *
 * Reliability contract (proven on srv1632631.hstgr.cloud before this
 * PR shipped — see PR #79):
 *   1. POST writes the user message + queues a job, both in <2s. The
 *      Vercel function returns immediately and is gone.
 *   2. The chat-worker (one per VPS) claims the job atomically via
 *      claim_chat_job() (FOR UPDATE SKIP LOCKED).
 *   3. Worker calls Rowboat in NON-streaming mode and waits for the
 *      full reply (4-30s typical, with up to 4 min of tolerance).
 *   4. Worker INSERTs the assistant message THEN marks the job done.
 *      A crash between those two writes leaves the job 'processing'
 *      with a stale claimed_at; reclaim_stale_chat_jobs() flips it
 *      back to 'queued' on the next sweep, so a restarted worker
 *      re-picks it up. The assistant message is never lost.
 *   5. Browser subscribes to dashboard_chat_messages Realtime keyed
 *      to thread_id and renders the reply the moment it lands.
 *
 * Wire shape (POST response body — single JSON envelope):
 *   {
 *     "ok": true,
 *     "data": {
 *       "threadId": "uuid",
 *       "activeThreadId": "uuid",
 *       "jobId": "uuid",
 *       "userMessageId": 123,
 *       "messages": [{ id, role, content, createdAt }, ...]
 *     }
 *   }
 *
 * The client uses `messages` to render the user's typed message
 * immediately (echo) and `jobId` as a polling-fallback key when
 * Realtime can't deliver the assistant message INSERT.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  appendMessage,
  deactivateActiveThread,
  getActiveThread,
  getOrCreateActiveThread,
  getThreadById,
  listMessages,
  reactivateThread,
  serializeChatMessages,
  touchChatActivity,
  type DashboardChatThreadRow
} from "@/lib/db/dashboard-chat";
import {
  getInFlightChatJobForThread,
  insertChatJob,
  type DashboardChatJobInputMessage
} from "@/lib/db/dashboard-chat-jobs";
// NOTE: summarizer triggers used to live here. They moved to the
// VPS chat-worker post-PR-#79 (which calls
// /api/internal/dashboard-chat/maybe-summarize after persisting the
// assistant message) so the summary build sees BOTH the user turn
// AND the assistant turn. Firing from the route would summarize a
// thread whose latest assistant turn hadn't been written yet —
// Bugbot Medium-severity finding on PR #79.
import { listCustomerMemories } from "@/lib/customer-memory/db";
import {
  buildDashboardCustomerPreamble,
  DASHBOARD_PREAMBLE_MAX_CUSTOMERS
} from "@/lib/customer-memory/dashboard-preamble";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import { getPublicWhatsAppConnection } from "@/lib/db/whatsapp-connections";
import { getChatSpendSnapshotForBusiness } from "@/lib/db/chat-usage";
import type { PlanTier } from "@/lib/plans/tier";
import { resolveChatTurnRoute } from "@/lib/dashboard-chat/routing";
import {
  runInlineChatTurn,
  type InlineChatDraft,
  type InlineTurnAttachment
} from "@/lib/dashboard-chat/inline-turn";
import {
  EMAIL_SEND_OPEN as EMAIL_BLOCK_OPEN,
  EMAIL_SEND_CLOSE as EMAIL_BLOCK_CLOSE,
  fulfillEmailBlocks
} from "@/lib/dashboard-chat/email-blocks";
import { captureOwnerRuleInline } from "@/lib/dashboard-chat/memory-capture";
import {
  buildBusinessContextBlock,
  buildIntegrationsStatusLine
} from "@/lib/dashboard-chat/context-blocks";
import { shouldSummarize, summarizeThread } from "@/lib/dashboard-chat/summarizer";
import { sendFromOwnerMailbox } from "@/lib/email/owner-mailbox";
import { recordOutboundAssistantEmail } from "@/lib/db/email-log";
import { getBusinessDocument } from "@/lib/documents/db";
import { BUSINESS_DOCS_BUCKET } from "@/lib/documents/core";
import { isSupportedDocumentMime, normalizeUploadMime } from "@/lib/documents/ingest";
import { logger } from "@/lib/logger";
import { currentDateTimeLine } from "../../../../../supabase/functions/_shared/datetime_line";
import { loadBusinessFlowActivity } from "../../../../../supabase/functions/_shared/ai_flows/run_context";

export const dynamic = "force-dynamic";

// The worker-fallback enqueue still returns in <2s, but the PRIMARY path
// now answers inline on central Gemini — and its create_aiflow tool can
// legitimately spend 1-2 minutes compiling + self-repairing a large
// automation. Budget the worst tool-loop case, not the enqueue case.
export const maxDuration = 300;

// 16k chars (~2-3 pages). The old 4000 cap silently clipped a pasted
// onboarding brief mid-sentence (KYP Ads, Jul 15) — owners paste long setup
// documents into chat, and the composer's maxLength truncated them with no
// signal. Bounded so a pathological paste can't balloon the prompt; the
// worker path's tail/summary caps are unchanged (the per-message tail clip
// keeps CPU prefill flat).
const MAX_MESSAGE_CHARS = 16_000;
const HISTORY_TURNS = 20;
// How many recent messages to replay verbatim as the "recent conversation
// context" system block on EVERY turn (including continuation turns). Kept
// small so we don't balloon CPU prefill on the per-tenant model — the box
// is CPU-only and prefill cost tracks real prompt size — while still giving
// the model deterministic recall of what was just said. The stateless-retry
// fallback uses the full HISTORY_TURNS tail instead (no conversationId, so
// it needs maximum local context). 8 messages ≈ the last ~4 turns.
const RESEND_TAIL_MESSAGES = 8;

// Character caps on the verbatim recent-tail transcript. The tail is bounded
// by message COUNT above, but a few long turns (e.g. a multi-bullet "saved to
// your business memory" recap, which can run ~1.8k chars) still balloon the
// prompt — and on the CPU-only per-tenant model, prefill time tracks REAL
// prompt size. That is what pushed a live job past the 4-minute Rowboat
// timeout (twice, incl. the 20-message stateless retry) in June 2026. Capping
// characters preserves recall of WHAT was just said while bounding cost; the
// rolling thread summary (a separate system block) carries older/longer
// context. Applied to BOTH the primary and stateless-retry variants.
const TAIL_MESSAGE_MAX_CHARS = 700;
const TAIL_TRANSCRIPT_MAX_CHARS = 3500;

/**
 * Render the recent-turn tail as a single transcript string, bounded by both
 * a per-message cap (TAIL_MESSAGE_MAX_CHARS) and a total cap
 * (TAIL_TRANSCRIPT_MAX_CHARS). Walks newest→oldest so the most recent turns
 * always survive the budget, then restores chronological order. The single
 * newest message is always included (already per-message capped) even if it
 * alone exceeds the total budget.
 */
export function renderTailTranscript(
  tail: { role: "user" | "assistant" | "system"; content: string }[]
): string {
  const labelFor = (role: "user" | "assistant" | "system"): string =>
    role === "user" ? "Owner" : role === "assistant" ? "Coworker" : "System";
  const picked: string[] = [];
  let used = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i];
    let content = m.content ?? "";
    if (content.length > TAIL_MESSAGE_MAX_CHARS) {
      content = `${content.slice(0, TAIL_MESSAGE_MAX_CHARS)}… (truncated)`;
    }
    const line = `[${labelFor(m.role)}]: ${content}`;
    if (picked.length > 0 && used + line.length > TAIL_TRANSCRIPT_MAX_CHARS) {
      break;
    }
    picked.push(line);
    used += line.length + 2;
  }
  return picked.reverse().join("\n\n");
}

const DASHBOARD_CHAT_RATE = { interval: 5 * 60 * 1000, maxRequests: 30 };

const postBodySchema = z.object({
  businessId: z.string().uuid(),
  // Optional: when present, the POST targets that specific thread —
  // reactivating it (deactivating the previously-active one) so the
  // user can continue any past conversation, ChatGPT/Claude/Gemini-
  // style. When omitted, the legacy "use active thread or create one"
  // path runs. We accept any uuid here and gate ownership against the
  // resolved row's business_id (NOT this body's businessId) so a
  // stolen threadId can't be reactivated under a different tenant.
  threadId: z.string().uuid().optional(),
  message: z
    .string()
    .trim()
    .min(1, "Message is empty")
    .max(MAX_MESSAGE_CHARS, `Message is too long (max ${MAX_MESSAGE_CHARS} chars)`),
  // Optional: run this turn against an existing business document (the
  // stored original is attached to the inline Gemini call). Fresh uploads
  // arrive as multipart form data instead — see POST.
  documentId: z.string().uuid().optional()
});

/** Fresh chat attachments share the documents pipeline's 10 MB budget. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const businessIdSchema = z.string().uuid();

function businessIdFromUrl(request: Request): string {
  const url = new URL(request.url);
  const id = url.searchParams.get("businessId") ?? "";
  return businessIdSchema.parse(id);
}

type BusinessFlags = {
  id: string;
  is_paused: boolean;
  customer_channels_enabled: boolean;
  /** IANA timezone for the date/time preamble; null = UTC fallback. */
  timezone: string | null;
  /** Plan tier — drives the shared AI-budget cap the routing check reads. */
  tier: PlanTier | null;
};

async function loadBusinessFlags(businessId: string): Promise<BusinessFlags | null> {
  const db = await createSupabaseServiceClient();
  const { data } = await db
    .from("businesses")
    .select("id, is_paused, customer_channels_enabled, timezone, tier")
    .eq("id", businessId)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id as string,
    is_paused: Boolean(data.is_paused),
    customer_channels_enabled: data.customer_channels_enabled !== false,
    timezone: typeof data.timezone === "string" ? data.timezone : null,
    tier: typeof data.tier === "string" ? (data.tier as PlanTier) : null
  };
}

/**
 * The single source of truth for "who is the dashboard chat agent
 * talking to right now". Without this, the per-tenant Rowboat agent
 * (whose persona is built for inbound customer conversations on SMS
 * and voice) defaults to treating EVERY incoming message as if it
 * came from a customer — see screenshot in PR #74 conversation:
 * the owner asked "has anyone reached out looking to buy a home?"
 * and the agent replied with "I'd be happy to help you qualify a
 * new buyer lead — share your contact details, property address,
 * timeline...", which is the lead-intake script aimed at customers.
 *
 * The fix is a strong, ALWAYS-FIRST system preamble that:
 *
 *   (1) Establishes that this user is the BUSINESS OWNER, not a
 *       customer. The model needs explicit permission to drop the
 *       customer-facing playbook.
 *   (2) Tells the agent its role on this surface: it's the owner's
 *       internal AI assistant — review customer activity, surface
 *       trends, summarize conversations, answer business questions.
 *       This is intentionally distinct from the persona used on the
 *       customer channels (where the agent IS the business's
 *       receptionist).
 *   (3) Reminds the agent it can use tools/context the owner can't
 *       see directly (recent customer activity preamble, rolling
 *       thread summary) but must be honest about what's NOT in
 *       context — never invent customer details, never claim to
 *       have done things it didn't do.
 *   (4) Authorizes the agent to share customer PII (phone numbers,
 *       timestamps, transcript text) with the owner — pre-streaming
 *       the model invented privacy/compliance refusals on its own
 *       (see PR #75 screenshot: owner asked for phone numbers, model
 *       refused citing "compliance"). The owner has full read access;
 *       the only restriction is "don't fabricate".
 *
 * Always pinned as message[0] so even on a stateless Rowboat call
 * (continuation evicted) the very first thing the agent reads is
 * "you are the owner's assistant".
 */
const OWNER_PREAMBLE = `OWNER MODE — READ FIRST

You are talking to the business OWNER on the /dashboard/chat surface. The owner runs this business and configured you. They are NOT a customer or lead — never ask them for contact info, address, timeline, or budget (that lead-intake script is only for your customer-facing SMS/voice channels). Here you are the owner's internal assistant: summarize and explain their customers' recent SMS/voice activity, answer questions about the business's setup/memory/identity, and suggest improvements. Be candid — admit when you lack data instead of inventing it.

OWNER HAS FULL VISIBILITY. The owner has full read access to every customer interaction — phone numbers, timestamps, message bodies, call transcripts. None of it is private from the owner. When asked "what's the number" or "what time did they call", quote the exact value from your "Recent customer activity" notes (real data summarizing actual SMS/voice contacts). Don't volunteer customer PII unprompted, but answer accurately when asked directly. Do NOT invent privacy or compliance reasons to refuse the owner — the only limit is that you must not state details that aren't actually in your context.

YOUR OWN CONFIGURATION IS YOURS TO SHARE. Your memory, identity, soul, routing rules, team roster, agent names and phone numbers, scripts, and hours are the owner's own data — NOT confidential PII. Never say you "don't have access" or tell the owner to "check their CRM"; answer directly and quote from your memory, and restate things you said earlier. Re-read your CURRENT memory each time — do not assume a value is still missing because it was unavailable in the past or in an earlier example; contacts the owner has added since are in your memory now. When the owner uses a first name, nickname, or shortened form, match it to the closest full name in your roster/memory before answering (e.g. treat "Gabby" as your "Gabrielle", "Dave" as your "David", "Mike" as your "Michael"). Only call a value missing when it is genuinely absent now, and then name only the part that is absent. Never refuse or deflect when the answer is in your own configuration.

NO FABRICATION (CUSTOMER DETAILS). If your "Recent customer activity" notes lack a specific CUSTOMER detail (a city like "Scottsdale", an exact time, a message body, the property they asked about), say so: "I don't have that detail in my notes — check /dashboard/calls or /dashboard/messages for the full record." Never invent specifics or paraphrase "wants to buy a home" into "3-bedroom in Scottsdale". (This caution is about customer data you weren't given — NOT your own configuration above, which you SHOULD share freely.)

DATES IN NOTES MAY BE STALE. Customer summaries and notes were written on earlier days, so relative phrases inside them ("tomorrow", "next week") were relative to WHEN THEY WERE WRITTEN, not to now. Never repeat a relative date from a note verbatim. Restate every scheduled event in absolute terms (e.g. "July 14 at 1:00 PM EDT"), cross-check it against the current date/time you were given, and say clearly when something is happening TODAY or has already passed.

CUSTOMER NAMES. The name on a customer's header line in your "Recent customer activity" notes is the owner's own label for that contact and is authoritative. When a summary or pinned excerpt beneath it uses a different or fuller name, ALWAYS refer to the customer by the header name.

TOOL RESULTS ARE THE TRUTH. When you call a tool, report what it ACTUALLY returned. If it says it did not update, did not send, or was refused, say so plainly and suggest what the owner can do instead — never claim an action happened when the tool result says otherwise, and never claim an action happened without a tool result confirming it. When you send a text or email, state the EXACT body that was sent (e.g. 'I texted +1514…: "This is a test message."') — never a bare "it has been sent". If the owner says a message didn't arrive and asks you to resend, resend the SAME intended message — never your own previous chat reply.

YOUR CHANNELS ARE SMS TEXTING, PHONE CALLS, AND EMAIL — NOTHING ELSE. You cannot send or receive WhatsApp, Telegram, or any other messaging-app content, and you must never agree to reach anyone on those. If the owner asks for an unsupported channel, say plainly that it isn't supported today and offer SMS or email instead. If the owner says their number or address is changing or going away (e.g. relocating abroad), NEVER "note" the old value as the go-forward contact — ask for the concrete new number or address that should replace it.

AUTOMATIONS (AIFLOWS). The business's automations live at /dashboard/aiflows: triggers (an inbound text, an email, a webhook lead, a calendar event, a schedule) that run steps like sending texts/emails, waiting, tagging contacts, and notifying the owner. Never tell the owner you "can't access AI flows" — describe what AiFlows can do, point them to /dashboard/aiflows, and if you have the create_aiflow tool, offer to draft the automation from their plain-English description.

PRESENT YOUR OPTIONS, THEN DO WHAT THE OWNER PICKS. When the owner asks for something you can fulfil MORE THAN ONE WAY with the tools you actually have — doing it directly now, running an existing automation that covers it (check list_aiflows when you have it), scheduling it, or drafting it for their approval — present the viable options in ONE short reply with a word on the tradeoff, then execute exactly the option they choose. Example: "I can text Uday that confirmation right now, or run your 'Booking confirmation' automation which also handles the timing — which do you prefer?" Options must be real: never offer an action you lack a tool for, and if a matching automation is disabled, say it's awaiting their review at /dashboard/aiflows and offer the direct action instead. When only one way exists, just confirm and do it — don't manufacture choices. Never act without the owner's explicit choice in this conversation.

THE OWNER'S DECISIONS ARE THEIRS. When the owner pastes a list of questions, considerations, or options for THEM to decide (setup checklists, advisor notes, "things to think about"), walk through the items and ASK for their choices — never answer the questions on their behalf, never invent policies, contact details, or preferences they haven't stated, and never present your own assumptions as settled decisions.

BE PROACTIVE WITH TOOLS. When the owner asks how to do something you can do yourself with your tools (send a follow-up SMS or email, book/reschedule/cancel an appointment, share a document), don't answer with generic advice — propose the concrete action for the specific customer under discussion and offer a draft they can approve (e.g. "Want me to text Juhu a follow-up? Here's a draft: …"). Never close by offering to "find more general information".

PERSISTING RULES. When the owner states a durable preference or fact, the system captures it to their Memory automatically. Acknowledge naturally (e.g. "Got it."), but do NOT claim you saved, stored, or updated anything unless a tool result in THIS turn confirms the save — a separate step persists and confirms it. Point them to /dashboard/memory to review or edit. Never ask the owner for their own contact info or business details; they already configured all of that.`;

export { OWNER_PREAMBLE };

/**
 * Email tool protocol for the dashboard chat agent.
 *
 * Why a structured text block instead of a Rowboat workflow tool: the
 * owner-chat path executes NO Rowboat tool calls (the worker calls /chat
 * non-streaming and reads `turn.output`'s assistant text; tool fulfilment
 * only exists on the voice-bridge path). Teaching the model a deterministic
 * sentinel block and having the VPS chat-worker parse + fulfil it mirrors
 * the existing worker-side owner-memory capture design, works identically
 * on the Gemini agent and its local Qwen spend-cap twin, and needs no
 * workflow re-seed.
 *
 * MUST stay in lockstep with the parser in vps/chat-worker/email-tool.mjs
 * (worker path) and src/lib/dashboard-chat/email-blocks.ts (inline path) —
 * EMAIL_SEND_OPEN / EMAIL_SEND_CLOSE + field caps, which themselves match
 * the zod schema in /api/voice/tools/dashboard-email.
 */
export const EMAIL_SEND_OPEN = EMAIL_BLOCK_OPEN;
export const EMAIL_SEND_CLOSE = EMAIL_BLOCK_CLOSE;

export const EMAIL_TOOL_ENABLED_PREAMBLE = `EMAIL TOOL — ENABLED.

You can send email from the owner's connected mailbox. The platform sends it on your behalf; the "from" address is always the owner's connected account and cannot be changed. When the owner asks you to send an email, compose it and include this EXACT block in your reply, on its own lines:

${EMAIL_SEND_OPEN}
{"to": "recipient@example.com", "subject": "Subject line", "body": "Plain-text body"}
${EMAIL_SEND_CLOSE}

To copy others, add optional "cc" and/or "bcc" array fields of email addresses, e.g. {"to": "a@x.com", "cc": ["b@x.com"], "bcc": ["c@x.com"], "subject": "...", "body": "..."}.

Rules:
- Only include the block when the owner explicitly asks, in this conversation, for an email to be sent. Never invent recipients — use addresses the owner gave you (including any cc/bcc).
- Exactly one valid JSON object per block. Plain-text body only (use \\n for line breaks). Subject at most 150 characters; body at most 4000 characters. At most 10 cc and 10 bcc recipients. At most 3 such blocks per reply.
- Do NOT claim the email was sent. The platform sends it after your reply and appends the actual delivery result for the owner. Phrase your reply as "sending it now".`;

export const EMAIL_TOOL_DISABLED_PREAMBLE = `EMAIL TOOL — DISABLED.

You cannot send emails on this surface. If the owner asks you to send an email, do NOT pretend to send one and do NOT output any tool-call syntax — tell them plainly that email sending is turned off, and that they can enable the "Send email" tool under Settings → Coworker tools on the dashboard.`;

/**
 * Build the message array sent to Rowboat for one chat turn. Stored on
 * the job row so the worker can call Rowboat without re-running this
 * logic.
 *
 * Why we don't just replay the live tail of stored messages: Rowboat's
 * HTTP /chat endpoint validates the input `messages[]` with a Zod
 * schema that rejects plain `{ role: "assistant", content: string }`
 * objects (it expects agent/tool-shaped assistant rows produced by
 * Rowboat itself). Replaying our local assistant turns there always
 * 400s — see tests/integration/kvm-rowboat/rowboat-chat.ts for the
 * canonical contract: "Each leg sends only the new user message …
 * do not replay `{ role: 'assistant', content }`". So we instead:
 *
 *   - render the recent-turn tail as a single transcript-shaped *system*
 *     message so the model always has explicit continuity
 *     (`includeTailContext: true`).
 *
 * Why we now ALWAYS include the tail (vs. the old "omit on continuation,
 * trust Rowboat's conversationId replay" design): production showed the
 * small per-tenant model losing earlier turns on continuation — e.g. it
 * listed the team's agent roster on turn 1 then claimed "I don't have
 * access" two turns later (business 621a5b0d, June 2026). Root cause was
 * a thin 4k context + zero resent history, so cross-turn recall hinged
 * entirely on Rowboat replay the small model didn't reliably attend to.
 * Resending a BOUNDED recent tail (see RESEND_TAIL_MESSAGES) every turn
 * costs a little duplicate prefill but makes recall deterministic. The
 * stateless-retry variant still carries the FULL tail (it runs without a
 * conversationId, so it needs the maximum local context).
 *
 * The summary preamble (rolling-summary system message) and the new
 * user turn are always included.
 */
function buildRowboatChatMessages(args: {
  summaryMd: string | null;
  tail: { role: "user" | "assistant" | "system"; content: string }[];
  newUserMessage: string;
  includeTailContext: boolean;
  /**
   * Phase 4: optional "recent customers across SMS + voice" preamble.
   * Built by buildDashboardCustomerPreamble; null when the business
   * has no notable customers yet (first-time dashboard chat user).
   * Prepended BEFORE the rolling thread summary so it's the most
   * stable piece of ambient context — the thread summary is for
   * THIS owner conversation, the customer preamble is for the
   * world the owner is operating in.
   */
  customerPreamble?: string | null;
  /**
   * Whether the owner enabled the dashboard `send_email` tool (Settings →
   * Coworker tools). Drives WHICH email-tool system block is injected —
   * enabled teaches the EMAIL_SEND protocol; disabled explicitly forbids
   * pretending to send (the exact hallucination observed before this
   * existed: the model emitted fake tool_code JSON then claimed the email
   * was sent).
   */
  emailToolEnabled: boolean;
  /** Business IANA timezone for the date/time line; null/undefined = UTC. */
  businessTimezone?: string | null;
  /**
   * Per-turn connected-integrations ground truth (see
   * buildIntegrationsStatusLine). Null/omitted ⇒ no line.
   */
  integrationsLine?: string | null;
}): DashboardChatJobInputMessage[] {
  const out: DashboardChatJobInputMessage[] = [];
  // ALWAYS first: OWNER_PREAMBLE establishes that this is the
  // owner-facing surface so the agent never lapses into its
  // customer-receptionist script. Stronger than a soft hint because
  // we've seen it slip even after a turn or two on a fresh
  // continuation.
  out.push({ role: "system", content: OWNER_PREAMBLE });
  // Date awareness: without this the model cannot resolve "tomorrow at 2pm"
  // into the ISO times the calendar tools require. Business-local when the
  // owner set a timezone; UTC fallback otherwise.
  out.push({ role: "system", content: currentDateTimeLine(new Date(), args.businessTimezone) });
  out.push({
    role: "system",
    content: args.emailToolEnabled ? EMAIL_TOOL_ENABLED_PREAMBLE : EMAIL_TOOL_DISABLED_PREAMBLE
  });
  const integrationsLine = args.integrationsLine?.trim();
  if (integrationsLine) {
    out.push({ role: "system", content: integrationsLine });
  }
  const customerPreamble = args.customerPreamble?.trim();
  if (customerPreamble) {
    out.push({ role: "system", content: customerPreamble });
  }
  const summary = args.summaryMd?.trim();
  if (summary) {
    out.push({
      role: "system",
      content: `Conversation summary so far:\n\n${summary}`
    });
  }
  if (args.includeTailContext && args.tail.length > 0) {
    const transcript = renderTailTranscript(args.tail);
    out.push({
      role: "system",
      content: `Recent conversation context (the most recent prior turns of THIS conversation, included for your reference so you reliably remember what was already said — including anything YOU told the owner. Treat these as ground truth for "what we discussed" and respond as the assistant continuing this same thread):\n\n${transcript}`
    });
  }
  // [Dashboard] channel marker mirrors the [SMS]/[Call] markers used
  // on the customer channels — gives the agent a visible reminder
  // every turn that the human in front of it is the owner, not a
  // customer (defense in depth alongside OWNER_PREAMBLE).
  out.push({ role: "user", content: `[Dashboard] ${args.newUserMessage}` });
  return out;
}

/**
 * Telemetry for a text turn that could NOT run on the inline primary path
 * for a non-cap reason. The July 2026 dead-model incident (default id
 * `gemini-3.1-flash`, which does not exist on the Gemini API) demoted every
 * dashboard turn to the worker for days with zero platform signal — wire
 * dashboards/alerts to `dashboard_chat_inline_fallback`. Best-effort.
 */
async function emitInlineFallbackTelemetry(
  businessId: string,
  reason: "no_api_key" | "inline_failed",
  detail?: string
): Promise<void> {
  try {
    const db = await createSupabaseServiceClient();
    await db.rpc("telemetry_record", {
      p_event_type: "dashboard_chat_inline_fallback",
      p_payload: { business_id: businessId, reason, detail: detail ?? null }
    });
  } catch (err) {
    logger.warn("dashboard chat: inline fallback telemetry emit failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

// =====================================================================
// POST — write user message + enqueue a job + return 200
// =====================================================================

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    // Two wire shapes: JSON (plain turns + existing-document attachments)
    // and multipart form data (fresh file uploads). Both normalize into the
    // same body + optional upload.
    let body: z.infer<typeof postBodySchema>;
    let upload: { filename: string; mimeType: string; data: Buffer } | null = null;
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData().catch(() => null);
      if (!form) return errorResponse("VALIDATION_ERROR", "Expected multipart form data");
      body = postBodySchema.parse({
        businessId: form.get("businessId"),
        message: form.get("message"),
        ...(form.get("threadId") ? { threadId: form.get("threadId") } : {}),
        ...(form.get("documentId") ? { documentId: form.get("documentId") } : {})
      });
      const file = form.get("file");
      if (file instanceof File) {
        // normalizeUploadMime maps VTT transcripts (text/vtt, or a .vtt name
        // under a blank/octet-stream reported type) onto their canonical mime.
        const mimeType = normalizeUploadMime(file.type, file.name);
        if (!isSupportedDocumentMime(mimeType)) {
          return errorResponse(
            "VALIDATION_ERROR",
            "Only PDF, plain text, markdown, CSV, or VTT transcript attachments are supported"
          );
        }
        if (file.size === 0 || file.size > MAX_ATTACHMENT_BYTES) {
          return errorResponse("VALIDATION_ERROR", "Attachments must be between 1 byte and 10 MB");
        }
        upload = {
          filename: file.name.slice(0, 200) || "attachment",
          mimeType,
          data: Buffer.from(await file.arrayBuffer())
        };
      }
    } else {
      body = postBodySchema.parse(await request.json());
    }
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "operate_messages");

    const limiter = rateLimit(`dashboard-chat:${body.businessId}`, DASHBOARD_CHAT_RATE);
    if (!limiter.success) {
      // 429 Too Many Requests — preserved from the pre-Option-B
      // streaming route (Bugbot Low-severity finding on PR #79).
      // Clients/proxies may implement automatic backoff on 429
      // semantics that 409 doesn't carry. The CONFLICT error code
      // string is kept for backwards-compat with any error-code
      // matching on the client.
      return errorResponse(
        "CONFLICT",
        "Too many messages, please wait a minute.",
        429
      );
    }

    const flags = await loadBusinessFlags(body.businessId);
    if (!flags) return errorResponse("NOT_FOUND", "Business not found");

    if (flags.is_paused) {
      return errorResponse(
        "CONFLICT",
        "Your coworker is paused. Resume from the dashboard to chat."
      );
    }

    // Resolve the turn's attachment: a fresh upload wins; otherwise an
    // existing business document's stored ORIGINAL (full fidelity — not the
    // condensed content_md). Reads happen after the role gate above.
    let attachment: InlineTurnAttachment | null = upload;
    if (!attachment && body.documentId) {
      const document = await getBusinessDocument(body.businessId, body.documentId);
      if (!document) return errorResponse("NOT_FOUND", "Document not found");
      if (document.status !== "ready") {
        return errorResponse("VALIDATION_ERROR", "That document isn't ready to use yet");
      }
      if (!isSupportedDocumentMime(document.mime_type.trim().toLowerCase())) {
        return errorResponse(
          "VALIDATION_ERROR",
          "Only PDF, plain text, markdown, or CSV documents are supported"
        );
      }
      const db = await createSupabaseServiceClient();
      const { data: blob, error: downloadError } = await db.storage
        .from(BUSINESS_DOCS_BUCKET)
        .download(document.storage_path);
      if (downloadError || !blob) {
        logger.warn("dashboard chat: document attachment download failed", {
          businessId: body.businessId,
          documentId: document.id,
          error: downloadError?.message ?? "no data"
        });
        return errorResponse("INTERNAL_SERVER_ERROR", "Could not read the document file");
      }
      attachment = {
        filename: document.storage_path.split("/").pop() ?? document.title,
        mimeType: document.mime_type,
        data: Buffer.from(await blob.arrayBuffer())
      };
    }

    // Activity update fires BEFORE the turn runs so the VPS keep-warm timer
    // stands down. On the worker path the worker touches activity again on
    // success; the inline path re-touches after persisting the reply.
    await touchChatActivity(body.businessId);

    // Thread resolution. Two paths:
    //   1. Caller supplied threadId → continue (and reactivate if archived)
    //      that specific thread. Lets archived conversations be resumed
    //      without ceremony, ChatGPT/Claude/Gemini-style.
    //   2. No threadId → legacy behavior: use the active thread or mint
    //      a fresh one if none.
    let thread: DashboardChatThreadRow;
    if (body.threadId) {
      // IDOR guard: resolve the thread first, then verify it belongs
      // to the business in the body. Trusting body.businessId as the
      // ownership scope without the cross-check would let an
      // authenticated owner reactivate any thread on the platform by
      // pairing a guessed threadId with a businessId they own.
      const target = await getThreadById(body.threadId);
      if (!target) return errorResponse("NOT_FOUND", "Conversation not found");
      if (target.business_id !== body.businessId) {
        // Same response as a missing row so the caller can't
        // distinguish "not yours" from "doesn't exist" via timing.
        return errorResponse("NOT_FOUND", "Conversation not found");
      }
      if (!target.is_active) {
        await reactivateThread(body.businessId, body.threadId);
        // Re-read so downstream sees is_active=true and the freshest
        // updated_at; the in-memory copy from the lookup is now stale.
        thread = (await getThreadById(body.threadId)) ?? target;
      } else {
        thread = target;
      }
    } else {
      const title = body.message.slice(0, 140);
      thread = await getOrCreateActiveThread(body.businessId, title);
    }

    // Build the Rowboat input off the *persisted* history plus the just-
    // received user turn.
    const history = await listMessages(thread.id);
    const tail = history.slice(-HISTORY_TURNS);

    // Phase 4: pull recent customer memories so the dashboard agent has
    // ambient context about who the owner has been doing business with
    // across SMS and voice. Capped tightly so it doesn't dominate the
    // prompt. Failure here MUST NOT break the chat — degraded customer
    // awareness is acceptable; a 502 because we couldn't read 5 rows is
    // not.
    let customerPreamble: string | null = null;
    try {
      const memories = await listCustomerMemories(body.businessId, {
        limit: DASHBOARD_PREAMBLE_MAX_CUSTOMERS
      });
      customerPreamble = buildDashboardCustomerPreamble(memories);
    } catch (memErr) {
      logger.warn("dashboard chat: customer memory preamble lookup failed", {
        businessId: body.businessId,
        error: memErr instanceof Error ? memErr.message : String(memErr)
      });
    }

    // AiFlow context bridge (owner-facing variant): a digest of recent
    // automation runs so "did anyone reply to the Privyr flow?" gets a
    // grounded answer instead of a guess. Same failure posture as the
    // customer preamble: degraded awareness, never a failed turn.
    try {
      const db = await createSupabaseServiceClient();
      const flowActivity = await loadBusinessFlowActivity(db, body.businessId);
      if (flowActivity) {
        customerPreamble = customerPreamble
          ? `${customerPreamble}\n\n${flowActivity}`
          : flowActivity;
      }
    } catch (flowErr) {
      logger.warn("dashboard chat: flow activity preamble lookup failed", {
        businessId: body.businessId,
        error: flowErr instanceof Error ? flowErr.message : String(flowErr)
      });
    }

    const hasContinuation =
      typeof thread.rowboat_conversation_id === "string" &&
      thread.rowboat_conversation_id.trim().length > 0;

    // Settings → Coworker tools: decides which email-tool system block the
    // model sees this turn. Default OFF (registry); isAgentToolEnabled
    // resolves read errors to that default, so a DB blip degrades to "tool
    // disabled" rather than failing the turn. The adapter the worker calls
    // re-checks authoritatively before any mail leaves.
    const emailToolEnabled = await isAgentToolEnabled(
      body.businessId,
      "dashboard",
      "send_email"
    );

    // Same gate the Rowboat tool-call route checks before dispatching
    // dashboard_business_knowledge_lookup (default ON in the registry).
    // Read here so the inline path only declares the tool when allowed.
    const knowledgeToolEnabled = await isAgentToolEnabled(
      body.businessId,
      "dashboard",
      "business_knowledge_lookup"
    );

    // Action tools for the INLINE path (worker parity — the Rowboat
    // OwnerCoworker declares these same tools, gated per call by the
    // tool-call route). Each read resolves errors to the registry default.
    const [
      smsToolEnabled,
      whatsappToolEnabled,
      calFindEnabled,
      calBookEnabled,
      calRescheduleEnabled,
      calCancelEnabled,
      runAiflowEnabled
    ] = await Promise.all([
      isAgentToolEnabled(body.businessId, "dashboard", "send_sms"),
      isAgentToolEnabled(body.businessId, "dashboard", "send_whatsapp"),
      isAgentToolEnabled(body.businessId, "dashboard", "calendar_find_slots"),
      isAgentToolEnabled(body.businessId, "dashboard", "calendar_book_appointment"),
      isAgentToolEnabled(body.businessId, "dashboard", "calendar_reschedule_appointment"),
      isAgentToolEnabled(body.businessId, "dashboard", "calendar_cancel_appointment"),
      isAgentToolEnabled(body.businessId, "dashboard", "run_aiflow")
    ]);
    const actionToolGates = {
      send_sms: smsToolEnabled,
      // Declared only when a WhatsApp integration is actually connected —
      // the toggle alone shouldn't dangle a tool that can only fail.
      send_whatsapp:
        whatsappToolEnabled &&
        (await getPublicWhatsAppConnection(body.businessId).catch(() => null))?.is_active ===
          true,
      calendar_find_slots: calFindEnabled,
      calendar_book_appointment: calBookEnabled,
      calendar_reschedule_appointment: calRescheduleEnabled,
      calendar_cancel_appointment: calCancelEnabled,
      // One Settings toggle gates the pair: listing exists to serve running.
      list_aiflows: runAiflowEnabled,
      run_aiflow: runAiflowEnabled
    };

    // Two message arrays:
    //   * `inputMessages`: first attempt. ALWAYS includes a BOUNDED
    //     recent tail (last RESEND_TAIL_MESSAGES) as a system block so
    //     the model has deterministic recall of what was just said,
    //     even on continuation turns where Rowboat would otherwise be
    //     the sole keeper of history. (See buildRowboatChatMessages
    //     doc for why we stopped trusting conversationId replay alone.)
    //   * `statelessInputMessages`: fallback used by the worker on a
    //     STATELESS_RETRY_ERRORS-class failure. Includes the FULL
    //     HISTORY_TURNS tail because it's invoked WITHOUT a
    //     conversationId and Rowboat needs the context entirely from
    //     our prompt. Only built when we have a continuation to fall
    //     back FROM; on a fresh thread the first attempt is already
    //     stateless, so a second stateless call wouldn't help — we
    //     pass null so the worker's "no fallback" path kicks in.
    // The stored user message carries a visible attachment marker so the
    // history tail / summaries reflect what the turn was about (the actual
    // file content only ever feeds the inline Gemini call).
    const storedUserMessage = attachment
      ? `[Attached: ${attachment.filename}] ${body.message}`
      : body.message;

    // Connected-integrations ground truth for BOTH turn paths (the worker
    // agent's vault instructions describe the business, not its live
    // connections). Best-effort; null adds no block.
    const integrationsLine = await buildIntegrationsStatusLine(body.businessId);

    const inputMessages = buildRowboatChatMessages({
      summaryMd: thread.summary_md,
      tail: tail.slice(-RESEND_TAIL_MESSAGES),
      newUserMessage: storedUserMessage,
      includeTailContext: true,
      customerPreamble,
      emailToolEnabled,
      businessTimezone: flags.timezone,
      integrationsLine
    });
    const statelessInputMessages = hasContinuation
      ? buildRowboatChatMessages({
          summaryMd: thread.summary_md,
          tail,
          newUserMessage: storedUserMessage,
          includeTailContext: true,
          customerPreamble,
          emailToolEnabled,
          businessTimezone: flags.timezone,
          integrationsLine
        })
      : null;

    // === Turn routing: inline (central Gemini) primary, worker fallback ===
    // The spend read fails OPEN to inline (quality over fuse on a transient
    // DB blip — same posture as the worker's own cap read).
    const spend = await getChatSpendSnapshotForBusiness(
      body.businessId,
      undefined,
      flags.tier
    ).catch((spendErr) => {
      logger.warn("dashboard chat: spend snapshot read failed; routing inline", {
        businessId: body.businessId,
        error: spendErr instanceof Error ? spendErr.message : String(spendErr)
      });
      return null;
    });
    const apiKeyPresent = Boolean(process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY);
    const route = resolveChatTurnRoute({
      hasAttachment: attachment !== null,
      apiKeyPresent,
      spend
    });
    // Non-cap worker routing means the PRIMARY path is unavailable — make
    // that loud (over-cap worker routing is expected and stays silent).
    if (route.kind === "worker" && !apiKeyPresent) {
      void emitInlineFallbackTelemetry(body.businessId, "no_api_key");
    }

    // Persist the user message BEFORE running/enqueueing the turn. If the
    // turn fails for any reason the user's typed message is still saved —
    // they can retry without losing what they typed. Cheap insurance.
    const userMsg = await appendMessage(thread.id, "user", storedUserMessage);

    // Refusals (attachment turns that can't run inline) are stored like any
    // assistant reply so the thread stays coherent across devices.
    if (route.kind === "refuse") {
      return await finishInlineTurn({
        businessId: body.businessId,
        thread,
        userMsg,
        content: route.message,
        drafts: []
      });
    }

    if (route.kind === "inline") {
      // Prompt parity with the worker path: the same system blocks, joined
      // into Gemini's systemInstruction; the user turn is the marked message.
      // PLUS the business identity/memory block — the worker path carries
      // those inside the Rowboat agent's seeded instructions (vault sync),
      // so without this the primary path answered configuration questions
      // blind ("are you connected to Calendly?" guesses, invented policy).
      // Deliberately NOT added to inputMessages: the worker prompt already
      // has it agent-side, and duplicating it would balloon CPU prefill.
      const businessContextBlock = await buildBusinessContextBlock(body.businessId);
      const systemInstruction = [
        ...inputMessages.filter((m) => m.role === "system").map((m) => m.content),
        ...(businessContextBlock ? [businessContextBlock] : [])
      ].join("\n\n");
      const inline = await runInlineChatTurn({
        businessId: body.businessId,
        systemInstruction,
        userMessage: `[Dashboard] ${storedUserMessage}`,
        attachment,
        knowledgeToolEnabled,
        actionToolGates
      });

      if (inline.ok) {
        // Fulfil any EMAIL_SEND blocks platform-side (same protocol the
        // worker fulfils via the gateway adapter): the send re-checks the
        // Settings toggle authoritatively, and the stored reply is the
        // cleaned text + honest per-email outcomes.
        const emailOutcome = await fulfillEmailBlocks({
          content: inline.content,
          send: async (req) => {
            const enabled = await isAgentToolEnabled(body.businessId, "dashboard", "send_email");
            if (!enabled) return { ok: false, detail: "tool_disabled" };
            const sent = await sendFromOwnerMailbox(body.businessId, {
              toEmail: req.to,
              subject: req.subject,
              bodyText: req.body,
              ccEmails: req.cc,
              bccEmails: req.bcc
            });
            if (!sent.ok) return { ok: false, detail: sent.detail };
            await recordOutboundAssistantEmail({
              businessId: body.businessId,
              toEmail: req.to,
              subject: req.subject,
              bodyText: req.body,
              source: "dashboard_chat",
              providerMessageId: sent.messageId,
              ccEmails: req.cc,
              bccEmails: req.bcc
            });
            return { ok: true };
          }
        });
        return await finishInlineTurn({
          businessId: body.businessId,
          thread,
          userMsg,
          content: emailOutcome.content,
          drafts: inline.drafts,
          ownerMessageForCapture: body.message
        });
      }

      // Inline failed. Attachment turns have no fallback (the worker path
      // is text-only) — store an honest failure reply. Text turns fall
      // through to the worker enqueue below.
      logger.warn("dashboard chat: inline turn failed", {
        businessId: body.businessId,
        threadId: thread.id,
        error: inline.error,
        detail: inline.detail
      });
      if (attachment) {
        return await finishInlineTurn({
          businessId: body.businessId,
          thread,
          userMsg,
          content:
            "I couldn't read that attachment right now — please try again in a moment.",
          drafts: []
        });
      }
      // A dying primary path must be LOUD: the July 2026 dead-model id
      // (gemini-3.1-flash) demoted every text turn to the worker for weeks
      // with zero signal. Emitted only for turns that actually fall through
      // to the worker enqueue below (attachment turns store an inline
      // failure reply instead — they never demote). Best-effort.
      void emitInlineFallbackTelemetry(body.businessId, "inline_failed", inline.detail ?? inline.error);
    }

    // === Worker fallback: enqueue exactly as the pre-inline pipeline ===
    // Both convId and state are gated on hasContinuation rather than
    // blanket forwarded: if the stored convId is "" or whitespace,
    // hasContinuation is already false and statelessInputMessages is null
    // (no fallback). Forwarding "" anyway would have the worker call
    // Rowboat with an invalid empty conversationId and fail permanently.
    // NOTE: the worker still decides its own Gemini-vs-local routing at
    // claim time from live period spend (vps/chat-worker/worker.mjs) — the
    // route check above only decides inline vs worker, and over-cap turns
    // always land here so the cap lives in exactly one enforcement point.
    const job = await insertChatJob({
      businessId: body.businessId,
      threadId: thread.id,
      userMessageId: userMsg.id,
      inputMessages,
      statelessInputMessages,
      rowboatConversationId: hasContinuation
        ? thread.rowboat_conversation_id
        : null,
      rowboatState: hasContinuation ? thread.rowboat_state ?? null : null
    });

    // The summarizer runs on the worker side (after the assistant
    // message is persisted). We still need the post-user-message thread
    // state for the response body so the client can render the user's
    // echo + the existing history without an extra GET.
    const updated = await listMessages(thread.id);

    return successResponse({
      threadId: thread.id,
      activeThreadId: thread.id,
      mode: "worker",
      jobId: job.id,
      userMessageId: userMsg.id,
      messages: serializeChatMessages(updated)
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

/**
 * Persist an inline turn's assistant reply and run the post-turn tasks the
 * worker path performs after its own insert: thread bump, keep-warm touch,
 * fire-and-forget rolling-summary check, and (for real model replies)
 * fire-and-forget owner-rule memory capture. Returns the POST response.
 */
async function finishInlineTurn(args: {
  businessId: string;
  thread: DashboardChatThreadRow;
  userMsg: { id: number };
  content: string;
  drafts: InlineChatDraft[];
  /** The owner's raw message — presence enables memory capture. */
  ownerMessageForCapture?: string;
}): Promise<Response> {
  const assistantMsg = await appendMessage(args.thread.id, "assistant", args.content);

  const db = await createSupabaseServiceClient();
  const { error: threadErr } = await db
    .from("dashboard_chat_threads")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", args.thread.id);
  if (threadErr) {
    logger.warn("dashboard chat: thread bump failed", {
      threadId: args.thread.id,
      error: threadErr.message
    });
  }
  // Keep-warm touch at the END of the turn too (worker parity — the enqueue
  // path touches at claim AND completion).
  await touchChatActivity(args.businessId).catch(() => undefined);

  // Fire-and-forget rolling-summary check: both turns are persisted, so
  // this sees the complete exchange (the exact ordering the PR #79 worker
  // handoff was built to preserve). Self-healing — a dropped check just
  // runs on the next turn.
  void (async () => {
    try {
      const freshThread = await getThreadById(args.thread.id);
      if (!freshThread) return;
      const msgs = await listMessages(args.thread.id);
      if (!shouldSummarize(freshThread, msgs.length)) return;
      await summarizeThread(args.businessId, args.thread.id, {
        getThreadById: async () => freshThread,
        listMessages: async () => msgs
      });
    } catch (sumErr) {
      logger.warn("dashboard chat: inline summary check failed", {
        threadId: args.thread.id,
        error: sumErr instanceof Error ? sumErr.message : String(sumErr)
      });
    }
  })();

  // Fire-and-forget owner-rule capture (silent, best-effort — worker
  // parity; see src/lib/dashboard-chat/memory-capture.ts).
  if (args.ownerMessageForCapture) {
    void captureOwnerRuleInline({
      businessId: args.businessId,
      ownerMessage: args.ownerMessageForCapture,
      assistantReply: args.content
    });
  }

  const updated = await listMessages(args.thread.id);
  return successResponse({
    threadId: args.thread.id,
    activeThreadId: args.thread.id,
    mode: "inline",
    userMessageId: args.userMsg.id,
    assistantMessageId: assistantMsg.id,
    drafts: args.drafts,
    messages: serializeChatMessages(updated)
  });
}

// =====================================================================
// GET / DELETE — unchanged JSON envelope shape
// =====================================================================

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const businessId = businessIdFromUrl(request);
    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const flags = await loadBusinessFlags(businessId);
    if (!flags) return errorResponse("NOT_FOUND", "Business not found");

    const thread = await getActiveThread(businessId);
    const messages = thread ? await listMessages(thread.id) : [];
    // Re-attach the "thinking…" indicator after a refresh / navigation:
    // if the worker is still chewing on the active thread's latest turn,
    // surface the live job id so the client can resume watching it
    // (Realtime + poll) instead of the indicator vanishing on reload.
    const pendingJob = thread ? await getInFlightChatJobForThread(thread.id) : null;

    return successResponse({
      threadId: thread?.id ?? null,
      messages: serializeChatMessages(messages),
      isPaused: flags.is_paused,
      customerChannelsEnabled: flags.customer_channels_enabled,
      pendingJob: pendingJob
        ? { id: pendingJob.id, threadId: pendingJob.thread_id }
        : null
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const businessId = businessIdFromUrl(request);
    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    await deactivateActiveThread(businessId);
    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
