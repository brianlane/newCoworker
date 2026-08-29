/**
 * Platform-side Gemini responder for Messenger/Instagram DM conversations.
 *
 * Structural parity with the webchat engine (src/lib/webchat/gemini-engine):
 *
 *   * GROUNDING: buildAgentInstructions() over the SAME business_configs
 *     vault fields, plus a Messenger-specific preamble (platform, lead
 *     name, the conversation ref for lead capture, channel guidance).
 *   * TOOLS: the identical restricted customer-facing surface
 *     (knowledge lookup, lead capture, calendar find/book, document
 *     share) via executeWebchatEngineTool, including the SAME owner
 *     Settings gates, with lead capture swapped for the Messenger
 *     variant so attribution lands on the conversation row.
 *   * BUDGET: the shared AI spend fuse is checked BEFORE calling Google;
 *     over-cap turns refuse with the honest copy, and billed tokens meter
 *     into owner_chat_model_spend under surface "messenger_gemini_engine".
 *
 * Invoked by /api/internal/messenger-worker after it claims a job. Kept
 * engine-only: job/conversation persistence and the Send API call stay in
 * the worker.
 */

import {
  buildFunctionResponseContent,
  geminiChatStep,
  type GeminiChatContent,
  type GeminiChatStepParams,
  type GeminiChatStepResult
} from "@/lib/gemini-chat";
import { z } from "zod";
import { buildAgentInstructions } from "@/lib/vps/sync-vault";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import { scheduleTextTool } from "@/lib/sms/schedule-text";
import type { GeminiFunctionDeclaration } from "@/lib/gemini-chat";
import { customerLanguageLine, detectCustomerLanguage } from "@/lib/i18n/customer-language";
import {
  getBusinessCustomerLanguages,
  type BusinessCustomerLanguages
} from "@/lib/db/business-language";
import { getContactLanguage, type ContactLanguageRow } from "@/lib/db/contact-language";
import { getBusinessConfig, type ConfigRow } from "@/lib/db/configs";
import {
  getChatSpendSnapshotForBusiness,
  type ChatSpendSnapshot
} from "@/lib/db/chat-usage";
import { listBusinessDocuments, type BusinessDocumentRow } from "@/lib/documents/db";
import { buildDocumentsDigestMd } from "@/lib/documents/core";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import type { GeminiUsage } from "@/lib/gemini-generate-content";
import {
  executeWebchatEngineTool,
  WEBCHAT_TOOL_DECLARATIONS,
  type WebchatToolResult
} from "@/lib/webchat/engine-tools";
import { captureMessengerLead } from "@/lib/messenger/lead-capture";
import {
  contactBookingContextForPhone,
  type ContactBookingContext
} from "@/lib/ai-flows/contact-booking-context";
import {
  setMessengerConversationLanguage,
  type MessengerConversationRow,
  type MessengerMessageRow
} from "@/lib/messenger/db";
import type { PlanTier } from "@/lib/plans/tier";
import { logger } from "@/lib/logger";
import edgeEn from "../../../messages/edge-en.json";
import edgeEs from "../../../messages/edge-es.json";
import {
  NO_EM_DASH_PROMPT_LINE,
  US_SPELLING_PROMPT_LINE
} from "../../../supabase/functions/_shared/sms_prompt_lines";

/** Same honest copy as the webchat engine's over-cap refusal. */
export const MESSENGER_ENGINE_OVER_CAP_REFUSAL = edgeEn.MESSENGER_OVER_CAP;

/** Over-cap refusal in the thread's language (stored preferred_language). */
export function messengerOverCapRefusal(language?: "en" | "es" | null): string {
  return language === "es" ? edgeEs.MESSENGER_OVER_CAP : edgeEn.MESSENGER_OVER_CAP;
}

