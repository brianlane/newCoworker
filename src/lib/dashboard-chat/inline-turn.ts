/**
 * Dashboard-chat INLINE turn engine — platform Gemini with creation tools.
 *
 * Runs one owner-chat turn directly on central Gemini (function calling via
 * geminiChatStep) instead of enqueueing to the VPS chat-worker. This is the
 * PRIMARY path (see routing.ts); it exists because it can do what the
 * worker path cannot:
 *
 *   - read ATTACHMENTS (PDF via native inlineData, text formats inline),
 *   - CREATE things: `create_aiflow` runs the shared compile pipeline
 *     (validated, never trusted blindly) and `create_agent` drafts a
 *     reusable agent — both are returned as DRAFTS the UI hands off to the
 *     builder/editor for review; nothing is persisted here.
 *
 * The caller (chat route) owns prompt assembly (same system blocks as the
 * worker path), persistence, email-block fulfilment, and memory capture.
 * Every model step is metered into the shared AI budget (surface
 * `dashboard_chat`); compile calls meter separately under `aiflow_compile`.
 */

import {
  buildFunctionResponseContent,
  geminiChatStep,
  type GeminiChatContent,
  type GeminiChatStepParams,
  type GeminiChatStepResult,
  type GeminiFunctionDeclaration
} from "@/lib/gemini-chat";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import {
  compileAiFlowFromDescription,
  type CompileFlowDeps,
  type CompileFlowResult
} from "@/lib/ai-flows/compile-service";
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";
import {
  AGENT_INSTRUCTIONS_MAX_CHARS,
  AGENT_NAME_MAX_CHARS,
  type AgentOutputFormat
} from "@/lib/agents/core";
import { logger } from "@/lib/logger";

/** Attachment formats the inline turn understands. */
export const CHAT_ATTACHMENT_TEXT_MIME_TYPES = ["text/plain", "text/markdown", "text/csv"] as const;
export const CHAT_ATTACHMENT_PDF_MIME_TYPE = "application/pdf";
/** Inline text from an attachment is clipped to keep the prompt bounded. */
export const CHAT_ATTACHMENT_MAX_TEXT_CHARS = 40_000;

export type InlineTurnAttachment = {
  filename: string;
  mimeType: string;
  data: Buffer;
};

export type InlineChatDraft =
  | {
      kind: "aiflow";
      definition: AiFlowDefinition;
      warnings: string[];
    }
  | {
      kind: "agent";
      name: string;
      instructions: string;
      outputFormat: AgentOutputFormat;
    };

export type InlineTurnResult =
  | { ok: true; content: string; drafts: InlineChatDraft[] }
  | { ok: false; error: "model_failed" | "empty"; detail?: string };

const CREATION_TOOLS: GeminiFunctionDeclaration[] = [
  {
    name: "create_aiflow",
    description:
      "Draft a new AiFlow automation from a plain-English description. Use ONLY when the owner asks to create/build an automation, workflow, or AiFlow. Write a complete, specific description including: what starts it (a text, an email, a webhook, a schedule), every step in order, and any exact message wording the owner gave. The platform compiles and validates it into a draft the owner reviews in the AiFlows builder — it is NOT activated automatically.",
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Complete plain-English automation spec (trigger + ordered steps + exact wording)."
        }
      },
      required: ["description"]
    }
  },
  {
    name: "create_agent",
    description:
      "Draft a new reusable Agent: a saved instruction set the owner runs repeatedly against attachments (PDF/text/markdown/CSV) to get the same kind of output every time — e.g. 'turn an intake form into a clean client summary'. Use ONLY when the owner asks to create a reusable document task/agent. The draft opens pre-filled in the Agents editor for the owner to review and save — it is NOT saved automatically.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short agent name, e.g. 'Intake form summarizer'." },
        instructions: {
          type: "string",
          description: "The reusable instructions applied to each attachment."
        },
        output_format: {
          type: "string",
          enum: ["markdown", "same_as_input"],
          description:
            "markdown (default, works for everything) or same_as_input (CSV in → CSV out)."
        }
      },
      required: ["name", "instructions"]
    }
  }
];

