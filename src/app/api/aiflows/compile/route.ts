/**
 * AI-assist authoring: POST a plain-English description, get back a VALIDATED
 * AiFlow definition candidate the builder can load into the form.
 *
 * Owner-only. The Gemini output is always run through `parseAiFlowDefinition`
 * before returning — AI output is never trusted or executed blindly. The route
 * returns the structured definition; it does NOT persist anything (the owner
 * reviews/edits, then saves via POST /api/aiflows).
 */
import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  GeminiEmptyError,
  geminiGenerateTextDetailed,
  type GeminiUsage
} from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import {
  FLOW_COMPILE_SYSTEM_PROMPT,
  buildFlowCompileUserText,
  extractFlowJson
} from "@/lib/ai-flows/compile";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  description: z.string().min(1).max(4000)
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const body = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireOwner(body.businessId);

    const apiKey = process.env.GOOGLE_API_KEY ?? "";
    if (!apiKey) {
      return errorResponse("INTERNAL_SERVER_ERROR", "AI assist is not configured");
    }

    const model = process.env.AIFLOW_COMPILE_MODEL ?? "gemini-2.5-flash";
    const userText = buildFlowCompileUserText(body.description);
    let raw: string;
    let usage: GeminiUsage | null;
    try {
      ({ text: raw, usage } = await geminiGenerateTextDetailed({
        apiKey,
        model,
        systemInstruction: FLOW_COMPILE_SYSTEM_PROMPT,
        userText,
        temperature: 0,
        maxOutputTokens: 2000
      }));
    } catch (err) {
      // Empty replies (e.g. thinking-only output) are still billed — meter
      // them before surfacing the failure.
      if (err instanceof GeminiEmptyError) {
        await meterGeminiSpendForBusiness({
          businessId: body.businessId,
          model,
          surface: "aiflow_compile",
          usage: err.usage,
          inputChars: FLOW_COMPILE_SYSTEM_PROMPT.length + userText.length,
          outputChars: 0
        });
      }
      throw err;
    }
    // Compile runs on a pricier model than chat (2.5 Flash, thinking tokens
    // billed as output) — meter it into the shared AI budget like every
    // other Gemini surface. Exact tokens when available, chars/4 otherwise.
    await meterGeminiSpendForBusiness({
      businessId: body.businessId,
      model,
      surface: "aiflow_compile",
      usage,
      inputChars: FLOW_COMPILE_SYSTEM_PROMPT.length + userText.length,
      outputChars: raw.length
    });

    const candidate = extractFlowJson(raw);
    if (candidate === null) {
      return errorResponse("VALIDATION_ERROR", "AI did not return a usable automation");
    }
    const definition = parseAiFlowDefinition(candidate);
    return successResponse({ definition });
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      return errorResponse(
        "VALIDATION_ERROR",
        `AI produced an invalid automation: ${err.issues.join("; ")}`
      );
    }
    return handleRouteError(err);
  }
}
