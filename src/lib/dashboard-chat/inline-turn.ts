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
 * It also exposes `business_knowledge_lookup` (the same core the Rowboat
 * dashboard agent calls through /api/rowboat/tool-call, staff audience) so
 * the PRIMARY path keeps knowledge-base grounding — without it, owner
 * questions like "what's our renewal process?" would only be answerable on
 * the worker FALLBACK path. Declared only when the owner's Settings →
 * Coworker tools toggle allows it (same gate the Rowboat route checks).
 *
 * ACTION-TOOL PARITY (see action-tools.ts): `send_sms` and the calendar
 * lifecycle tools (find/book/reschedule/cancel) are declared per the same
 * Settings gates the Rowboat dispatch enforces, so the primary path can
 * text and manage appointments exactly like the worker path always could.
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
import { lookupBusinessKnowledge } from "@/lib/knowledge-tools/handlers";
import {
  actionToolDeclarations,
  executeActionTool,
  isActionToolName,
  type ActionToolGates,
  type ActionToolName
} from "@/lib/dashboard-chat/action-tools";
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

/**
 * Knowledge-base grounding for the inline path. Same core + staff audience
 * as the Rowboat dashboard agent's `dashboard_business_knowledge_lookup`;
 * only declared when the owner's Settings toggle allows it.
 */
const KNOWLEDGE_TOOL: GeminiFunctionDeclaration = {
  name: "business_knowledge_lookup",
  description:
    "Answer a question about THIS business from its approved knowledge base: uploaded business documents, the crawled website summary, and the business's identity/memory. Use whenever the owner asks an operational or business-specific question (processes, policies, required documents, services, hours, what the website says). Returns a grounded answer, or an honest not-found — never invent an answer instead of calling this.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The owner's question, self-contained (include the subject, not just 'it')."
      }
    },
    required: ["question"]
  }
};

/** Bound on model↔tool round-trips per turn. */
const MAX_TOOL_STEPS = 4;

const DEFAULT_INLINE_MODEL = "gemini-3.5-flash";
/**
 * Same 404 safety net as knowledge-tools/handlers.ts: a configured (or
 * newly defaulted) model id that Google has retired/renamed must degrade to
 * a known-live id instead of killing the whole inline path — a dead inline
 * path silently demotes text turns to the worker and hard-fails attachment
 * turns (exactly what shipped when the default was `gemini-3.1-flash`, an
 * id that does not exist on the Gemini API).
 */
const INLINE_FALLBACK_MODEL = "gemini-3-flash-preview";

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
  /** Injectable knowledge lookup (tests). */
  lookupKnowledge?: typeof lookupBusinessKnowledge;
  /** Injectable action-tool executor (tests). */
  runActionTool?: typeof executeActionTool;
};

/**
 * Action tools whose execution commits an IRREVERSIBLE side effect (a text
 * leaves, a calendar mutates, a link is minted). find_slots is a pure read.
 * Once one of these has RUN, a later model-step failure must never bounce
 * the turn to the worker fallback — the worker would re-answer the same
 * owner message and could re-send/re-book (Bugbot High on PR #668).
 */
const SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  "send_sms",
  "calendar_book_appointment",
  "calendar_reschedule_appointment",
  "calendar_cancel_appointment"
]);

/** Committed side effects + the user-facing facts a degraded wrap-up must carry. */
type SideEffectLog = { happened: boolean; notes: string[] };

/**
 * The owner-facing fact line for one confirmed side effect, used when the
 * wrap-up model step fails or goes silent. Without it the degraded reply
 * would swallow load-bearing values — most critically a Calendly
 * reschedule/booking LINK the owner still has to send onward.
 */
function sideEffectNote(name: ActionToolName, result: unknown): string {
  const r = result as {
    toE164?: unknown;
    sentBody?: unknown;
    data?: { bookingLink?: unknown; rescheduleLink?: unknown };
  };
  if (name === "send_sms") {
    const to = typeof r.toE164 === "string" ? r.toE164 : "the recipient";
    const body = typeof r.sentBody === "string" ? ` — "${r.sentBody}"` : "";
    return `Text sent to ${to}${body}.`;
  }
  if (name === "calendar_book_appointment") {
    return typeof r.data?.bookingLink === "string"
      ? `Single-use booking link created (the appointment is NOT booked until the attendee completes it): ${r.data.bookingLink}`
      : "The appointment was booked.";
  }
  if (name === "calendar_reschedule_appointment") {
    return typeof r.data?.rescheduleLink === "string"
      ? `Reschedule link created (the appointment is NOT moved until the attendee picks the new time): ${r.data.rescheduleLink}`
      : "The appointment was rescheduled.";
  }
  return "The appointment was canceled.";
}