/**
 * Default history: 2.5-flash-lite → 2.5-flash (2026-07-16) after the Truly
 * SMS incident (Jul 14, ignored a system preamble containing the answer)
 * and the KYP Ads dashboard-chat session (Jul 15, context-blind
 * non-sequiturs and invented policy), Messenger is a conversational
 * lead-qualification surface, same stakes as SMS. Bumped again 2.5-flash →
 * gemini-3.5-flash-lite (GA 2026-07-21): SAME list price ($0.30/$2.50 per
 * 1M, priced in _shared/chat_spend_cap.ts + src/lib/billing/ai-spend-meter.ts),
 * far stronger context-following, 350 tok/s, matching the SMS/owner chat
 * default bump. Webchat deliberately stays on 2.5-flash-lite (anonymous
 * public traffic; 3.5-flash-lite is 3-6x its price).
 */
export const MESSENGER_ENGINE_DEFAULT_MODEL = "gemini-3.5-flash-lite";

export function messengerEngineModel(
  env: Record<string, string | undefined> = process.env
): string {
  return env.MESSENGER_GEMINI_ENGINE_MODEL?.trim() || MESSENGER_ENGINE_DEFAULT_MODEL;
}

/** Tool rounds per turn (each round may carry several parallel calls). */
export const MESSENGER_ENGINE_MAX_TOOL_ROUNDS = 4;

/** Whole-turn deadline, the worker route budget leaves headroom. */
export const MESSENGER_ENGINE_TURN_TIMEOUT_MS = 30_000;

/** History window handed to the model (rapid leads write many rows). */
export const MESSENGER_ENGINE_HISTORY_LIMIT = 20;

const PLATFORM_LABELS: Record<MessengerConversationRow["platform"], string> = {
  messenger: "Facebook Messenger",
  instagram: "Instagram Direct Messages",
  whatsapp: "WhatsApp"
};

/** Booking-context lookup budget, a Calendly hiccup must not stall a DM. */
export const MESSENGER_BOOKING_CONTEXT_TIMEOUT_MS = 5_000;

/**
 * The phone the booking-status lookup may trust for this conversation:
 * WhatsApp's `psid` IS the Meta-verified `wa_id` (digits of the sender's
 * real number, stronger than anything self-asserted, so it wins even when
 * a contact_phone was captured); Messenger/Instagram fall back to the
 * lead-captured contact_phone. Null = no usable identity, no lookup.
 */
export function messengerBookingPhone(
  conversation: Pick<MessengerConversationRow, "platform" | "psid" | "contact_phone">
): string | null {
  if (conversation.platform === "whatsapp") {
    const digits = conversation.psid.replace(/\D/g, "");
    // wa_ids are full international numbers (country code included).
    if (digits.length >= 7 && digits.length <= 15 && digits === conversation.psid.trim()) {
      return `+${digits}`;
    }
    return null;
  }
  const captured = (conversation.contact_phone ?? "").trim();
  return captured.length > 0 ? captured : null;
}

/**
 * The phone `schedule_text` may queue to from this conversation, or null
 * when the surface must not hold the tool at all. Stricter than the
 * booking lookup above on BOTH axes: only WhatsApp qualifies (the wa_id is
 * Meta-verified possession of the number; a captured contact_phone on
 * Messenger/Instagram is self-asserted, the same stranger-typed-a-number
 * shape that keeps the tool off web chat), and only a NANP (+1) number
 * does (our long codes cannot originate texts to non-US/CA numbers, so a
 * queued text to +52... would sit until dispatch and then silently skip,
 * which is the broken-promise class the tool exists to end).
 */
function messengerScheduleTextPhone(
  conversation: Pick<MessengerConversationRow, "platform" | "psid" | "contact_phone">
): string | null {
  if (conversation.platform !== "whatsapp") return null;
  const wa = messengerBookingPhone(conversation);
  return wa && /^\+1\d{10}$/.test(wa) ? wa : null;
}

/**
 * WhatsApp-only extra declaration next to the shared webchat set. No phone
 * parameter ON PURPOSE: the recipient is structurally this conversation's
 * verified wa_id (the executor injects it), so a prompt-injected "text my
 * friend at ..." has no path on this surface at all.
 */
