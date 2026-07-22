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
 * `editAiFlowDefinition` is the in-place EDIT sibling (the chat
 * `edit_aiflow` tool): same model, metering, validation, and self-repair —
 * but NO salvage, because an edit is applied to the live flow with no
 * builder-review step in between. A definition that would only pass via
 * salvage is refused with humanized issues instead of persisted.
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
  buildFlowEditUserText,
  buildFlowRepairUserText,
  extractFlowJson,
  humanizeCompileIssues,
  type CompileAgentOption,
  type CompileDocumentOption,
  type CompileMailboxOption
} from "@/lib/ai-flows/compile";
import { listBusinessDocuments, type BusinessDocumentRow } from "@/lib/documents/db";
import { documentEligibleFor } from "@/lib/documents/core";
import { listBusinessAgents, type BusinessAgentRow } from "@/lib/agents/db";
import { connectionEmail } from "@/lib/email/mailbox-options";
import { isEmailProviderConfigKey } from "@/lib/voice-tools/connections";
import { validateRunAgentSteps } from "@/lib/ai-flows/agent-steps";
import {
  AiFlowValidationError,
  parseAiFlowDefinition,
  salvageFlowDefinition,
  type AiFlowDefinition
} from "@/lib/ai-flows/schema";
import { validateShareDocumentSteps } from "@/lib/ai-flows/document-steps";
import { validateMailboxConnectionSteps } from "@/lib/ai-flows/mailbox-steps";
import {
  listWorkspaceOAuthConnections,
  type WorkspaceOAuthConnectionRow
} from "@/lib/db/workspace-oauth-connections";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";

type GeminiCall = (params: GeminiGenerateTextParams) => Promise<GeminiGenerateTextResult>;

