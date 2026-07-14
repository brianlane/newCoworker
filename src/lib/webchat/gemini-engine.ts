/**
 * Platform-side direct-Gemini responder for the website chat widget
 * (chat_widget_settings.reply_engine = 'gemini').
 *
 * Produces one webchat reply CENTRALLY — no tenant VPS involved — with
 * structural parity to the box-hosted WebchatCoworker path:
 *
 *   * GROUNDING: the system prompt is buildAgentInstructions() over the
 *     SAME business_configs vault fields (identity → profile → soul →
 *     website → documents digest → memory) that deploy-client.sh seeds
 *     into the Rowboat agent, plus the SAME per-turn system blocks the
 *     enqueue route pre-built into webchat_jobs.input_messages (webchat
 *     preamble, datetime line, sessionRef, visitor context, history tail).
 *   * TOOLS: the identical restricted webchat_* surface, executed by
 *     src/lib/webchat/engine-tools.ts against the same cores and the same
 *     per-tool owner Settings gates as /api/rowboat/tool-call.
 *   * BUDGET: the shared AI spend fuse is checked BEFORE calling Google
 *     (over-cap → the chat-worker's honest visitor-facing refusal; there
 *     is no local model centrally, so refusing mirrors the kvm1 worker
 *     semantics), and every billed token meters into
 *     owner_chat_model_spend via meterGeminiSpendForBusiness — the fuse,
 *     credit grants, and the spend-velocity watchdog all see one number.
 *
 * Invoked inline by /api/widget/poll after it claims a queued job (see
 * claimWebchatJobForPlatform). Kept engine-only: job/session persistence
 * stays in the route + db helpers.
 */

import {
  buildFunctionResponseContent,
  geminiChatStep,
  type GeminiChatContent,
  type GeminiChatStepParams,
  type GeminiChatStepResult
} from "@/lib/gemini-chat";
import { buildAgentInstructions } from "@/lib/vps/sync-vault";
import { getBusinessConfig, type ConfigRow } from "@/lib/db/configs";
import { getChatSpendSnapshotForBusiness, type ChatSpendSnapshot } from "@/lib/db/chat-usage";
import { listBusinessDocuments, type BusinessDocumentRow } from "@/lib/documents/db";
import { buildDocumentsDigestMd } from "@/lib/documents/core";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import type { GeminiUsage } from "@/lib/gemini-generate-content";
import {
  executeWebchatEngineTool,
  WEBCHAT_TOOL_DECLARATIONS,
  type WebchatToolResult
} from "@/lib/webchat/engine-tools";
import type { PlanTier } from "@/lib/plans/tier";
import { logger } from "@/lib/logger";

/** Same visitor-facing copy as the chat-worker's WEBCHAT_OVER_CAP_REFUSAL. */
export const WEBCHAT_ENGINE_OVER_CAP_REFUSAL =
  "Sorry — our chat assistant is temporarily unavailable. Please try again a bit later, or contact us directly and we'll be happy to help.";

/**
 * Default model matches the box path: WebchatCoworker is seeded with
 * $smsModel = SMS_CHAT_MODEL (default gemini-2.5-flash-lite in
 * deploy-client.sh) — same model, same answers.
 */
export const WEBCHAT_ENGINE_DEFAULT_MODEL = "gemini-2.5-flash-lite";

export function webchatEngineModel(
  env: Record<string, string | undefined> = process.env
): string {
  return env.WEBCHAT_GEMINI_ENGINE_MODEL?.trim() || WEBCHAT_ENGINE_DEFAULT_MODEL;
}

/** Tool rounds per turn (each round may carry several parallel calls). */
export const WEBCHAT_ENGINE_MAX_TOOL_ROUNDS = 4;

/** Whole-turn deadline — poll route maxDuration is 60s; leave headroom. */
export const WEBCHAT_ENGINE_TURN_TIMEOUT_MS = 30_000;

export type WebchatJobInputMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

/**
 * Split the enqueue route's pre-built Rowboat input into the system blocks
 * (preamble, datetime, sessionRef, visitor, history tail) and the new
 * `[Webchat]` user turn. Rowboat consumed these as a messages array;
 * Gemini gets the system blocks in systemInstruction and the user turn as
 * the sole content — semantically identical (every system block was
 * turn-independent context).
 */
export function splitWebchatJobInput(messages: WebchatJobInputMessage[]): {
  systemBlocks: string[];
  userTurn: string | null;
} {
  const systemBlocks: string[] = [];
  let userTurn: string | null = null;
  for (const m of messages) {
    if (!m || typeof m.content !== "string") continue;
    if (m.role === "system" && m.content.trim().length > 0) {
      systemBlocks.push(m.content);
    } else if (m.role === "user") {
      // Last user entry wins — the builder emits exactly one.
      userTurn = m.content;
    }
  }
  return { systemBlocks, userTurn };
}

