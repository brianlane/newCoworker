import { z } from "zod";
import { errorResponse, successResponse, handleRouteError } from "@/lib/api-response";
import { rateLimitDurable, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";
import {
  areAllChatTopicsCovered,
  buildOnboardingChatSystemPrompt,
  compileRowboatMarkdownDrafts,
  finalizeAssistantMessage,
  MAX_ONBOARDING_CHAT_MESSAGES,
  onboardingAssistantProfileSchema,
  onboardingChatMessageSchema,
  onboardingChatModelResponseSchema,
  ONBOARDING_CHAT_RATE_LIMIT,
  ONBOARDING_CHAT_RESPONSE_JSON_SCHEMA,
  summarizeOnboardingTopicStatus,
  TOOL_SIGNAL_PATTERN
} from "@/lib/onboarding/chat";

function resolveOnboardingModels(): string[] {
  // Always carry a fallback so a single upstream provider rate-limit (e.g. DeepInfra)
  // never surfaces to onboarding users.
  //
  // The primary is pinned to a dated snapshot on purpose. The bare
  // `deepseek/deepseek-v4-flash` slug resolves to the 0423 build (Artificial
  // Analysis intelligence index 40); the 0731 GA build scores 52 on the same
  // index for roughly $0.09/$0.18 per million tokens against $0.068/$0.168, a
  // fraction of a cent per intake. Pinning also stops the slug repointing under
  // us mid-quarter. Revisit when DeepSeek retires 0731.
  return ["deepseek/deepseek-v4-flash-0731", "openai/gpt-5.4-nano"];
}

// Hard ceiling on total route time. Sized so the worst-case negative path
// (both models exhaust their per-attempt timeout) finishes with comfortable headroom
// before the platform tears the function down, see the math next to
// `OPENROUTER_ATTEMPT_TIMEOUT_MS` below.
export const maxDuration = 45;

const FRIENDLY_ASSISTANT_ERROR =
  "The onboarding assistant is briefly unavailable. Please retry in a few seconds.";

// Per-attempt OpenRouter timeout. A stalled upstream provider (DeepInfra etc.) can
// otherwise pin the request behind a ~30s socket timeout; this lets us fail over to the
// next model in the list, which acts as the retry.
//
// Worst-case negative path the user can experience:
//   pre-flight (rate limit + body parse + prompt build)        ~ 0.2s
//   attempt 1 hits OPENROUTER_ATTEMPT_TIMEOUT_MS                 20.0s
//   attempt 2 hits OPENROUTER_ATTEMPT_TIMEOUT_MS                 20.0s
//   final error response serialization                          ~ 0.1s
//   ───────────────────────────────────────────────────────────────────
//   total                                                       ~40.3s   ( < maxDuration of 45s )
//
// 20s per attempt also comfortably covers a *successful* call: the gpt-5.4-nano response
// observed in production rendered ~6.9KB in roughly 10s, so a fully-populated profile at
// the new 3000-token cap should still come back under ~15s.
const OPENROUTER_ATTEMPT_TIMEOUT_MS = 20_000;

// Cap the model's response length. We keep a cap (rather than letting the model decide)
// because:
//   1. Latency: each output token costs ~10-20ms, so an uncapped runaway response could
//      easily blow past OPENROUTER_ATTEMPT_TIMEOUT_MS even on a healthy provider.
//   2. Cost: misbehaving models can loop or hallucinate verbosely; the cap caps the bill.
//   3. Safety: `response_format` constrains shape, not length, so even with the
//      strict schema below a model can pad string fields indefinitely; without a cap
//      we'd inherit whatever provider default applies (often 4-8K).
//
// Sizing: every turn the model has to re-emit the *full* assistant profile (16 fields,
// most of them growing string arrays) plus the next assistantMessage. A late-conversation
// profile with realistic content (offerings, multiple inquiry flows, routing/escalation
// rules, facts to remember, tone directives, signature) tops out around ~2K tokens of
// content + key/syntax overhead. 3000 leaves ~30% headroom over that worst case while
// still fitting within the per-attempt time budget above.
const ONBOARDING_MAX_COMPLETION_TOKENS = 3000;

// Sentinel for the case where the model returns valid envelope JSON but its inner content
// was truncated mid-output (`finish_reason: "length"`). Detecting this before parsing lets
// us fall over to the next model and log the real cause instead of an `invalid_json`
// SyntaxError.
class TruncatedModelOutputError extends Error {
  constructor() {
    super("The onboarding model ran out of response budget.");
    this.name = "TruncatedModelOutputError";
  }
}

async function fetchOpenRouterChat(params: {
  apiKey: string;
  model: string;
  messages: unknown[];
  appUrl: string;
  signal: AbortSignal;
}): Promise<Response> {
  return fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": params.appUrl,
      "X-Title": "New Coworker Onboarding"
    },
    body: JSON.stringify({
      model: params.model,
      temperature: 0.3,
      max_completion_tokens: ONBOARDING_MAX_COMPLETION_TOKENS,
      reasoning: {
        enabled: false,
        effort: "minimal",
        exclude: true
      },
      response_format: {
        type: "json_schema",
        json_schema: ONBOARDING_CHAT_RESPONSE_JSON_SCHEMA
      },
      // Route only to upstreams that neither retain nor train on the payload.
      // This request carries pre-signup business identity: business name, owner
      // name, phone, service area and the scraped website summary. Unconstrained,
      // OpenRouter spreads this model across 28 endpoints including Baidu and
      // SiliconFlow; `data_collection: "deny"` plus `zdr: true` narrows it to
      // zero-retention endpoints (observed: Fireworks, DeepInfra, Morph,
      // OpenInference for DeepSeek, Azure and OpenAI for the fallback).
      //
      // Deliberately NOT `require_parameters: true`, which reads as the obvious
      // companion flag and empties the pool to zero on both models: no OpenAI
      // GPT-5.x endpoint declares `temperature`, and no DeepSeek endpoint
      // declares `max_completion_tokens`. OpenRouter still normalizes both to
      // the upstream (verified: a cap of 20 returns exactly 20 completion tokens
      // with `finish_reason: "length"`), so the flag would exclude endpoints
      // that work. Schema enforcement is therefore a strong preference here, and
      // the Zod gate below plus model fallover remain the backstop.
      provider: {
        data_collection: "deny",
        zdr: true
      },
      messages: params.messages
    }),
    signal: params.signal
  });
}