const MESSENGER_SCHEDULE_TEXT_DECLARATION: GeminiFunctionDeclaration = {
  name: "schedule_text",
  description:
    "Queue ONE text message (SMS) to the person in this conversation for a LATER time, delivered to the WhatsApp number they are messaging from, never anyone else. Use when they ask for a reminder or a text at a future time. Say a later text is set ONLY after this returns ok, quoting the result's sendAtLocal. Only one queued text can be pending for them, scheduling again MOVES it (the result names the time it replaced). If it returns automatic_reminder_exists, an automation already texts them before their booked call: say so, and only re-call with confirmed true if they still want it. action cancel drops the pending queued text.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "schedule (default) or cancel." },
      sendAtIso: {
        type: "string",
        description:
          "When to send, ISO 8601 WITH a timezone offset (e.g. 2026-08-31T18:30:00-04:00). Required for schedule."
      },
      text: {
        type: "string",
        description: "Plain-text message body, at most 1600 characters. Required for schedule."
      },
      confirmed: {
        type: "boolean",
        description: "true ONLY after they re-confirm despite an automatic_reminder_exists result."
      }
    },
    required: []
  }
};

const messengerScheduleTextArgsSchema = z.object({
  action: z.enum(["schedule", "cancel"]).optional(),
  sendAtIso: z.string().max(64).optional(),
  text: z.string().max(1600).optional(),
  confirmed: z.boolean().optional()
});

/**
 * The per-turn system block: channel context + the conversation ref the
 * lead-capture tool passes back (webchat's sessionRef contract, so the
 * shared tool declarations work verbatim).
 */
export function buildMessengerPreamble(
  conversation: Pick<MessengerConversationRow, "id" | "platform" | "display_name">,
  now: Date,
  opts: { canScheduleText?: boolean } = {}
): string {
  const lines = [
    `[Messenger] You are replying on ${PLATFORM_LABELS[conversation.platform]} as the business's assistant.`,
    conversation.display_name
      ? `The person you are talking to is ${conversation.display_name}.`
      : "The person's name is not known yet, ask naturally when it helps.",
    "Keep replies short, warm, and human, this is a casual chat surface, not email.",
    opts.canScheduleText
      ? "You cannot send email or an immediate SMS from this conversation. You CAN queue ONE text message (SMS) to this person for a LATER time with schedule_text, delivered to the number they are messaging from. A later text exists ONLY if schedule_text returned ok in this conversation, never promise one otherwise. If other follow-up outside this chat is needed, capture their phone number with the lead tool."
      : "You cannot send SMS or email from this conversation. If follow-up outside this chat is needed, capture their phone number with the lead tool.",
    // Grounded capture (messenger twin of the SMS worker's grounded-actions
    // line): the live e2e harness caught the model telling a visitor "I've
    // captured your number, someone will text you shortly" with NO
    // capture_lead call behind it, which silently loses the lead.
    "Recording a visitor's contact details for the team happens ONLY through the capture_lead tool, never tell them their details were noted, captured, or passed along unless that tool call succeeded in this conversation.",
    `sessionRef (pass verbatim to capture_lead): ${conversation.id}`,
    `Current datetime: ${now.toISOString()}`
  ];
  return lines.join("\n");
}

/**
 * Map transcript rows to Gemini contents (user stays user; assistant AND
 * owner replies are the model's side of the dialogue). Returns null when
 * the window holds no user turn to answer.
 */
export function buildMessengerContents(
  history: MessengerMessageRow[]
): GeminiChatContent[] | null {
  const window = history.slice(-MESSENGER_ENGINE_HISTORY_LIMIT);
  const contents: GeminiChatContent[] = [];
  let sawUser = false;
  for (const row of window) {
    const text = row.content.trim();
    if (!text) continue;
    if (row.role === "user") {
      sawUser = true;
      contents.push({ role: "user", parts: [{ text }] });
    } else {
      contents.push({ role: "model", parts: [{ text }] });
    }
  }
  if (!sawUser || contents.length === 0) return null;
  // Gemini requires the final content to be the user's; trailing model
  // rows (e.g. an owner reply after the queued message) mean there is
  // nothing new to answer.
  if (contents[contents.length - 1].role !== "user") return null;
  return contents;
}

