import { z } from "zod";
import { errorResponse, successResponse, handleRouteError } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  buildOnboardingChatSystemPrompt,
  compileRowboatMarkdownDrafts,
  finalizeAssistantMessage,
  MAX_ONBOARDING_CHAT_MESSAGES,
  onboardingAssistantProfileSchema,
  onboardingChatMessageSchema,
  onboardingChatModelResponseSchema,
  ONBOARDING_CHAT_RATE_LIMIT,
  summarizeOnboardingTopicStatus
} from "@/lib/onboarding/chat";

function resolveOnboardingModels(): string[] {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const isLocalAppUrl = appUrl.includes("localhost") || appUrl.includes("127.0.0.1");
  const isDev = process.env.NODE_ENV !== "production";

  if (isDev || isLocalAppUrl) {
    return ["openrouter/free", "openai/gpt-5.4-nano"];
  }

  return ["openai/gpt-5.4-nano"];
}

const requestSchema = z.object({
  businessName: z.string().optional(),
  businessType: z.string().optional(),
  ownerName: z.string().optional(),
  phone: z.string().optional(),
  serviceArea: z.string().optional(),
  teamSize: z.string().optional(),
  crmUsed: z.string().optional(),
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

function getRequestIdentifier(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]?.trim() || "unknown";

  return request.headers.get("x-real-ip") || request.headers.get("cf-connecting-ip") || "unknown";
}

function isRepeatedToolsQuestion(message: string): boolean {
  return /what tools do you currently use|what tools you currently use|manage leads, schedule calls, and handle messages|specific crm|gmail, calendly|phone\/text/i
    .test(message.toLowerCase());
}

const TOOL_SIGNAL_PATTERN =
  /\b(text|texts|sms|call|calls|phone|phones|gmail|email|emails|calendar|calendly|crm|hubspot|pipeline|imessage)\b/i;

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

function createFallbackAssistantQuestion(
  knownContext: z.infer<typeof requestSchema>,
  profile: z.infer<typeof onboardingAssistantProfileSchema>
): string {
  if (!profile.serviceArea.trim() && !knownContext.serviceArea?.trim()) {
    return "What service area, market, or territory do you cover?";
  }
  if (!profile.teamSize.trim() && !knownContext.teamSize?.trim()) {
    return "How big is the team the assistant supports? If it is just you, say that directly.";
  }
  if (profile.customerTypes.length === 0) {
    return "What types of customers usually reach out first? List the top 1-3 customer types.";
  }
  if (profile.commonRequests.length === 0) {
    return "What are the top 1-3 recurring questions or requests customers usually send first?";
  }
  if (profile.inquiryFlows.length === 0) {
    return "Give me one common inbound scenario in cause/effect form: what triggers the conversation, and what outcome should the assistant guide it toward?";
  }
  if (profile.routingRules.length === 0 && profile.escalationRules.length === 0) {
    return "When should the assistant route someone to you or another human instead of handling it alone?";
  }
  if (profile.toneDirectives.length === 0 && !profile.signature.trim()) {
    return "How should the assistant sound in messages? Give 3-5 tone rules and any preferred sign-off.";
  }
  return "What is one business rule, policy, or fact the assistant must remember so it does not mislead customers?";
}

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());
    const limiter = rateLimit(`onboard-chat:${getRequestIdentifier(request)}`, ONBOARDING_CHAT_RATE_LIMIT);
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
      crmUsed: body.crmUsed
    };

    const models = resolveOnboardingModels();
    let json: any = null;
    let parsed: z.infer<typeof onboardingChatModelResponseSchema> | null = null;
    let lastErrorText = "";

    for (const model of models) {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
          "X-Title": "New Coworker Onboarding"
        },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          max_completion_tokens: 1200,
          reasoning: {
            effort: "minimal",
            exclude: true
          },
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: buildOnboardingChatSystemPrompt(knownContext, body.profile ?? null, body.messages)
            },
            ...body.messages
          ]
        })
      });

      const responseText = await response.text();

      if (!response.ok) {
        lastErrorText = responseText;
        if (model !== models[models.length - 1]) {
          continue;
        }
        return errorResponse("INTERNAL_SERVER_ERROR", `OpenRouter request failed: ${responseText.slice(0, 300)}`);
      }

      try {
        json = JSON.parse(responseText);
        const content = extractTextContent(json?.choices?.[0]?.message?.content);
        if (!content) {
          const finishReason = json?.choices?.[0]?.finish_reason;
          throw new Error(
            finishReason === "length"
              ? "The onboarding model ran out of response budget. Please try again."
              : "The onboarding model returned an empty response."
          );
        }

        parsed = onboardingChatModelResponseSchema.parse(parseJsonPayload(content));
        break;
      } catch (error) {
        lastErrorText = error instanceof Error ? error.message : "Model returned invalid onboarding JSON";
        if (model !== models[models.length - 1]) {
          continue;
        }
        return errorResponse("INTERNAL_SERVER_ERROR", lastErrorText);
      }
    }

    if (!json || !parsed) {
      return errorResponse("INTERNAL_SERVER_ERROR", `OpenRouter request failed: ${lastErrorText.slice(0, 300)}`);
    }
    const topicStatus = summarizeOnboardingTopicStatus(knownContext, parsed.profile, body.messages);
    if (
      topicStatus.toolsKnown &&
      isRepeatedToolsQuestion(parsed.assistantMessage) &&
      shouldSuppressRepeatedToolsQuestion(body, parsed.profile, body.messages)
    ) {
      parsed = {
        ...parsed,
        assistantMessage: createFallbackAssistantQuestion(body, parsed.profile)
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