// Extract only non-sensitive failure metadata from an OpenRouter error envelope so we
// never log assistant output (which echoes user-provided business/contact context).
function extractSafeOpenRouterErrorMeta(responseText: string): {
  code?: string | number;
  upstreamMessage?: string;
  providerName?: string;
} {
  if (!responseText) return {};
  try {
    const parsed = JSON.parse(responseText) as {
      error?: { code?: string | number; message?: string; metadata?: { provider_name?: string } };
    };
    const err = parsed?.error;
    if (!err || typeof err !== "object") return {};
    const meta: { code?: string | number; upstreamMessage?: string; providerName?: string } = {};
    if (err.code !== undefined) meta.code = err.code;
    // err.message is OpenRouter's static category label (e.g. "Provider returned error"),
    // not the raw upstream body, so it is safe to surface.
    if (typeof err.message === "string") meta.upstreamMessage = err.message.slice(0, 120);
    if (typeof err.metadata?.provider_name === "string") meta.providerName = err.metadata.provider_name;
    return meta;
  } catch {
    return {};
  }
}

// OpenRouter's `usage` block, which the route previously read nothing from. Shapes
// vary slightly by upstream, so every field is treated as optional and coerced.
type OpenRouterUsage = {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  cost?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown };
  completion_tokens_details?: { reasoning_tokens?: unknown };
};

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * One structured line per successfully served turn.
 *
 * Onboarding is the only OpenRouter call site in the repo and sits outside the
 * Gemini spend meter, so before this existed there was no way to answer how
 * often the fallback fires, what a turn costs, or which upstream served it. That
 * made "is this model still the right one" unanswerable from data and left the
 * endpoint invisible to the margin view.
 *
 * Metadata only, deliberately. The response body restates user-provided business
 * and contact context, so it is never logged here, matching the discipline of the
 * two failure logs below.
 *
 * Not wired into `ai-spend-meter` on purpose: that ledger keys on a `business_id`
 * which does not exist yet at pre-signup. Logs first; a ledger is a separate call
 * once the volume is known.
 */
function logServedTurn(params: {
  model: string;
  attempt: number;
  provider?: string;
  elapsedMs: number;
  finishReason?: string;
  usage?: OpenRouterUsage;
}): void {
  const usage = params.usage;
  console.info("[onboard/chat] openrouter turn served", {
    model: params.model,
    attempt: params.attempt,
    provider: params.provider,
    elapsedMs: params.elapsedMs,
    finishReason: params.finishReason,
    promptTokens: finiteNumberOrUndefined(usage?.prompt_tokens),
    completionTokens: finiteNumberOrUndefined(usage?.completion_tokens),
    totalTokens: finiteNumberOrUndefined(usage?.total_tokens),
    cachedTokens: finiteNumberOrUndefined(usage?.prompt_tokens_details?.cached_tokens),
    reasoningTokens: finiteNumberOrUndefined(usage?.completion_tokens_details?.reasoning_tokens),
    costUsd: finiteNumberOrUndefined(usage?.cost)
  });
}

