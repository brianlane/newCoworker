/**
 * Cross-channel customer memory summarizer.
 *
 * Generates a per-(business, customer_e164) rolling summary from:
 *   - existing summary_md (so consecutive runs are incremental)
 *   - recent voice call transcripts where caller_e164 matches
 *   - recent SMS turns where customer_e164 matches
 *
 * Calls the per-business Rowboat /chat agent in a stateless,
 * SUMMARIZER-MODE prompt, then persists the result on
 * customer_memories. Mirrors src/lib/dashboard-chat/summarizer.ts as
 * closely as practical so the behavior shape and failure modes are
 * familiar.
 *
 * Trigger gate (caller-side, fire-and-forget):
 *   memory.interaction_count >= 1 AND
 *   (last_summarized_at IS NULL OR now - last_summarized_at >= 30s)
 *
 * The 1-interaction threshold + 30s debounce was confirmed by the
 * owner: a summary needs to exist after the FIRST interaction so the
 * dashboard preamble has cross-channel continuity from the very next
 * turn. The 30s debounce still prevents this from preempting live
 * calls/texts (a flurry of inbound SMS within a single conversation
 * coalesces into one summarizer run, not three).
 *
 * Failures are swallowed and logged: a degraded summary is acceptable
 * and the next interaction's gate will retry. The summary is hard-
 * capped at SUMMARY_MAX_CHARS so persona bleed can't dominate the
 * preamble budget on every subsequent turn.
 */

import { getBusinessConfig } from "@/lib/db/configs";
import { logger } from "@/lib/logger";
import { resolveOutboundRowboatBearer } from "@/lib/rowboat/gateway-token";
import { callRowboatChat, type RowboatChatMessage } from "@/lib/rowboat/chat";
import { listVoiceTurnsForCustomer as defaultListVoiceTurns } from "@/lib/db/voice-transcripts";
import {
  listEmailLogForAddress as defaultListEmailLogForAddress,
  type EmailLogRow
} from "@/lib/db/email-log";
import {
  getCustomerMemory,
  listSmsHistoryForCustomer,
  updateCustomerSummary,
  type SmsHistoryEntry
} from "./db";
import type { CustomerMemoryRow } from "./types";

/** Hard cap on persisted summary text. */
export const SUMMARY_MAX_CHARS = 2000;

/** Interactions since last summary that trigger a fresh run. Set to
 * 1 so a customer's very first SMS or call produces a summary the
 * dashboard chat preamble can reference on the owner's next turn —
 * without it the preamble's "Recent customer activity" notes have no
 * cross-channel narrative and the owner sees the AI rediscover the
 * same customer for several turns. The 30s debounce
 * (`SUMMARY_DEBOUNCE_MS`) is the real shield against summarizer
 * spam, not the threshold. */
export const SUMMARY_INTERACTION_THRESHOLD = 1;

/** Debounce window — refuse to re-summarize within this many ms of the last run. */
export const SUMMARY_DEBOUNCE_MS = 30_000;

/** Looser than the chat path: fire-and-forget summarizer can afford a cold local model. */
export const SUMMARY_TIMEOUT_MS = 60_000;

/** Recent voice calls / SMS pulled into the summarizer prompt. */
export const SUMMARY_INPUT_VOICE_CALLS = 5;
export const SUMMARY_INPUT_SMS_TURNS = 30;
/**
 * Recent emails pulled in — but ONLY the ones to/from THIS contact's own
 * linked address (`customer_memories.email`). Never a business-wide mail
 * roll-up: the feed is `listEmailLogForAddress(businessId, memory.email)`, so
 * one customer's summary can never absorb another contact's correspondence.
 */
export const SUMMARY_INPUT_EMAILS = 10;

const SUMMARIZER_SYSTEM_INSTRUCTION = `SUMMARIZER MODE — DO NOT respond as the persona, agent, or assistant.

You will receive context about a customer's prior interactions with a business across SMS, voice, and email. Produce a concise factual digest the agent can use to maintain continuity in future interactions across any of those channels.

Output ONLY the summary text. Do NOT include preamble, sign-offs, or meta-commentary. Hard limit: ~${SUMMARY_MAX_CHARS} characters.

Cover, in order:
1. Identifying details the customer has shared (name, business, what they buy or want).
2. History of past interactions (high-level — what was discussed, what was promised, what was decided).
3. Stylistic preferences for replies (formal/casual, channel preference, do-not-call windows, etc.).
4. Open commitments or follow-ups still pending on either side.

Do NOT invent details. If the available context is sparse, output the shortest faithful summary possible. Never speculate about the customer's identity or motives beyond what the source material directly supports.`;