/** Bound on model↔tool round-trips per turn. */
const MAX_TOOL_STEPS = 4;

const DEFAULT_INLINE_MODEL = "gemini-3.1-flash";

function resolveModel(): string {
  const configured = (process.env.DASHBOARD_CHAT_MODEL ?? "").trim();
  return configured.length > 0 ? configured : DEFAULT_INLINE_MODEL;
}

/**
 * Render the attachment into the user turn: text formats are decoded and
 * inlined (clipped); PDFs ride along as an inlineData part.
 */
export function buildAttachmentParts(attachment: InlineTurnAttachment): {
  textBlock: string;
  inlinePart: Record<string, unknown> | null;
} {
  const mime = attachment.mimeType.trim().toLowerCase();
  if ((CHAT_ATTACHMENT_TEXT_MIME_TYPES as readonly string[]).includes(mime)) {
    const text = attachment.data
      .toString("utf8")
      .replace(/\u0000/g, "")
      .trim()
      .slice(0, CHAT_ATTACHMENT_MAX_TEXT_CHARS);
    return {
      textBlock: `Attached file "${attachment.filename}" (may be truncated):\n---\n${text}\n---`,
      inlinePart: null
    };
  }
  return {
    textBlock: `The file "${attachment.filename}" is attached.`,
    inlinePart: {
      inlineData: { mimeType: CHAT_ATTACHMENT_PDF_MIME_TYPE, data: attachment.data.toString("base64") }
    }
  };
}

type ChatStepCall = (params: GeminiChatStepParams) => Promise<GeminiChatStepResult>;

export type InlineTurnDeps = {
  /** Injectable model step (tests). */
  chatStep?: ChatStepCall;
  /** Injectable compile pipeline (tests). */
  compileFlow?: (
    args: { businessId: string; description: string },
    deps?: CompileFlowDeps
  ) => Promise<CompileFlowResult>;
};

