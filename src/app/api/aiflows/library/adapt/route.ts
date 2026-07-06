/**
 * "Adapt with AI" for a public library entry.
 *
 * Sends the scrubbed library definition + the caller's business details to
 * Gemini (same schema contract + validation as /api/aiflows/compile) and returns
 * a VALIDATED adapted definition the builder loads into the editor. Does NOT
 * persist anything — the owner reviews and saves via POST /api/aiflows.
 *
 * Owner-only, rate-limited (paid Gemini call), and metered into the shared AI
 * budget like every other Gemini surface.
 */
import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitDurable } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  GeminiEmptyError,
  geminiGenerateTextDetailed,
  type GeminiUsage
} from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import {
  FLOW_COMPILE_SYSTEM_PROMPT,
  buildFlowAdaptUserText,
  extractFlowJson
} from "@/lib/ai-flows/compile";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { getAiFlowLibraryEntry } from "@/lib/ai-flows/library";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  businessId: z.string().uuid(),
  libraryId: z.string().uuid(),
  instructions: z.string().max(2000).optional()
});

// One paid Gemini call each; 5/min/business is generous for interactive use.
const ADAPT_RATE_LIMIT = { interval: 60_000, maxRequests: 5 };

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const body = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireOwner(body.businessId);

    const limiter = await rateLimitDurable(`aiflow-library-adapt:${body.businessId}`, ADAPT_RATE_LIMIT);
    if (!limiter.success) {
      return errorResponse("FORBIDDEN", "Too many AI requests; wait a moment and try again.", 429);
    }

    const apiKey = process.env.GOOGLE_API_KEY ?? "";
    if (!apiKey) return errorResponse("INTERNAL_SERVER_ERROR", "AI assist is not configured");

    const entry = await getAiFlowLibraryEntry(body.libraryId);
    if (!entry) return errorResponse("NOT_FOUND", "Library flow not found");

    const db = await createSupabaseServiceClient();
    const [{ data: business }, { data: members }] = await Promise.all([
      db.from("businesses").select("phone").eq("id", body.businessId).maybeSingle(),
      db
        .from("ai_flow_team_members")
        .select("name")
        .eq("business_id", body.businessId)
        .eq("active", true)
        .order("created_at", { ascending: true })
        .limit(10)
    ]);

    const model = process.env.AIFLOW_COMPILE_MODEL ?? "gemini-3.5-flash";
    const userText = buildFlowAdaptUserText({
      sourceDefinition: entry.scrubbed_definition,
      ownerPhone: (business?.phone as string | null | undefined) ?? null,
      ownerEmail: user.email,
      employeeNames: (members ?? []).map((m) => m.name as string).filter(Boolean),
      instructions: body.instructions
    });

    let raw: string;
    let usage: GeminiUsage | null;
    try {
      ({ text: raw, usage } = await geminiGenerateTextDetailed({
        apiKey,
        model,
        systemInstruction: FLOW_COMPILE_SYSTEM_PROMPT,
        userText,
        temperature: 0,
        maxOutputTokens: 32000,
        responseMimeType: "application/json"
      }));
    } catch (err) {
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