export type SummarizeFailureReason =
  | "memory_not_found"
  | "no_project_id"
  | "no_bearer"
  | "below_threshold"
  | "debounced"
  | "no_inputs"
  | "rowboat_failed"
  | "empty_summary"
  | "db_failed";

export type SummarizeResult =
  | {
      ok: true;
      summary: string;
      voiceTurnCount: number;
      smsTurnCount: number;
      emailCount: number;
      projectId: string;
    }
  | { ok: false; reason: SummarizeFailureReason; detail?: string };

export type SummarizeDeps = {
  callRowboatChat?: typeof callRowboatChat;
  getCustomerMemory?: typeof getCustomerMemory;
  listSmsHistoryForCustomer?: typeof listSmsHistoryForCustomer;
  /**
   * Voice transcripts feeder. Provided as a typed dep here (rather
   * than imported directly) so the production import doesn't pull
   * in voice-transcripts.ts in test runs that don't need it.
   */
  listVoiceTurnsForCustomer?: (
    businessId: string,
    customerE164: string,
    limit: number
  ) => Promise<VoiceTurnEntry[]>;
  /**
   * Email feeder. Scoped to the contact's own linked address — the production
   * default reads `email_log` for messages to/from that one address only.
   */
  listEmailLogForAddress?: typeof defaultListEmailLogForAddress;
  updateCustomerSummary?: typeof updateCustomerSummary;
  getBusinessConfig?: typeof getBusinessConfig;
  /** Pulled from process.env at call time by default; overridable for tests. */
  rowboatBearer?: string;
  /** Override now() for deterministic debounce testing. */
  now?: () => number;
};

export type VoiceTurnEntry = {
  callStartedAt: string;
  role: "caller" | "assistant";
  content: string;
};

/**
 * Decide whether to fire the summarizer based on a memory row's
 * counters. Pure helper so callers can gate without re-reading.
 */
export function shouldSummarize(
  memory: Pick<CustomerMemoryRow, "interaction_count" | "last_summarized_at">,
  now: number = Date.now()
): boolean {
  if (memory.interaction_count < SUMMARY_INTERACTION_THRESHOLD) return false;
  if (!memory.last_summarized_at) return true;
  const lastMs = Date.parse(memory.last_summarized_at);
  if (!Number.isFinite(lastMs)) return true;
  return now - lastMs >= SUMMARY_DEBOUNCE_MS;
}

function joinVoiceTurns(rows: VoiceTurnEntry[]): string {
  return rows
    .map((r) => {
      const label = r.role === "caller" ? "Customer" : "AI assistant";
      return `[${r.callStartedAt} VOICE ${label}]: ${r.content}`;
    })
    .join("\n");
}

function joinEmailHistory(rows: EmailLogRow[]): string {
  return rows
    .map((r) => {
      const who = r.direction === "inbound" ? "Customer" : "Business";
      const subject = (r.subject ?? "").trim();
      const body = (r.body_preview ?? "").trim();
      const subjectPart = subject ? ` "${subject}"` : "";
      return `[${r.created_at} EMAIL ${who}${subjectPart}]: ${body}`;
    })
    .join("\n");
}

function joinSmsHistory(rows: SmsHistoryEntry[]): string {
  return rows
    .flatMap((r) => {
      // Worker-initiated sends (AiFlow intros) have no inbound side; don't
      // emit an empty "Customer:" line for them.
      const lines: string[] = [];
      if (r.inboundText) {
        lines.push(`[${r.receivedAt} SMS Customer]: ${r.inboundText}`);
      }
      if (r.assistantReply) {
        lines.push(`[${r.receivedAt} SMS AI assistant]: ${r.assistantReply}`);
      }
      return lines;
    })
    .join("\n");
}