/** Execute one requested tool call; returns the functionResponse payload. */
async function executeToolCall(
  businessId: string,
  call: { name: string; args: Record<string, unknown> },
  drafts: InlineChatDraft[],
  compileFlow: NonNullable<InlineTurnDeps["compileFlow"]>
): Promise<unknown> {
  if (call.name === "create_aiflow") {
    const description = typeof call.args.description === "string" ? call.args.description.trim() : "";
    if (!description) {
      return { ok: false, message: "description is required" };
    }
    try {
      const result = await compileFlow({ businessId, description: description.slice(0, 4000) });
      if (!result.ok) {
        return { ok: false, message: result.message };
      }
      drafts.push({ kind: "aiflow", definition: result.definition, warnings: result.warnings });
      return {
        ok: true,
        stepCount: result.definition.steps.length,
        triggerChannel: result.definition.trigger.channel,
        warnings: result.warnings,
        note: "Draft created and validated. The owner will see an 'Open in AiFlows builder' card under your reply — tell them to review and save it there. Do NOT repeat the JSON definition in your reply."
      };
    } catch (err) {
      logger.warn("dashboard-chat create_aiflow tool failed", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      return { ok: false, message: "The automation drafting service failed — try again later." };
    }
  }
  if (call.name === "create_agent") {
    const name = typeof call.args.name === "string" ? call.args.name.trim() : "";
    const instructions =
      typeof call.args.instructions === "string" ? call.args.instructions.trim() : "";
    const outputFormat: AgentOutputFormat =
      call.args.output_format === "same_as_input" ? "same_as_input" : "markdown";
    if (!name || !instructions) {
      return { ok: false, message: "name and instructions are required" };
    }
    drafts.push({
      kind: "agent",
      name: name.slice(0, AGENT_NAME_MAX_CHARS),
      instructions: instructions.slice(0, AGENT_INSTRUCTIONS_MAX_CHARS),
      outputFormat
    });
    return {
      ok: true,
      note: "Agent draft created. The owner will see an 'Open in Agents' card under your reply — tell them to review and save it there."
    };
  }
  return { ok: false, message: `unknown tool: ${call.name}` };
}

/**
 * Run one inline chat turn. Returns the final assistant text plus any
 * drafts created along the way. `ok:false` means the caller should fall
 * back to the worker path (text-only turns) or surface an honest failure
 * (attachment turns).
 */
export async function runInlineChatTurn(
  args: {
    businessId: string;
    /** Concatenated system blocks (same content as the worker path's system messages). */
    systemInstruction: string;
    /** The owner's message, already carrying the "[Dashboard] " channel marker. */
    userMessage: string;
    attachment?: InlineTurnAttachment | null;
  },
  deps: InlineTurnDeps = {}
): Promise<InlineTurnResult> {
  /* c8 ignore next 2 -- production defaults; tests inject */
  const chatStep = deps.chatStep ?? geminiChatStep;
  const compileFlow = deps.compileFlow ?? compileAiFlowFromDescription;

  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) return { ok: false, error: "model_failed", detail: "not_configured" };
  const model = resolveModel();

  const userParts: Array<Record<string, unknown>> = [{ text: args.userMessage }];
  if (args.attachment) {
    const { textBlock, inlinePart } = buildAttachmentParts(args.attachment);
    userParts.push({ text: textBlock });
    if (inlinePart) userParts.push(inlinePart);
  }
  const contents: GeminiChatContent[] = [{ role: "user", parts: userParts }];

  const drafts: InlineChatDraft[] = [];
  const texts: string[] = [];
  const inputCharsEstimate = args.systemInstruction.length + args.userMessage.length;

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const controller = new AbortController();
    /* c8 ignore next -- timer fires only on a real Gemini hang */
    const timer = setTimeout(() => controller.abort(), 90_000);
    let result: GeminiChatStepResult;
    try {
      result = await chatStep({
        apiKey,
        model,
        systemInstruction: args.systemInstruction,
        contents,
        tools: CREATION_TOOLS,
        temperature: 0.3,
        maxOutputTokens: 4000,
        signal: controller.signal
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn("dashboard-chat inline turn: model step failed", {
        businessId: args.businessId,
        step,
        error: detail
      });
      // A wrap-up step that fails AFTER a tool already produced drafts must
      // not discard them — the compile spend is real and the draft is the
      // deliverable. Degrade to the stock hand-off line instead of failing
      // the turn (which would drop the cards and, on text turns, bounce the
      // whole turn to the worker).
      if (drafts.length > 0) break;
      return { ok: false, error: "model_failed", detail };
    } finally {
      clearTimeout(timer);
    }

    await meterGeminiSpendForBusiness({
      businessId: args.businessId,
      model,
      surface: "dashboard_chat",
      usage: result.usage,
      inputChars: inputCharsEstimate,
      outputChars: result.text?.length ?? 0
    });

    if (result.text) texts.push(result.text);

    if (result.functionCalls.length === 0 || !result.modelContent) {
      break;
    }
    // Execute the requested tools, then hand the results back for the next
    // model step (Gemini requires the functionCall content to precede its
    // functionResponse turn).
    contents.push(result.modelContent);
    const responses: Array<{ name: string; response: unknown }> = [];
    for (const call of result.functionCalls) {
      responses.push({
        name: call.name,
        response: await executeToolCall(args.businessId, call, drafts, compileFlow)
      });
    }
    contents.push(buildFunctionResponseContent(responses));
    // The post-tool step produces the user-facing wrap-up; interim text
    // that accompanied a tool request (rare) is superseded by it.
    texts.length = 0;
  }

  const content = texts.join("\n\n").trim();
  if (!content && drafts.length === 0) {
    return { ok: false, error: "empty" };
  }
  return {
    ok: true,
    // A tool-created draft with a silent final step still deserves a line.
    content:
      content ||
      "Done — I've prepared a draft for you. Open it from the card below to review and save.",
    drafts
  };
}