/** Execute one requested tool call; returns the functionResponse payload. */
async function executeToolCall(
  businessId: string,
  call: { name: string; args: Record<string, unknown> },
  drafts: InlineChatDraft[],
  compileFlow: NonNullable<InlineTurnDeps["compileFlow"]>,
  lookupKnowledge: NonNullable<InlineTurnDeps["lookupKnowledge"]>,
  runActionTool: NonNullable<InlineTurnDeps["runActionTool"]>,
  declaredActionTools: ReadonlySet<string>,
  sideEffects: SideEffectLog
): Promise<unknown> {
  // Action tools (send_sms + calendar lifecycle): only dispatch names that
  // were actually DECLARED this turn — a Settings-disabled tool the model
  // hallucinates a call to must fail closed, not execute anyway.
  if (isActionToolName(call.name)) {
    if (!declaredActionTools.has(call.name)) {
      return { ok: false, message: `unknown tool: ${call.name}` };
    }
    const result = await runActionTool(businessId, { name: call.name, args: call.args });
    // Marked only on a CONFIRMED effect (ok:true): a cleanly-refused send
    // (opt-out, validation, quota) or failed booking committed nothing, so
    // pinning the turn would both suppress a legitimate worker fallback and
    // let the degraded copy imply an action that never happened.
    if (
      SIDE_EFFECT_TOOLS.has(call.name) &&
      typeof result === "object" &&
      result !== null &&
      (result as { ok?: unknown }).ok === true
    ) {
      sideEffects.happened = true;
      sideEffects.notes.push(sideEffectNote(call.name, result));
    }
    return result;
  }
  if (call.name === "business_knowledge_lookup") {
    const question = typeof call.args.question === "string" ? call.args.question.trim() : "";
    if (!question) {
      return { ok: false, message: "question is required" };
    }
    try {
      // Owner dashboard reads as staff — sees internal docs, same audience
      // the Rowboat tool-call route resolves for dashboard_* tool names.
      const result = await lookupKnowledge(businessId, question.slice(0, 2000), {
        audience: "staff"
      });
      if (!result.ok || !result.data) {
        return {
          ok: false,
          message:
            "The knowledge base couldn't answer right now. Tell the owner you couldn't check the knowledge base — do NOT invent an answer."
        };
      }
      return { ok: true, answer: result.data.answer };
    } catch (err) {
      logger.warn("dashboard-chat business_knowledge_lookup tool failed", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      return {
        ok: false,
        message:
          "The knowledge base couldn't answer right now. Tell the owner you couldn't check the knowledge base — do NOT invent an answer."
      };
    }
  }
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
    /**
     * Settings → Coworker tools gate for `business_knowledge_lookup`
     * (dashboard agent). The route reads it once per turn, exactly like
     * `emailToolEnabled`; when false the tool is not even declared.
     */
    knowledgeToolEnabled?: boolean;
    /**
     * Settings → Coworker tools gates for the ACTION tools (send_sms +
     * calendar lifecycle) — worker-path parity: the Rowboat OwnerCoworker
     * has had these since launch, so the primary path must too. Omitted
     * (e.g. older callers/tests) ⇒ no action tools declared.
     */
    actionToolGates?: ActionToolGates | null;
  },
  deps: InlineTurnDeps = {}
): Promise<InlineTurnResult> {
  /* c8 ignore next 4 -- production defaults; tests inject */
  const chatStep = deps.chatStep ?? geminiChatStep;
  const compileFlow = deps.compileFlow ?? compileAiFlowFromDescription;
  const lookupKnowledge = deps.lookupKnowledge ?? lookupBusinessKnowledge;
  const runActionTool = deps.runActionTool ?? executeActionTool;

  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) return { ok: false, error: "model_failed", detail: "not_configured" };
  let model = resolveModel();
  const actionDeclarations = args.actionToolGates
    ? actionToolDeclarations(args.actionToolGates)
    : [];
  const declaredActionTools: ReadonlySet<string> = new Set(
    actionDeclarations.map((d) => d.name)
  );
  const tools = [
    ...(args.knowledgeToolEnabled === false ? CREATION_TOOLS : [...CREATION_TOOLS, KNOWLEDGE_TOOL]),
    ...actionDeclarations
  ];

  const userParts: Array<Record<string, unknown>> = [{ text: args.userMessage }];
  if (args.attachment) {
    const { textBlock, inlinePart } = buildAttachmentParts(args.attachment);
    userParts.push({ text: textBlock });
    if (inlinePart) userParts.push(inlinePart);
  }
  const contents: GeminiChatContent[] = [{ role: "user", parts: userParts }];

  const drafts: InlineChatDraft[] = [];
  const texts: string[] = [];
  // Set the moment a SIDE_EFFECT_TOOLS call CONFIRMS (ok:true) — from then
  // on this turn must never resolve ok:false (the worker fallback would
  // rerun the owner's message and duplicate the send/booking). Notes carry
  // the facts a degraded wrap-up must not lose (links, sent bodies).
  const sideEffects: SideEffectLog = { happened: false, notes: [] };
  const inputCharsEstimate = args.systemInstruction.length + args.userMessage.length;

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const controller = new AbortController();
    /* c8 ignore next -- timer fires only on a real Gemini hang */
    const timer = setTimeout(() => controller.abort(), 90_000);
    let result: GeminiChatStepResult;
    try {
      const stepParams = {
        apiKey,
        systemInstruction: args.systemInstruction,
        contents,
        tools,
        temperature: 0.3,
        maxOutputTokens: 4000,
        signal: controller.signal
      };
      try {
        result = await chatStep({ ...stepParams, model });
      } catch (err) {
        // Retired/renamed model id: degrade to the known-live fallback for
        // the REST of the turn instead of failing the whole inline path
        // (mirrors knowledge-tools/handlers.ts). Any other error rethrows
        // to the outer handler unchanged.
        const detail = err instanceof Error ? err.message : String(err);
        if (!/^gemini_http_404(?::|$)/.test(detail) || model === INLINE_FALLBACK_MODEL) {
          throw err;
        }
        logger.warn("dashboard-chat inline turn: model 404; using fallback model", {
          businessId: args.businessId,
          from: model,
          to: INLINE_FALLBACK_MODEL
        });
        model = INLINE_FALLBACK_MODEL;
        result = await chatStep({ ...stepParams, model });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn("dashboard-chat inline turn: model step failed", {
        businessId: args.businessId,
        step,
        error: detail
      });
      // A wrap-up step that fails AFTER a tool already produced drafts must
      // not discard them — the compile spend is real and the draft is the
      // deliverable. Same for a turn that already COMMITTED a side effect
      // (a text sent, an appointment mutated): failing it would bounce the
      // turn to the worker, which re-answers the same owner message and
      // could re-send/re-book. Degrade to an honest stored line instead.
      if (drafts.length > 0 || sideEffects.happened) break;
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
        response: await executeToolCall(
          args.businessId,
          call,
          drafts,
          compileFlow,
          lookupKnowledge,
          runActionTool,
          declaredActionTools,
          sideEffects
        )
      });
    }
    contents.push(buildFunctionResponseContent(responses));
    // The post-tool step produces the user-facing wrap-up; interim text
    // that accompanied a tool request (rare) is superseded by it.
    texts.length = 0;
  }

  const content = texts.join("\n\n").trim();
  if (!content && drafts.length === 0 && !sideEffects.happened) {
    return { ok: false, error: "empty" };
  }
  return {
    ok: true,
    // A tool-created draft (or committed side effect) with a silent final
    // step still deserves an honest line — and must not fail the turn,
    // which would re-run it on the worker. The side-effect notes carry the
    // facts the lost wrap-up would have relayed (links, sent bodies).
    content:
      content ||
      (drafts.length > 0
        ? "Done — I've prepared a draft for you. Open it from the card below to review and save."
        : `Done — the requested action went through, but I hit a hiccup writing my summary. What happened:\n${sideEffects.notes.map((n) => `- ${n}`).join("\n")}`),
    drafts
  };
}