export async function summarizeCustomerMemory(
  businessId: string,
  customerE164: string,
  deps: SummarizeDeps = {}
): Promise<SummarizeResult> {
  /* c8 ignore start -- per-dep ?? fallbacks are exercised in production
     (no deps supplied) but tests inject every dep for hermeticity. */
  const _getCustomerMemory = deps.getCustomerMemory ?? getCustomerMemory;
  const _listSmsHistoryForCustomer = deps.listSmsHistoryForCustomer ?? listSmsHistoryForCustomer;
  const _getBusinessConfig = deps.getBusinessConfig ?? getBusinessConfig;
  const _callRowboatChat = deps.callRowboatChat ?? callRowboatChat;
  const _updateCustomerSummary = deps.updateCustomerSummary ?? updateCustomerSummary;
  const _now = deps.now ?? Date.now;
  /* c8 ignore stop */
  const bearer = deps.rowboatBearer ?? (await resolveOutboundRowboatBearer(businessId));

  let memory: CustomerMemoryRow | null;
  try {
    memory = await _getCustomerMemory(businessId, customerE164);
  } catch (err) {
    return {
      ok: false,
      reason: "db_failed",
      detail: err instanceof Error ? err.message : String(err)
    };
  }
  if (!memory) return { ok: false, reason: "memory_not_found" };

  // Re-check the gate inside the summarizer too. The fire-and-forget
  // caller can race with the nightly cron and a manual trigger from
  // the customers page — without this guard we'd happily run the
  // summarizer multiple times in parallel, wasting Rowboat capacity
  // and producing duplicate updated_at bumps.
  if (memory.interaction_count < SUMMARY_INTERACTION_THRESHOLD) {
    return { ok: false, reason: "below_threshold" };
  }
  if (memory.last_summarized_at) {
    const lastMs = Date.parse(memory.last_summarized_at);
    if (Number.isFinite(lastMs) && _now() - lastMs < SUMMARY_DEBOUNCE_MS) {
      return { ok: false, reason: "debounced" };
    }
  }

  let config: Awaited<ReturnType<typeof getBusinessConfig>>;
  try {
    config = await _getBusinessConfig(businessId);
  } catch (err) {
    return {
      ok: false,
      reason: "db_failed",
      detail: err instanceof Error ? err.message : String(err)
    };
  }
  /* c8 ignore next 4 -- defensive: a chat-eligible business has a project id;
     this fallback only fires in degraded states the summarizer doesn't crash on. */
  const projectId =
    config?.rowboat_project_id?.trim() ||
    process.env.ROWBOAT_DEFAULT_PROJECT_ID?.trim() ||
    "";
  if (!projectId) return { ok: false, reason: "no_project_id" };
  if (!bearer) return { ok: false, reason: "no_bearer" };

  let voiceTurns: VoiceTurnEntry[] = [];
  let smsHistory: SmsHistoryEntry[] = [];
  let emailHistory: EmailLogRow[] = [];
  try {
    const _listVoiceTurns =
      deps.listVoiceTurnsForCustomer ??
      (async (b: string, c: string, limit: number) => {
        const turns = await defaultListVoiceTurns(b, c, { maxCalls: limit });
        return turns.map((t) => ({
          // Default to ISO start of epoch on missing timestamps so the
          // summarizer prompt never embeds the literal string "null"
          // (which the model will echo back into its summary).
          callStartedAt: t.callStartedAt ?? "1970-01-01T00:00:00Z",
          role: t.role,
          content: t.content
        }));
      });
    voiceTurns = await _listVoiceTurns(
      businessId,
      customerE164,
      SUMMARY_INPUT_VOICE_CALLS
    );
    smsHistory = await _listSmsHistoryForCustomer(
      businessId,
      customerE164,
      { limit: SUMMARY_INPUT_SMS_TURNS }
    );
    // Email is pulled only when this contact has a linked address, and only
    // for THAT address — never a business-wide mailbox scan. Keeps the
    // cross-channel summary about this one person.
    const contactEmail = memory.email?.trim();
    if (contactEmail) {
      const _listEmailLogForAddress =
        deps.listEmailLogForAddress ?? defaultListEmailLogForAddress;
      emailHistory = await _listEmailLogForAddress(businessId, contactEmail, {
        limit: SUMMARY_INPUT_EMAILS
      });
    }
  } catch (err) {
    return {
      ok: false,
      reason: "db_failed",
      detail: err instanceof Error ? err.message : String(err)
    };
  }

  // If we have *no* fresh source material AND no prior summary, the
  // model has nothing to compress — abort rather than run an empty
  // prompt that might hallucinate.
  if (
    voiceTurns.length === 0 &&
    smsHistory.length === 0 &&
    emailHistory.length === 0 &&
    !memory.summary_md?.trim()
  ) {
    return { ok: false, reason: "no_inputs" };
  }

  const inputs: string[] = [];
  if (memory.summary_md?.trim()) {
    inputs.push("Existing rolling summary (carry forward; refine where the new evidence below contradicts it):");
    inputs.push(memory.summary_md.trim());
    inputs.push("");
  }
  if (voiceTurns.length > 0) {
    inputs.push("Recent voice call transcripts (oldest first):");
    inputs.push(joinVoiceTurns(voiceTurns));
    inputs.push("");
  }
  if (smsHistory.length > 0) {
    inputs.push("Recent SMS exchanges (oldest first):");
    inputs.push(joinSmsHistory(smsHistory));
    inputs.push("");
  }
  if (emailHistory.length > 0) {
    // email_log returns newest-first; flip to chronological so the digest
    // reads in conversation order like the SMS/voice sections.
    inputs.push("Recent emails with this contact (oldest first):");
    inputs.push(joinEmailHistory(emailHistory.slice().reverse()));
  }

  const summarizerMessages: RowboatChatMessage[] = [
    { role: "system", content: SUMMARIZER_SYSTEM_INSTRUCTION },
    {
      role: "user",
      content:
        `Update the rolling summary for customer ${memory.customer_e164}` +
        (memory.display_name ? ` (${memory.display_name})` : "") +
        `:\n\n${inputs.join("\n")}`
    }
  ];

  let reply: string;
  try {
    const parsed = await _callRowboatChat({
      businessId,
      projectId,
      bearer,
      messages: summarizerMessages,
      // Stateless: never reuse a continuation — we want a clean
      // summarizer turn untainted by chat-mode rolling state.
      conversationId: null,
      state: null,
      timeoutMs: SUMMARY_TIMEOUT_MS
    });
    reply = parsed.reply;
  } catch (err) {
    return {
      ok: false,
      reason: "rowboat_failed",
      detail: err instanceof Error ? err.message : String(err)
    };
  }

  const trimmed = reply.trim();
  if (!trimmed) return { ok: false, reason: "empty_summary" };
  const summary =
    trimmed.length > SUMMARY_MAX_CHARS ? trimmed.slice(0, SUMMARY_MAX_CHARS) : trimmed;

  try {
    await _updateCustomerSummary(
      businessId,
      customerE164,
      { summaryMd: summary, resetCounter: true }
    );
  } catch (err) {
    return {
      ok: false,
      reason: "db_failed",
      detail: err instanceof Error ? err.message : String(err)
    };
  }

  return {
    ok: true,
    summary,
    voiceTurnCount: voiceTurns.length,
    smsTurnCount: smsHistory.length,
    emailCount: emailHistory.length,
    projectId
  };
}

