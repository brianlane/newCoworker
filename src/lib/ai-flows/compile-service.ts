/**
 * AiFlow AI-assist compile pipeline — shared service.
 *
 * Owns the full "plain-English description → VALIDATED AiFlow definition"
 * flow that used to live inline in POST /api/aiflows/compile: document
 * option loading, the Gemini call (JSON mode), spend metering (including
 * billed-but-empty replies), schema + DB-backed validation, the one-shot
 * self-repair round, and the best-effort salvage. Factored out so the
 * dashboard-chat `create_aiflow` tool and the compile route run the exact
 * same pipeline — AI output is never trusted or executed without full
 * validation, and nothing here persists a flow (callers hand the owner a
 * draft to review).
 *
 * Throws only on unexpected transport failures (non-empty Gemini errors);
 * every expected outcome is a structured result.
 */

import {
  GeminiEmptyError,
  geminiGenerateTextDetailed,
  type GeminiGenerateTextParams,
  type GeminiGenerateTextResult,
  type GeminiUsage
} from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import {
  FLOW_COMPILE_SYSTEM_PROMPT,
  buildFlowCompileUserText,
  buildFlowRepairUserText,
  extractFlowJson,
  humanizeCompileIssues,
  type CompileDocumentOption
} from "@/lib/ai-flows/compile";
import { listBusinessDocuments, type BusinessDocumentRow } from "@/lib/documents/db";
import { documentEligibleFor } from "@/lib/documents/core";
import {
  AiFlowValidationError,
  parseAiFlowDefinition,
  salvageFlowDefinition,
  type AiFlowDefinition
} from "@/lib/ai-flows/schema";
import { validateShareDocumentSteps } from "@/lib/ai-flows/document-steps";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";

type GeminiCall = (params: GeminiGenerateTextParams) => Promise<GeminiGenerateTextResult>;

export type CompileFlowDeps = {
  /** Injectable Gemini call (tests). */
  generate?: GeminiCall;
  /** Injectable documents lookup (tests). */
  fetchDocuments?: (businessId: string) => Promise<BusinessDocumentRow[]>;
};

export type CompileFlowResult =
  | { ok: true; definition: AiFlowDefinition; warnings: string[] }
  | {
      ok: false;
      error: "not_configured" | "unparseable" | "invalid";
      /** Owner-facing message (issues already humanized for "invalid"). */
      message: string;
      issues: string[];
    };

const INVALID_MESSAGE_PREFIX = "The AI draft needs a tweak before it can be used:";

/** Owner-facing failure text for a set of validation issues. */
export function invalidDraftMessage(issues: string[]): string {
  return `${INVALID_MESSAGE_PREFIX}\n${humanizeCompileIssues(issues)
    .map((i) => `• ${i}`)
    .join("\n")}\nEdit your description (or build the flow manually) and try again.`;
}

/**
 * Compile one description into a validated definition (with self-repair +
 * salvage). See module doc for the contract.
 */