export type RunWebchatGeminiTurnArgs = {
  businessId: string;
  /**
   * The job's pre-built input. Callers pass stateless_input_messages when
   * present, else input_messages — the same precedence the chat-worker
   * uses for its always-stateless turns.
   */
  inputMessages: WebchatJobInputMessage[];
  tier: PlanTier | null;
};

export type WebchatGeminiTurnDeps = {
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
};

export type WebchatGeminiTurnResult = {
  reply: string;
  /** True when the shared AI budget refused the turn (no Gemini call). */
  refusedOverCap: boolean;
  /** Tool rounds actually executed (telemetry). */
  toolRounds: number;
};

/**
 * Run one widget turn against Gemini directly.
 *
 * Throws (after metering whatever Google already billed) on:
 *   * `webchat_engine_no_key` — no GOOGLE_API_KEY/GEMINI_API_KEY in env
 *   * `webchat_engine_no_input` — job carried no user turn
 *   * `webchat_engine_no_reply` — the model never produced text
 *   * any `gemini_http_*` transport error from the step client
 * The caller maps a throw to the job's error path (the widget shows its
 * honest retry copy).
 */
export async function runWebchatGeminiTurn(
  args: RunWebchatGeminiTurnArgs,
  deps: WebchatGeminiTurnDeps = {}
): Promise<WebchatGeminiTurnResult> {
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
  const executeTool = deps.executeTool ?? executeWebchatEngineTool;
  const meter = deps.meter ?? meterGeminiSpendForBusiness;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  /* c8 ignore stop */

  const apiKey = env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY ?? "";
  if (!apiKey) throw new Error("webchat_engine_no_key");

  const { systemBlocks, userTurn } = splitWebchatJobInput(args.inputMessages);
  if (!userTurn || userTurn.trim().length === 0) {
    throw new Error("webchat_engine_no_input");
  }

  // Shared AI budget fuse FIRST — an over-cap tenant's anonymous traffic
  // must not bill Gemini at all. Central has no local model to degrade to,
  // so refuse with the worker's honest copy (kvm1 parity).
  const snapshot = await getSpendSnapshot(args.businessId, args.tier);
  if (snapshot.spendMicros >= snapshot.effectiveCapMicros) {
    return { reply: WEBCHAT_ENGINE_OVER_CAP_REFUSAL, refusedOverCap: true, toolRounds: 0 };
  }

  // Grounding: the agent instructions exactly as the vault sync would seed
  // them, then the per-turn system blocks. Documents are best-effort (same
  // rationale as the knowledge lookup: a digest failure must not kill the
  // turn — the document_share tool still resolves titles server-side).
  const [config, documents] = await Promise.all([
    fetchConfig(args.businessId),
    fetchDocuments(args.businessId).catch((err) => {
      logger.warn("webchat gemini-engine: document digest failed; continuing without", {
        businessId: args.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      return [] as BusinessDocumentRow[];
    })
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
  const systemInstruction = [instructions, ...systemBlocks].join("\n\n");

  const model = webchatEngineModel(env);
  const contents: GeminiChatContent[] = [
    { role: "user", parts: [{ text: userTurn }] }
  ];

  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), WEBCHAT_ENGINE_TURN_TIMEOUT_MS);

  // Aggregate billed tokens across every step; meter ONCE in finally so a
  // mid-loop transport error still records what Google already billed.
  const usageTotal: GeminiUsage = { promptTokens: 0, outputTokens: 0 };
  let sawUsage = false;
  let outputCharsEstimate = 0;
  let toolRounds = 0;

  try {
    for (let round = 0; round <= WEBCHAT_ENGINE_MAX_TOOL_ROUNDS; round++) {
      const isFinalRound = round === WEBCHAT_ENGINE_MAX_TOOL_ROUNDS;
      const step = await chatStep({
        apiKey,
        model,
        systemInstruction,
        contents,
        // Withhold tools on the last round so the model MUST produce text
        // instead of requesting a call nobody will execute.
        tools: isFinalRound ? [] : WEBCHAT_TOOL_DECLARATIONS,
        temperature: 0.3,
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
            result = await executeTool(args.businessId, call.name, call.args);
          } catch (err) {
            // One broken tool must not kill the turn — the model gets a
            // structured failure to explain, same as the webhook path.
            logger.warn("webchat gemini-engine: tool handler failed", {
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
      // Retrying the same contents would just re-bill the same emptiness.
      throw new Error("webchat_engine_no_reply");
    }
    // The final tools-off round either returned text above or threw.
    /* c8 ignore next 2 -- unreachable: the isFinalRound step always hits a return/throw */
    throw new Error("webchat_engine_no_reply");
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
        surface: "webchat_gemini_engine",
        usage: sawUsage ? usageTotal : null,
        inputChars: systemInstruction.length + userTurn.length,
        outputChars: outputCharsEstimate
      });
    }
  }
}