export type CompileFlowDeps = {
  /** Injectable Gemini call (tests). */
  generate?: GeminiCall;
  /** Injectable documents lookup (tests). */
  fetchDocuments?: (businessId: string) => Promise<BusinessDocumentRow[]>;
  /** Injectable agents lookup (tests). */
  fetchAgents?: (businessId: string) => Promise<BusinessAgentRow[]>;
  /** Injectable workspace-connections lookup (tests). */
  fetchConnections?: (businessId: string) => Promise<WorkspaceOAuthConnectionRow[]>;
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
 * Owner-facing failure text when an EDIT could not be validated. Distinct
 * from the draft copy: the load-bearing fact is that the live flow was NOT
 * touched.
 */
export function invalidEditMessage(issues: string[]): string {
  return `The requested change couldn't be applied safely, so the automation was NOT changed:\n${humanizeCompileIssues(
    issues
  )
    .map((i) => `• ${i}`)
    .join("\n")}\nRephrase the request, or edit the flow at /dashboard/aiflows.`;
}

/**
 * gemini-3.6-flash (GA Jul 21 2026): the strongest available model for
 * structured JSON authoring and agentic edits — beats 3.5-flash on every
 * agentic/coding benchmark while pricing output at $7.50/1M (vs $9.00) with
 * ~17% fewer output tokens. Pinned at maximum reasoning (thinkingLevel
 * "high" on every call below) — the Flash tier's DEFAULT thinking level is
 * medium, and flow authoring/editing is exactly the task class that
 * deserves the full budget. JSON mode + a generous output cap keep large
 * definitions from truncating into unparseable JSON; billing is by actual
 * tokens used (thinking included), not the cap.
 */
export function flowCompileModel(): string {
  return process.env.AIFLOW_COMPILE_MODEL ?? "gemini-3.6-flash";
}

/** Reasoning budget for every flow authoring/edit call. */
export const FLOW_COMPILE_THINKING_LEVEL = "high" as const;

/**
 * Documents the model may bind share_document steps to: client-eligible +
 * ready only (flow recipients are customers). A read failure degrades to
 * "no documents" — the same NEVER-invent contract applies either way.
 */
async function loadCompileDocuments(
  businessId: string,
  fetchDocuments: NonNullable<CompileFlowDeps["fetchDocuments"]>
): Promise<CompileDocumentOption[]> {
  try {
    const docs = await fetchDocuments(businessId);
    return docs
      .filter((d) => documentEligibleFor(d, "clients"))
      .map((d) => ({ id: d.id, title: d.title, summary: d.summary }));
  } catch (docErr) {
    logger.warn("aiflow compile: document list failed; compiling without documents", {
      businessId,
      error: docErr instanceof Error ? docErr.message : String(docErr)
    });
    return [];
  }
}

/** Agents the model may bind run_agent steps to: enabled only. Same degrade posture. */
async function loadCompileAgents(
  businessId: string,
  fetchAgents: NonNullable<CompileFlowDeps["fetchAgents"]>
): Promise<CompileAgentOption[]> {
  try {
    const agents = await fetchAgents(businessId);
    return agents
      .filter((a) => a.enabled)
      .map((a) => ({
        id: a.id,
        name: a.name,
        instructionsSummary: a.instructions.replace(/\s+/g, " ").trim().slice(0, 160)
      }));
  } catch (agentErr) {
    logger.warn("aiflow compile: agent list failed; compiling without agents", {
      businessId,
      error: agentErr instanceof Error ? agentErr.message : String(agentErr)
    });
    return [];
  }
}

/**
 * Connected mailboxes the model may bind send_email `fromConnectionId` /
 * email triggers / email_extract to — so "send it from my sam@ mailbox"
 * binds the REAL connection uuid instead of relying on the never-invent
 * contract alone. Email providers only; labels via the same metadata
 * resolution as the composer's send-from picker. Same degrade posture as
 * documents/agents: a read failure compiles with "(none connected)".
 */
async function loadCompileMailboxes(
  businessId: string,
  fetchConnections: NonNullable<CompileFlowDeps["fetchConnections"]>
): Promise<CompileMailboxOption[]> {
  try {
    const conns = await fetchConnections(businessId);
    return conns
      .filter((c) => isEmailProviderConfigKey(c.provider_config_key))
      .map((c) => {
        const email = connectionEmail(c.metadata);
        return {
          id: c.id,
          label: email ? `${email} (${c.provider_config_key})` : c.provider_config_key
        };
      });
  } catch (connErr) {
    logger.warn("aiflow compile: mailbox list failed; compiling without mailboxes", {
      businessId,
      error: connErr instanceof Error ? connErr.message : String(connErr)
    });
    return [];
  }
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
  const fetchAgents = deps.fetchAgents ?? listBusinessAgents;
  const fetchConnections = deps.fetchConnections ?? listWorkspaceOAuthConnections;
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

  const model = flowCompileModel();

  const compileDocuments = await loadCompileDocuments(args.businessId, fetchDocuments);
  const compileAgents = await loadCompileAgents(args.businessId, fetchAgents);
  const compileMailboxes = await loadCompileMailboxes(args.businessId, fetchConnections);

  const userText = buildFlowCompileUserText(
    args.description,
    compileDocuments,
    compileAgents,
    compileMailboxes
  );
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
      responseMimeType: "application/json",
      thinkingLevel: FLOW_COMPILE_THINKING_LEVEL
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
  // parseAiFlowDefinition, then the DB-backed share_document / run_agent /
  // mailbox-binding checks — so an invalid binding feeds the self-repair
  // loop instead of surfacing later as a save failure.
  const parseAndValidate = async (input: unknown): Promise<AiFlowDefinition> => {
    const definition = parseAiFlowDefinition(input);
    const documentIssues = await validateShareDocumentSteps(args.businessId, definition, {
      fetchDocuments
    });
    const agentIssues = await validateRunAgentSteps(args.businessId, definition, { fetchAgents });
    const mailboxIssues = await validateMailboxConnectionSteps(args.businessId, definition, {
      fetchConnections
    });
    const bindingIssues = [...documentIssues, ...agentIssues, ...mailboxIssues];
    if (bindingIssues.length > 0) {
      throw new AiFlowValidationError("Invalid AiFlow definition", bindingIssues);
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
        documents: compileDocuments,
        agents: compileAgents,
        mailboxes: compileMailboxes
      });
      const { text: repairedRaw, usage: repairUsage } = await generate({
        apiKey,
        model,
        systemInstruction: FLOW_COMPILE_SYSTEM_PROMPT,
        userText: repairText,
        temperature: 0,
        maxOutputTokens: 32000,
        responseMimeType: "application/json",
        thinkingLevel: FLOW_COMPILE_THINKING_LEVEL
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
      const salvageAgentIssues = await validateRunAgentSteps(args.businessId, salvaged.definition, {
        fetchAgents
      }).catch(() => [] as string[]);
      const salvageMailboxIssues = await validateMailboxConnectionSteps(
        args.businessId,
        salvaged.definition,
        { fetchConnections }
      ).catch(() => [] as string[]);
      const warnings = [
        ...salvaged.warnings,
        ...salvageDocumentIssues,
        ...salvageAgentIssues,
        ...salvageMailboxIssues
      ];
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

/**
 * Edit one EXISTING definition per the owner's instruction (with the same
 * one-shot self-repair as compile). See module doc: no salvage — the result
 * is applied to a live flow, so anything short of a cleanly validated
 * definition is refused and the caller leaves the flow untouched.
 */
export async function editAiFlowDefinition(
  args: {
    businessId: string;
    /** The flow's current display name (prompt context only). */
    flowName: string;
    /** The flow's current, stored definition. */
    currentDefinition: unknown;
    /** The owner's requested change, plain English. */
    instructions: string;
  },
  deps: CompileFlowDeps = {}
): Promise<CompileFlowResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const generate = deps.generate ?? geminiGenerateTextDetailed;
  const fetchDocuments = deps.fetchDocuments ?? listBusinessDocuments;
  const fetchAgents = deps.fetchAgents ?? listBusinessAgents;
  const fetchConnections = deps.fetchConnections ?? listWorkspaceOAuthConnections;
  /* c8 ignore stop */

  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) {
    return {
      ok: false,
      error: "not_configured",
      message: "AI assist is not configured",
      issues: []
    };
  }

  const model = flowCompileModel();
  const compileDocuments = await loadCompileDocuments(args.businessId, fetchDocuments);
  const compileAgents = await loadCompileAgents(args.businessId, fetchAgents);
  const compileMailboxes = await loadCompileMailboxes(args.businessId, fetchConnections);

  const userText = buildFlowEditUserText({
    currentName: args.flowName,
    currentDefinitionJson: JSON.stringify(args.currentDefinition),
    instructions: args.instructions,
    documents: compileDocuments,
    agents: compileAgents,
    mailboxes: compileMailboxes
  });
  let raw: string;
  let usage: GeminiUsage | null;
  try {
    ({ text: raw, usage } = await generate({
      apiKey,
      model,
      systemInstruction: FLOW_COMPILE_SYSTEM_PROMPT,
      userText,
      temperature: 0,
      maxOutputTokens: 32000,
      responseMimeType: "application/json",
      thinkingLevel: FLOW_COMPILE_THINKING_LEVEL
    }));
  } catch (err) {
    // Empty replies (thinking-only output) are still billed — meter first.
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
    void recordSystemLog({
      businessId: args.businessId,
      source: "app",
      level: "warn",
      event: "aiflow_edit_failed",
      message: "AI did not return a usable edited automation",
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
      message: "AI did not return a usable edited automation — the flow was not changed",
      issues: []
    };
  }

  // Same validation layering as compile: shape+semantics, then the
  // DB-backed document/agent/mailbox binding checks.
  const parseAndValidate = async (input: unknown): Promise<AiFlowDefinition> => {
    const definition = parseAiFlowDefinition(input);
    const documentIssues = await validateShareDocumentSteps(args.businessId, definition, {
      fetchDocuments
    });
    const agentIssues = await validateRunAgentSteps(args.businessId, definition, { fetchAgents });
    const mailboxIssues = await validateMailboxConnectionSteps(args.businessId, definition, {
      fetchConnections
    });
    const bindingIssues = [...documentIssues, ...agentIssues, ...mailboxIssues];
    if (bindingIssues.length > 0) {
      throw new AiFlowValidationError("Invalid AiFlow definition", bindingIssues);
    }
    return definition;
  };

  try {
    const definition = await parseAndValidate(candidate);
    return { ok: true, definition, warnings: [] };
  } catch (err) {
    if (!(err instanceof AiFlowValidationError)) throw err;
    void recordSystemLog({
      businessId: args.businessId,
      source: "app",
      level: "warn",
      event: "aiflow_edit_failed",
      message: "AI produced an invalid edited automation (attempting self-repair)",
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
        description: `Edit the existing automation "${args.flowName}". Requested changes: ${args.instructions.trim()}`,
        candidateJson: JSON.stringify(candidate),
        issues: err.issues,
        documents: compileDocuments,
        agents: compileAgents,
        mailboxes: compileMailboxes
      });
      const { text: repairedRaw, usage: repairUsage } = await generate({
        apiKey,
        model,
        systemInstruction: FLOW_COMPILE_SYSTEM_PROMPT,
        userText: repairText,
        temperature: 0,
        maxOutputTokens: 32000,
        responseMimeType: "application/json",
        thinkingLevel: FLOW_COMPILE_THINKING_LEVEL
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
        logger.warn("aiflow edit self-repair call failed", {
          businessId: args.businessId,
          error: repairErr instanceof Error ? repairErr.message : String(repairErr)
        });
      }
    }
    // NO salvage: a mechanically-mended definition without a review step
    // could silently drop the very steps the owner cares about. Refuse and
    // leave the live flow byte-identical.
    void recordSystemLog({
      businessId: args.businessId,
      source: "app",
      level: "warn",
      event: "aiflow_edit_failed",
      message: "AI produced an invalid edited automation (after self-repair); edit refused",
      payload: { model, reason: "schema_after_repair", issues: repairIssues }
    });
    return {
      ok: false,
      error: "invalid",
      message: invalidEditMessage(repairIssues),
      issues: repairIssues
    };
  }
}