/**
 * Fire-and-forget wrapper. Logs structured success/failure, never
 * rejects. Use from inbound paths via
 * `void summarizeCustomerMemoryAndLog(...)`.
 */
export async function summarizeCustomerMemoryAndLog(
  businessId: string,
  customerE164: string,
  deps: SummarizeDeps = {}
): Promise<void> {
  let result: SummarizeResult;
  try {
    result = await summarizeCustomerMemory(businessId, customerE164, deps);
    /* c8 ignore start -- summarizeCustomerMemory already converts every
       internal throw into a structured { ok: false }. This catch only
       runs if a dependency injection itself throws synchronously. */
  } catch (err) {
    logger.warn("customer-memory summarizer threw unexpectedly", {
      businessId,
      customerE164,
      error: err instanceof Error ? err.message : String(err)
    });
    return;
  }
  /* c8 ignore stop */
  if (result.ok) {
    logger.info("customer-memory summarizer ok", {
      businessId,
      customerE164,
      projectId: result.projectId,
      voiceTurnCount: result.voiceTurnCount,
      smsTurnCount: result.smsTurnCount,
      emailCount: result.emailCount,
      summaryChars: result.summary.length
    });
  } else {
    // info-level for the gating skips (below_threshold / debounced)
    // since those are expected behavior not faults; warn for the rest.
    const isExpectedSkip = result.reason === "below_threshold" || result.reason === "debounced";
    const log = isExpectedSkip ? logger.info : logger.warn;
    log.call(logger, "customer-memory summarizer skipped/failed", {
      businessId,
      customerE164,
      reason: result.reason,
      detail: result.detail
    });
  }
}