export type RunMessengerGeminiTurnArgs = {
  businessId: string;
  conversation: MessengerConversationRow;
  /** Oldest-first transcript window (listMessengerMessages output). */
  history: MessengerMessageRow[];
  tier: PlanTier | null;
};

export type MessengerGeminiTurnDeps = {
  fetchConfig?: (businessId: string) => Promise<ConfigRow | null>;
  fetchDocuments?: (businessId: string) => Promise<BusinessDocumentRow[]>;
  getSpendSnapshot?: (
    businessId: string,
    tier: PlanTier | null
  ) => Promise<ChatSpendSnapshot>;
  chatStep?: (params: GeminiChatStepParams) => Promise<GeminiChatStepResult>;
  executeTool?: (
    businessId: string,
    name: string,
    args: unknown
  ) => Promise<WebchatToolResult>;
  meter?: typeof meterGeminiSpendForBusiness;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  getCustomerLanguages?: (businessId: string) => Promise<BusinessCustomerLanguages>;
  persistConversationLanguage?: (
    conversationId: string,
    language: "en" | "es"
  ) => Promise<void>;
  fetchContactLanguage?: (
    businessId: string,
    customerE164: string
  ) => Promise<ContactLanguageRow>;
  /** Injectable booking-context lookup (tests). */
  fetchBookingContext?: (
    businessId: string,
    phoneE164: string
  ) => Promise<ContactBookingContext>;
  /** Booking lookup budget override (tests). */
  bookingContextTimeoutMs?: number;
  /** Injectable Settings gate for schedule_text (tests). */
  checkScheduleTextEnabled?: (businessId: string) => Promise<boolean>;
  /** Injectable schedule-text core (tests). */
  scheduleText?: typeof scheduleTextTool;
};

export type MessengerGeminiTurnResult = {
  reply: string;
  /** True when the shared AI budget refused the turn (no Gemini call). */
  refusedOverCap: boolean;
  toolRounds: number;
};

/**
 * Run one DM turn against Gemini directly.
 *
 * Throws (after metering whatever Google already billed) on:
 *   * `messenger_engine_no_key`, no GOOGLE_API_KEY/GEMINI_API_KEY in env
 *   * `messenger_engine_no_input`, no unanswered user turn in the window
 *   * `messenger_engine_no_reply`, the model never produced text
 *   * any `gemini_http_*` transport error from the step client
 * The caller maps a throw to the job's error path.
 */