export async function compileAiFlowFromDescription(
  args: { businessId: string; description: string },
  deps: CompileFlowDeps = {}
): Promise<CompileFlowResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const generate = deps.generate ?? geminiGenerateTextDetailed;
  const fetchDocuments = deps.fetchDocuments ?? listBusinessDocuments;
  /* c8 ignore stop */

  // Same key resolution as every other Gemini surface (document ingest, the
  // inline chat turn): either env name configures the platform.
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) {
    return {
      ok: false,
      error: "not_configured",
      message: "AI assist is not configured",
      issues: []
    };
  }

  // gemini-3.5-flash: GA, agentic-grade reasoning — capable enough to author
  // a complex multi-step branched flow from a long spec at its balanced
  // default thinking level. JSON mode + a generous output budget keep large
  // definitions from truncating into unparseable JSON.
  const model = process.env.AIFLOW_COMPILE_MODEL ?? "gemini-3.5-flash";

  // Documents the model may bind share_document steps to: client-eligible +
  // ready only (flow recipients are customers). A read failure just compiles
  // without the block — same NEVER-invent contract applies.
  let compileDocuments: CompileDocumentOption[] = [];
  try {
    const docs = await fetchDocuments(args.businessId);
    compileDocuments = docs
      .filter((d) => documentEligibleFor(d, "clients"))
      .map((d) => ({ id: d.id, title: d.title, summary: d.summary }));
  } catch (docErr) {
    logger.warn("aiflow compile: document list failed; compiling without documents", {
      businessId: args.businessId,
      error: docErr instanceof Error ? docErr.message : String(docErr)
    });
  }

  const userText = buildFlowCompileUserText(args.description, compileDocuments);
  let raw: string;
  let usage: GeminiUsage | null;
  try {
    // Output price includes thinking tokens, but billing is by ACTUAL tokens
    // used (meterGeminiSpendForBusiness below), not this cap. A generous 32k
    // cap just guarantees the full definition never truncates mid-JSON.
    ({ text: raw, usage } = await generate({
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
        businessId: args.businessId,
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
    businessId: args.businessId,
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
      businessId: args.businessId,
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
    return {
      ok: false,
      error: "unparseable",
      message: "AI did not return a usable automation",
      issues: []
    };
  }

  // Same layering as the CRUD routes: shape+semantics via
  // parseAiFlowDefinition, then the DB-backed share_document check — so an
  // invalid document binding feeds the self-repair loop instead of
  // surfacing later as a save failure.
  const parseAndValidate = async (input: unknown): Promise<AiFlowDefinition> => {
    const definition = parseAiFlowDefinition(input);
    const documentIssues = await validateShareDocumentSteps(args.businessId, definition, {
      fetchDocuments
    });
    if (documentIssues.length > 0) {
      throw new AiFlowValidationError("Invalid AiFlow definition", documentIssues);
    }
    return definition;
  };

  try {
    const definition = await parseAndValidate(candidate);
    return { ok: true, definition, warnings: [] };
  } catch (err) {
    if (!(err instanceof AiFlowValidationError)) throw err;
    // Self-repair: give the model ONE shot at fixing its own output with the
    // exact validation issues in hand. A second failure surfaces humanized
    // guidance instead of raw zod paths.
    void recordSystemLog({
      businessId: args.businessId,
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
    // The best candidate JSON we have for the salvage fallback below: the
    // self-repair output supersedes the original when it at least parsed.
    let lastCandidate: unknown = candidate;
    try {
      const repairText = buildFlowRepairUserText({
        description: args.description,
        candidateJson: JSON.stringify(candidate),
        issues: err.issues,
        documents: compileDocuments
      });
      const { text: repairedRaw, usage: repairUsage } = await generate({
        apiKey,
        model,
        systemInstruction: FLOW_COMPILE_SYSTEM_PROMPT,
        userText: repairText,
        temperature: 0,
        maxOutputTokens: 32000,
        responseMimeType: "application/json"
      });
      await meterGeminiSpendForBusiness({
        businessId: args.businessId,
        model,
        surface: "aiflow_compile",
        usage: repairUsage,
        inputChars: FLOW_COMPILE_SYSTEM_PROMPT.length + repairText.length,
        outputChars: repairedRaw.length
      });
      const repairedCandidate = extractFlowJson(repairedRaw);
      if (repairedCandidate !== null) {
        lastCandidate = repairedCandidate;
        const definition = await parseAndValidate(repairedCandidate);
        return { ok: true, definition, warnings: [] };
      }
    } catch (repairErr) {
      if (repairErr instanceof AiFlowValidationError) {
        repairIssues = repairErr.issues;
      } else if (repairErr instanceof GeminiEmptyError) {
        await meterGeminiSpendForBusiness({
          businessId: args.businessId,
          model,
          surface: "aiflow_compile",
          usage: repairErr.usage,
          inputChars: FLOW_COMPILE_SYSTEM_PROMPT.length,
          outputChars: 0
        });
      } else {
        // Transient repair-call failure: fall through to the original issues.
        logger.warn("aiflow compile self-repair call failed", {
          businessId: args.businessId,
          error: repairErr instanceof Error ? repairErr.message : String(repairErr)
        });
      }
    }
    // Best effort: rather than bouncing the owner with an error, keep every
    // valid part of the draft and mechanically repair/remove the rest. The
    // result loads into the builder DISABLED for review, with warnings
    // explaining exactly what was changed.
    const salvaged = salvageFlowDefinition(lastCandidate);
    if (salvaged) {
      // The salvage loads DISABLED for review — a bad document binding in
      // it becomes a visible warning (and the save-time validator still
      // blocks it) rather than a rejected compile.
      const salvageDocumentIssues = await validateShareDocumentSteps(
        args.businessId,
        salvaged.definition,
        { fetchDocuments }
      ).catch(() => [] as string[]);
      const warnings = [...salvaged.warnings, ...salvageDocumentIssues];
      void recordSystemLog({
        businessId: args.businessId,
        source: "app",
        level: "warn",
        event: "aiflow_compile_salvaged",
        message: "AI draft failed validation; returned a best-effort salvage",
        payload: {
          model,
          reason: "schema_after_repair",
          issues: repairIssues,
          salvage_warnings: warnings
        }
      });
      return { ok: true, definition: salvaged.definition, warnings };
    }
    void recordSystemLog({
      businessId: args.businessId,
      source: "app",
      level: "warn",
      event: "aiflow_compile_failed",
      message: "AI produced an invalid automation (after self-repair and salvage)",
      payload: { model, reason: "schema_after_repair", issues: repairIssues }
    });
    return {
      ok: false,
      error: "invalid",
      message: invalidDraftMessage(repairIssues),
      issues: repairIssues
    };
  }
}