const requestSchema = z.object({
  businessName: z.string().optional(),
  businessType: z.string().optional(),
  ownerName: z.string().optional(),
  phone: z.string().optional(),
  serviceArea: z.string().optional(),
  teamSize: z.string().optional(),
  crmUsed: z.string().optional(),
  websiteUrl: z.string().optional(),
  // Defense-in-depth cap. The legitimate upstream is
  // `WEBSITE_INGEST_MAX_SUMMARY_CHARS = 8_000`, so 16KB is 2× headroom
  // for any future bump or summarizer drift. Anything larger is either
  // a malformed client or an attempt to inflate prompt cost, and we'd
  // rather a clean 400 here than silently burn LLM input tokens on it.
  websiteMd: z.string().max(16_000).optional(),
  messages: z.array(onboardingChatMessageSchema),
  profile: onboardingAssistantProfileSchema.optional()
});

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item && typeof item.text === "string") return item.text;
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

function parseJsonPayload(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Empty model response");

  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Model returned non-JSON content");
    return JSON.parse(match[0]);
  }
}

function isRepeatedToolsQuestion(message: string): boolean {
  return /what tools do you currently use|what tools you currently use|manage leads, schedule calls, and handle messages|specific crm|gmail, calendly|phone\/text/i
    .test(message.toLowerCase());
}

function countToolSignalUserMessages(messages: z.infer<typeof onboardingChatMessageSchema>[]): number {
  return messages.filter((message) => message.role === "user" && TOOL_SIGNAL_PATTERN.test(message.content)).length;
}

function shouldSuppressRepeatedToolsQuestion(
  knownContext: z.infer<typeof requestSchema>,
  profile: z.infer<typeof onboardingAssistantProfileSchema>,
  messages: z.infer<typeof onboardingChatMessageSchema>[]
): boolean {
  if (knownContext.crmUsed?.trim()) return true;
  if (profile.crmUsed.length > 0 || profile.tools.length > 0) return true;
  return countToolSignalUserMessages(messages) >= 2;
}

// Detects "dead-end" assistant turns: messages with no question for the user to answer.
// Question-mark presence is a deliberately conservative signal, it catches the failure
// mode we've actually observed in production ("you can continue by answering the next
// question; we should be ready to finalize soon" with no `?`) without false-positives on
// legitimately question-bearing messages.
function hasQuestionForUser(message: string): boolean {
  return /\?/.test(message);
}

