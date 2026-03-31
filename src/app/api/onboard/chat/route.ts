import { z } from "zod";
import { errorResponse, successResponse, handleRouteError } from "@/lib/api-response";
import {
  buildOnboardingChatSystemPrompt,
  compileRowboatMarkdownDrafts,
  onboardingAssistantProfileSchema,
  onboardingChatMessageSchema,
  onboardingChatModelResponseSchema
} from "@/lib/onboarding/chat";

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

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());

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

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
        "X-Title": "New Coworker Onboarding"
      },
      body: JSON.stringify({
        model: "openai/gpt-5.4-nano",
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
            content: buildOnboardingChatSystemPrompt(knownContext, body.profile ?? null)
          },
          ...body.messages
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return errorResponse("INTERNAL_SERVER_ERROR", `OpenRouter request failed: ${errorText.slice(0, 300)}`);
    }

    const json = await response.json();
    const content = extractTextContent(json?.choices?.[0]?.message?.content);
    if (!content) {
      const finishReason = json?.choices?.[0]?.finish_reason;
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        finishReason === "length"
          ? "The onboarding model ran out of response budget. Please try again."
          : "The onboarding model returned an empty response."
      );
    }
    const parsed = onboardingChatModelResponseSchema.parse(parseJsonPayload(content));
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