export async function runMessengerGeminiTurn(
  args: RunMessengerGeminiTurnArgs,
  deps: MessengerGeminiTurnDeps = {}
): Promise<MessengerGeminiTurnResult> {
  /* c8 ignore start -- production default deps; tests inject explicit deps */
  const fetchConfig = deps.fetchConfig ?? getBusinessConfig;
  const fetchDocuments =
    deps.fetchDocuments ??
    ((businessId: string) => listBusinessDocuments(businessId));
  const getSpendSnapshot =
    deps.getSpendSnapshot ??
    ((businessId: string, tier: PlanTier | null) =>
      getChatSpendSnapshotForBusiness(businessId, undefined, tier));
  const chatStep = deps.chatStep ?? geminiChatStep;
  const executeTool =
    deps.executeTool ??
    ((businessId: string, name: string, toolArgs: unknown) =>
      executeWebchatEngineTool(businessId, name, toolArgs, {
        // Rollup attribution follows the conversation's platform:
        // whatsapp leads tag contacts 'whatsapp', Messenger/IG 'messenger'.
        captureLead: (bid, captureArgs) =>
          captureMessengerLead(bid, captureArgs, {
            channel: args.conversation.platform === "whatsapp" ? "whatsapp" : "messenger"
          })
      }));
  const meter = deps.meter ?? meterGeminiSpendForBusiness;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const getCustomerLanguages = deps.getCustomerLanguages ?? getBusinessCustomerLanguages;
  const persistConversationLanguage =
    deps.persistConversationLanguage ?? setMessengerConversationLanguage;
  const fetchContactLanguage = deps.fetchContactLanguage ?? getContactLanguage;
  const fetchBookingContext = deps.fetchBookingContext ?? contactBookingContextForPhone;
  const bookingTimeoutMs =
    deps.bookingContextTimeoutMs ?? MESSENGER_BOOKING_CONTEXT_TIMEOUT_MS;
  const checkScheduleTextEnabled =
    deps.checkScheduleTextEnabled ??
    // The texting coworker's own toggle governs later texts to customers on
    // every customer chat surface; there is no separate messenger agent card.
    ((businessId: string) => isAgentToolEnabled(businessId, "sms", "schedule_text"));
  const scheduleText = deps.scheduleText ?? scheduleTextTool;
  /* c8 ignore stop */

  const apiKey = env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY ?? "";
  if (!apiKey) throw new Error("messenger_engine_no_key");

  const contents = buildMessengerContents(args.history);
  if (!contents) throw new Error("messenger_engine_no_input");

  // Shared AI budget fuse FIRST, over-cap tenants must not bill Google.
  // Language resolution runs before the refusal below so a capped thread is
  // refused in the same language a normal reply would use (owner override,
  // stored thread language, or fresh detection), DB reads are fine here,
  // only Gemini calls are fused.
  const snapshot = await getSpendSnapshot(args.businessId, args.tier);
  const overCap = snapshot.spendMicros >= snapshot.effectiveCapMicros;

  const customerLanguages = await getCustomerLanguages(args.businessId);

  // WhatsApp-only later texts: a verified NANP wa_id AND the sms-channel
  // Settings toggle. When either fails the declaration is simply absent,
  // and the executor below fails closed for a hallucinated call anyway.
  const scheduleTextPhone = messengerScheduleTextPhone(args.conversation);
  // Statement form, not `x !== null && (await ...)`: an await inside a
  // logical expression leaves a phantom uncovered v8 branch (same class as
  // the awaited-default trap in the memory notes).
  let scheduleTextAllowed = false;
  if (scheduleTextPhone !== null) {
    scheduleTextAllowed = await checkScheduleTextEnabled(args.businessId);
  }
  const runScheduleText = async (toolArgs: unknown): Promise<WebchatToolResult> => {
    if (!scheduleTextAllowed || !scheduleTextPhone) {
      return { ok: false, detail: "tool_disabled" };
    }
    const parsed = messengerScheduleTextArgsSchema.safeParse(toolArgs);
    if (!parsed.success) {
      return { ok: false, detail: `invalid_args:${parsed.error.issues[0]?.message}` };
    }
    // Recipient injected, never model-chosen (see the declaration comment).
    return await scheduleText(args.businessId, {
      phone: scheduleTextPhone,
      action: parsed.data.action ?? "schedule",
      sendAtIso: parsed.data.sendAtIso,
      text: parsed.data.text,
      confirmed: parsed.data.confirmed
    });
  };

  // Owner override on the contact profile is authoritative across every
  // channel (same rule as the SMS worker). Only reachable once a phone was
  // captured for this thread; best-effort, a read blip must not kill the
  // turn.
  let ownerSetLanguage: "en" | "es" | null = null;
  if (args.conversation.contact_phone) {
    try {
      const contactLang = await fetchContactLanguage(
        args.businessId,
        args.conversation.contact_phone
      );
      if (contactLang.language_source === "owner_set") {
        ownerSetLanguage = contactLang.preferred_language;
      }
    } catch (err) {
      logger.warn("messenger engine: contact language read failed; continuing", {
        conversationId: args.conversation.id,
        error: String(err)
      });
    }
  }

  // Classify the latest user turn (sticky: the stored thread language wins
  // over a one-token confirmation) and persist confident detections so
  // later turns keep the thread language. `contents` being non-null above
  // guarantees the history contains a user row.
  const lastUserText = [...args.history].reverse().find((m) => m.role === "user")!.content;
  const detected = detectCustomerLanguage({
    text: lastUserText,
    establishedLanguage: ownerSetLanguage ?? args.conversation.preferred_language ?? undefined,
    defaultLanguage: customerLanguages.defaultLanguage,
    supported: customerLanguages.supported
  });
  if (
    !ownerSetLanguage &&
    detected.persist &&
    detected.language !== args.conversation.preferred_language
  ) {
    // Best-effort: a persistence blip must not kill the reply turn.
    try {
      await persistConversationLanguage(args.conversation.id, detected.language);
    } catch (err) {
      logger.warn("messenger engine: language persist failed; continuing", {
        conversationId: args.conversation.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // Owner override beats everything; otherwise a confident detection wins
  // over the stored thread language (mirrors the SMS worker): a mid-thread
  // switch in full sentences must not leave the prompt pointing at the old
  // language while the persisted row catches up. Weak signals ("si") already
  // return the established language from detectCustomerLanguage, so
  // stickiness is preserved.
  const threadLanguage =
    ownerSetLanguage ??
    (detected.persist ? detected.language : args.conversation.preferred_language ?? null);

  if (overCap) {
    return {
      reply: messengerOverCapRefusal(threadLanguage ?? detected.language),
      refusedOverCap: true,
      toolRounds: 0
    };
  }

  // Booking-status line (parity with the SMS worker's preamble): the
  // customer's Calendly state so "was my reschedule received?" gets an
  // informed answer instead of a confident denial. VERIFIED phone only,
  // WhatsApp's wa_id, or the captured contact_phone on Messenger/IG
  // (messengerBookingPhone). Bounded and fail-open: a hung or failing
  // Calendly lookup answers null and the reply proceeds without the line.
  const bookingPhone = messengerBookingPhone(args.conversation);
  const bookingStatusPromise: Promise<string | null> = bookingPhone
    ? Promise.race([
        fetchBookingContext(args.businessId, bookingPhone).then((ctx) => {
          const line = ctx.line?.trim();
          return line ? `Booking status: ${line}` : null;
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), bookingTimeoutMs))
      ]).catch((err) => {
        logger.warn("messenger engine: booking context failed; continuing without", {
          businessId: args.businessId,
          error: err instanceof Error ? err.message : String(err)
        });
        return null;
      })
    : Promise.resolve(null);

  // Grounding: agent instructions exactly as the vault sync seeds them,
  // then the channel preamble. Documents are best-effort (webchat
  // rationale: a digest failure must not kill the turn).
  const [config, documents, bookingStatus] = await Promise.all([
    fetchConfig(args.businessId),
    fetchDocuments(args.businessId).catch((err) => {
      logger.warn("messenger engine: document digest failed; continuing without", {
        businessId: args.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      return [] as BusinessDocumentRow[];
    }),
    bookingStatusPromise
  ]);
  const documentsMd = buildDocumentsDigestMd(documents, now());
  const instructions = buildAgentInstructions(
    {
      soul_md: config?.soul_md ?? "",
      identity_md: config?.identity_md ?? "",
      memory_md: config?.memory_md ?? "",
      website_md: config?.website_md ?? "",
      profile_md: config?.profile_md ?? ""
    },
    documentsMd
  );
  const systemInstruction = [
    instructions,
    customerLanguageLine({
      detected: detected.language,
      established: threadLanguage,
      defaultLang: customerLanguages.defaultLanguage,
      supported: customerLanguages.supported
    }),
    buildMessengerPreamble(args.conversation, now(), {
      canScheduleText: scheduleTextAllowed
    }),
    bookingStatus,
    // Platform-wide writing rule (README "NO EM DASHES"): AI output on every
    // surface carries the punctuation instruction.
    NO_EM_DASH_PROMPT_LINE,
    US_SPELLING_PROMPT_LINE
  ]
    .filter(Boolean)
    .join("\n\n");

  const model = messengerEngineModel(env);

  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), MESSENGER_ENGINE_TURN_TIMEOUT_MS);

  // Aggregate billed tokens across every step; meter ONCE in finally so a
  // mid-loop transport error still records what Google already billed.
  const usageTotal: GeminiUsage = { promptTokens: 0, outputTokens: 0 };
  let sawUsage = false;
  let outputCharsEstimate = 0;
  let toolRounds = 0;
  const inputChars =
    systemInstruction.length +
    args.history.reduce((sum, m) => sum + m.content.length, 0);

  try {
    for (let round = 0; round <= MESSENGER_ENGINE_MAX_TOOL_ROUNDS; round++) {
      const isFinalRound = round === MESSENGER_ENGINE_MAX_TOOL_ROUNDS;
      const step = await chatStep({
        apiKey,
        model,
        systemInstruction,
        contents,
        // Withhold tools on the last round so the model MUST produce text
        // instead of requesting a call nobody will execute.
        tools: isFinalRound
          ? []
          : scheduleTextAllowed
            ? [...WEBCHAT_TOOL_DECLARATIONS, MESSENGER_SCHEDULE_TEXT_DECLARATION]
            : WEBCHAT_TOOL_DECLARATIONS,
        temperature: 0.3,
        // Gemini 3 defaults to dynamic thinking that bills as output AND
        // counts against the (default 1500) output cap, unconstrained it
        // can eat the whole budget and surface as messenger_engine_no_reply.
        // "low" keeps a little reasoning for tool choice at DM latency.
        // Gated on the family: Gemini 2.5 rejects thinkingLevel.
        ...(/^gemini-3/i.test(model) ? { thinkingLevel: "low" as const } : {}),
        signal: abort.signal
      });
      if (step.usage) {
        usageTotal.promptTokens += step.usage.promptTokens;
        usageTotal.outputTokens += step.usage.outputTokens;
        sawUsage = true;
      }
      if (step.text) outputCharsEstimate += step.text.length;

      if (step.functionCalls.length > 0 && step.modelContent && !isFinalRound) {
        toolRounds += 1;
        const results: Array<{ name: string; response: unknown }> = [];
        for (const call of step.functionCalls) {
          let result: WebchatToolResult;
          try {
            result =
              call.name === "schedule_text"
                ? await runScheduleText(call.args)
                : await executeTool(args.businessId, call.name, call.args);
          } catch (err) {
            // One broken tool must not kill the turn, the model gets a
            // structured failure to explain.
            logger.warn("messenger engine: tool handler failed", {
              businessId: args.businessId,
              tool: call.name,
              error: err instanceof Error ? err.message : String(err)
            });
            result = { ok: false, detail: "internal_error" };
          }
          results.push({ name: call.name, response: result });
        }
        contents.push(step.modelContent);
        contents.push(buildFunctionResponseContent(results));
        continue;
      }

      if (step.text && step.text.trim().length > 0) {
        return { reply: step.text.trim(), refusedOverCap: false, toolRounds };
      }
      // No text and no executable calls: an empty/thinking-only step.
      throw new Error("messenger_engine_no_reply");
    }
    /* c8 ignore next 2 -- unreachable: the isFinalRound step always hits a return/throw */
    throw new Error("messenger_engine_no_reply");
  } finally {
    clearTimeout(deadline);
    const billedSomething = sawUsage
      ? usageTotal.promptTokens + usageTotal.outputTokens > 0
      : outputCharsEstimate > 0 || toolRounds > 0;
    if (billedSomething) {
      // meterGeminiSpendForBusiness is best-effort and never throws.
      await meter({
        businessId: args.businessId,
        model,
        surface: "messenger_gemini_engine",
        usage: sawUsage ? usageTotal : null,
        inputChars,
        outputChars: outputCharsEstimate
      });
    }
  }
}