// Drives every fallback question off the server-computed `topicStatus`, which now
// only contains the chat-elicited topics, service area / team size / CRM are
// collected on the Step 1 form (closed-class dropdowns, validated before advance)
// and never need a chat fallback. The priority order here matches
// `areAllChatTopicsCovered`'s coverage check, so the dead-end guard's
// "finalize vs ask next question" decision lines up with the question chosen.
function createFallbackAssistantQuestion(
  topicStatus: ReturnType<typeof summarizeOnboardingTopicStatus>
): string {
  if (!topicStatus.customerTypesKnown) {
    return "What types of customers usually reach out first? List the top 1-3 customer types.";
  }
  if (!topicStatus.commonRequestsKnown) {
    return "What are the top 1-3 recurring questions or requests customers usually send first?";
  }
  if (!topicStatus.inquiryFlowsKnown) {
    return "Give me one common inbound scenario in cause/effect form: what triggers the conversation, and what outcome should the assistant guide it toward, such as booking an appointment or handing the lead to someone?";
  }
  if (!topicStatus.routingRulesKnown) {
    return "When a conversation needs a person instead of your assistant, who should it go to by name, and should the first teammate to respond take it or should it rotate?";
  }
  if (!topicStatus.toneKnown) {
    return "How should the assistant sound in messages? Give 3-5 tone rules and any preferred sign-off.";
  }
  return "What is one business rule, policy, or fact the assistant must remember so it does not mislead customers?";
}

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());
    const limiter = await rateLimitDurable(`onboard-chat:${rateLimitIdentifierFromRequest(request)}`, ONBOARDING_CHAT_RATE_LIMIT);
    if (!limiter.success) {
      return errorResponse("INTERNAL_SERVER_ERROR", "Too many chat messages right now. Please wait a minute and try again.", 429);
    }

    if (body.messages.length >= MAX_ONBOARDING_CHAT_MESSAGES) {
      return errorResponse("VALIDATION_ERROR", "This interview has reached its message limit. Continue to the next step to save tokens.");
    }

    const apiKey = process.env.ORkey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return errorResponse("INTERNAL_SERVER_ERROR", "OpenRouter API key is not configured");
    }

    const knownContext = {
      businessName: body.businessName,
      businessType: body.businessType,
      ownerName: body.ownerName,
      phone: body.phone,
      serviceArea: body.serviceArea,
      teamSize: body.teamSize,
      crmUsed: body.crmUsed,
      websiteUrl: body.websiteUrl,
      websiteMd: body.websiteMd
    };

    const models = resolveOnboardingModels();
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const messages = [
      {
        role: "system",
        content: buildOnboardingChatSystemPrompt(knownContext, body.profile ?? null)
      },
      ...body.messages
    ];
    let json: any = null;
    let parsed: z.infer<typeof onboardingChatModelResponseSchema> | null = null;

    for (const [modelIndex, model] of models.entries()) {
      // Index-based rather than value-based: a duplicated entry in the model list
      // would otherwise make the first copy look like the last attempt.
      const isLastModel = modelIndex === models.length - 1;
      const attempt = modelIndex + 1;
      const attemptStart = Date.now();
      const abortController = new AbortController();
      const abortTimer = setTimeout(() => abortController.abort(), OPENROUTER_ATTEMPT_TIMEOUT_MS);

      let response: Response | null = null;
      let responseText = "";
      let timedOut = false;
      let attemptFailed = false;
      let networkErrorName: string | null = null;

      try {
        response = await fetchOpenRouterChat({
          apiKey,
          model,
          messages,
          appUrl,
          signal: abortController.signal
        });
        responseText = await response.text();
      } catch (fetchError) {
        // Any throw between fetch start and end-of-body-read counts as a failed attempt:
        // - AbortError / signal.aborted -> our timeout
        // - anything else (DNS, TLS, socket reset mid-stream, etc.) -> non-abort failure
        // Flagging both via `attemptFailed` keeps the failure guard below correct even
        // when `fetch()` resolved with `response.ok === true` but `response.text()` then
        // threw, otherwise we'd fall into JSON parsing and mislabel the failure as
        // `invalid_json` in logs.
        attemptFailed = true;
        timedOut =
          (fetchError instanceof Error && fetchError.name === "AbortError") ||
          abortController.signal.aborted;
        networkErrorName = fetchError instanceof Error ? fetchError.name : "unknown";
      } finally {
        clearTimeout(abortTimer);
      }

      if (attemptFailed || !response || !response.ok) {
        console.error("[onboard/chat] openrouter request failed", {
          model,
          attempt,
          status: response?.status,
          timedOut,
          // Only surface networkErrorName when the failure was an actual thrown error
          // (and not just an HTTP non-2xx with a body we already extract metadata from).
          networkErrorName: attemptFailed && !timedOut ? networkErrorName : undefined,
          elapsedMs: Date.now() - attemptStart,
          ...extractSafeOpenRouterErrorMeta(responseText)
        });
        // Model-to-model fallback IS the retry: a same-provider rate limit rarely clears
        // within a few hundred ms, so falling over to the next model is the meaningful hedge.
        if (!isLastModel) continue;
        return errorResponse("INTERNAL_SERVER_ERROR", FRIENDLY_ASSISTANT_ERROR);
      }

      try {
        json = JSON.parse(responseText);
        const choice = json?.choices?.[0];
        const finishReason = choice?.finish_reason;
        const content = extractTextContent(choice?.message?.content);

        if (!content) {
          // Empty body with `length` is a real truncation (the cap was hit before any
          // content was emitted); empty body otherwise is a different upstream failure.
          throw finishReason === "length"
            ? new TruncatedModelOutputError()
            : new Error("The onboarding model returned an empty response.");
        }

        // Try to parse + validate first. Providers can stamp `finish_reason: "length"`
        // any time the token cap is reached, including cases where the JSON happens to
        // be complete and schema-valid (e.g. the model finished the object and would
        // have kept narrating). Treating those as truncated would discard usable
        // answers and force unnecessary fallover. Only escalate to `truncated` when the
        // output also fails parse or schema validation.
        try {
          parsed = onboardingChatModelResponseSchema.parse(parseJsonPayload(content));
          logServedTurn({
            model,
            attempt,
            provider: typeof json?.provider === "string" ? json.provider : undefined,
            elapsedMs: Date.now() - attemptStart,
            finishReason: typeof finishReason === "string" ? finishReason : undefined,
            usage: json?.usage
          });
          break;
        } catch (parseError) {
          if (finishReason === "length") {
            throw new TruncatedModelOutputError();
          }
          throw parseError;
        }
      } catch (error) {
        // Intentionally do not log the response body here: on a parse failure it is
        // typically the assistant's JSON output, which restates user-provided business
        // and contact context. Only log non-sensitive metadata.
        const errorType =
          error instanceof TruncatedModelOutputError ? "truncated"
            : error instanceof z.ZodError ? "schema_mismatch"
              : error instanceof SyntaxError ? "invalid_json"
                : "parse_error";
        console.error("[onboard/chat] openrouter parse failed", {
          model,
          attempt,
          errorType,
          finishReason: json?.choices?.[0]?.finish_reason,
          responseLength: responseText.length
        });
        if (!isLastModel) continue;
        return errorResponse("INTERNAL_SERVER_ERROR", FRIENDLY_ASSISTANT_ERROR);
      }
    }

    if (!json || !parsed) {
      return errorResponse("INTERNAL_SERVER_ERROR", FRIENDLY_ASSISTANT_ERROR);
    }
    const topicStatus = summarizeOnboardingTopicStatus(parsed.profile);
    // `shouldSuppressRepeatedToolsQuestion` already gates on
    // `knownContext.crmUsed?.trim()` (form-collected on Step 1) /
    // `profile.{crmUsed,tools}` / a transcript-mention-count
    // threshold, so a redundant outer `topicStatus.toolsKnown` guard
    // is no longer needed, the inner check is the actual contract.
    if (
      isRepeatedToolsQuestion(parsed.assistantMessage) &&
      shouldSuppressRepeatedToolsQuestion(body, parsed.profile, body.messages)
    ) {
      parsed = {
        ...parsed,
        assistantMessage: createFallbackAssistantQuestion(topicStatus)
      };
    }

    // Dead-end guard: the model occasionally telegraphs "we're almost done, answer the
    // next question" without actually asking one and without setting readyToFinalize.
    // That leaves the user stuck (no question to answer, Continue button disabled) and
    // forces a wasted round-trip just to elicit the missing question. The prompt forbids
    // this, but LLMs ignore rules late in long conversations, so we deterministically
    // recover here:
    //   - if every chat-elicited topic is already covered, finalize for the model;
    //   - otherwise, swap the message for a concrete next question driven by the
    //     server's view of what's still missing.
    //
    // The "covered" check intentionally ignores the form-collected topics
    // (serviceArea/teamSize/tools), they're not chat's responsibility to elicit, and
    // gating on `Object.values(topicStatus).every(Boolean)` would deadlock legacy
    // localStorage drafts whose `knownContext.{serviceArea,teamSize,crmUsed}` are
    // empty: those fields would never flip to `known`, so `allTopicsCovered` would
    // never become true, and `createFallbackAssistantQuestion` (which no longer has
    // branches for those topics post-Step-1-migration) would loop on the same generic
    // policy fallback question forever.
    if (!parsed.readyToFinalize && !hasQuestionForUser(parsed.assistantMessage)) {
      if (areAllChatTopicsCovered(topicStatus)) {
        parsed = { ...parsed, readyToFinalize: true };
      } else {
        parsed = {
          ...parsed,
          assistantMessage: createFallbackAssistantQuestion(topicStatus)
        };
      }
    }

    // Whenever the conversation is finalized, whether the model set it, or the dead-end
    // guard forced it above, the brief is by definition complete. Clamp the progress
    // metadata so downstream consumers (UI summaries, persisted state, future analytics)
    // never see a finalized response carrying a stale "92% captured" + non-empty
    // missingTopics from an earlier turn.
    if (parsed.readyToFinalize) {
      parsed = {
        ...parsed,
        completionPercent: 100,
        missingTopics: []
      };
    }

    parsed = {
      ...parsed,
      assistantMessage: finalizeAssistantMessage(parsed.assistantMessage, parsed.readyToFinalize)
    };
    const drafts = compileRowboatMarkdownDrafts(knownContext, parsed.profile);

    return successResponse({
      ...parsed,
      drafts
    });
  } catch (err) {
    if (err instanceof z.ZodError) return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    return handleRouteError(err);
  }
}
