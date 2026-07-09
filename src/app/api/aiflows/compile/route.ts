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
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
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
  buildFlowRepairUserText,
  extractFlowJson,
  humanizeCompileIssues
} from "@/lib/ai-flows/compile";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  description: z.string().min(1).max(4000)
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const body = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_aiflows");

    const apiKey = process.env.GOOGLE_API_KEY ?? "";
    if (!apiKey) {
      return errorResponse("INTERNAL_SERVER_ERROR", "AI assist is not configured");
    }

    // gemini-3-flash-preview: the gemini-3 tier already used for knowledge
    // lookups (and priced in ai-spend-meter). JSON mode + a generous output
    // budget keep large multi-step definitions from truncating into
    // unparseable JSON, which is what tripped the old 2.5-flash + 2000-token
    // path (thinking tokens ate the budget mid-object).
    // Gemini 3.5 Flash: GA, agentic-grade reasoning — capable enough to author
    // a complex multi-step branched flow from a long spec. It reasons at its
    // balanced default ("medium") rather than the preview's "high" (dynamic),
    // which previously ate the whole output budget on hidden thinking.
    const model = process.env.AIFLOW_COMPILE_MODEL ?? "gemini-3.5-flash";
    const userText = buildFlowCompileUserText(body.description);
    let raw: string;
    let usage: GeminiUsage | null;
    try {
      // Output price includes thinking tokens, but billing is by ACTUAL tokens
      // used (meterGeminiSpendForBusiness below), not this cap. So a generous
      // 32k cap (well under the model's 65,536 limit) just guarantees the full
      // definition + reasoning never truncate mid-JSON — it does not inflate
      // cost. JSON mode keeps the visible output to a strict object.
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
      // The compile (authoring) call is otherwise invisible in system_logs —
      // record truncated/unparseable model output so "the AI builder failed"
      // is debuggable via `debug/system-logs.ts --source=app --grep=compile`.
      void recordSystemLog({
        businessId: body.businessId,
        source: "app",
        level: "warn",
        event: "aiflow_compile_failed",
        message: "AI did not return a usable automation",
        payload: {
          model,
          reason: "unparseable",
          rawLength: raw.length,
          outputTokens: usage?.outputTokens ?? null
        }
      });
      return errorResponse("VALIDATION_ERROR", "AI did not return a usable automation");
    }
    try {
      const definition = parseAiFlowDefinition(candidate);
      return successResponse({ definition });
    } catch (err) {
      if (!(err instanceof AiFlowValidationError)) throw err;
      // Self-repair: give the model ONE shot at fixing its own output with the
      // exact validation issues in hand. Most failures (a missed field, a var
      // referenced before it exists) are trivially fixable this way; a second
      // failure surfaces humanized guidance instead of raw zod paths.
      void recordSystemLog({
        businessId: body.businessId,
        source: "app",
        level: "warn",
        event: "aiflow_compile_failed",
        message: "AI produced an invalid automation (attempting self-repair)",
        payload: {
          model,
          reason: "schema",
          issues: err.issues,
          outputTokens: usage?.outputTokens ?? null
        }
      });
      let repairIssues = err.issues;
      try {
        const repairText = buildFlowRepairUserText({
          description: body.description,
          candidateJson: JSON.stringify(candidate),
          issues: err.issues
        });
        const { text: repairedRaw, usage: repairUsage } = await geminiGenerateTextDetailed({
          apiKey,
          model,
          systemInstruction: FLOW_COMPILE_SYSTEM_PROMPT,
          userText: repairText,
          temperature: 0,
          maxOutputTokens: 32000,
          responseMimeType: "application/json"
        });
        await meterGeminiSpendForBusiness({
          businessId: body.businessId,
          model,
          surface: "aiflow_compile",
          usage: repairUsage,
          inputChars: FLOW_COMPILE_SYSTEM_PROMPT.length + repairText.length,
          outputChars: repairedRaw.length
        });
        const repairedCandidate = extractFlowJson(repairedRaw);
        if (repairedCandidate !== null) {
          const definition = parseAiFlowDefinition(repairedCandidate);
          return successResponse({ definition });
        }
      } catch (repairErr) {
        if (repairErr instanceof AiFlowValidationError) {
          repairIssues = repairErr.issues;
        } else if (repairErr instanceof GeminiEmptyError) {
          await meterGeminiSpendForBusiness({
            businessId: body.businessId,
            model,
            surface: "aiflow_compile",
            usage: repairErr.usage,
            inputChars: FLOW_COMPILE_SYSTEM_PROMPT.length,
            outputChars: 0
          });
        } else {
          // Transient repair-call failure: fall through to the original issues.
          logger.warn("aiflow compile self-repair call failed", {
            businessId: body.businessId,
            error: repairErr instanceof Error ? repairErr.message : String(repairErr)
          });
        }
      }
      void recordSystemLog({
        businessId: body.businessId,
        source: "app",
        level: "warn",
        event: "aiflow_compile_failed",
        message: "AI produced an invalid automation (after self-repair)",
        payload: { model, reason: "schema_after_repair", issues: repairIssues }
      });
      return errorResponse(
        "VALIDATION_ERROR",
        `The AI draft needs a tweak before it can be used:\n${humanizeCompileIssues(repairIssues)
          .map((i) => `• ${i}`)
          .join("\n")}\nEdit your description (or build the flow manually) and try again.`
      );
    }
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      return errorResponse(
        "VALIDATION_ERROR",
        `The AI draft needs a tweak before it can be used:\n${humanizeCompileIssues(err.issues)
          .map((i) => `• ${i}`)
          .join("\n")}`
      );
    }
    return handleRouteError(err);
  }
}
