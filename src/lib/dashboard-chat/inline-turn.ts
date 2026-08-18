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
  AGENT_OUTPUT_FORMATS,
  type AgentOutputFormat
} from "@/lib/agents/core";
import { lookupBusinessKnowledge } from "@/lib/knowledge-tools/handlers";
import type { EditSurfaceKind } from "@/lib/ai-flows/edit-flow-tool";
import {
  actionToolDeclarations,
  executeActionTool,
  isActionToolName,
  type ActionToolGates,
  type ActionToolName
} from "@/lib/dashboard-chat/action-tools";
import { logger } from "@/lib/logger";
import { VTT_MIME_TYPE, vttToPlainText } from "@/lib/transcripts/vtt";

/** Attachment formats the inline turn understands. */
export const CHAT_ATTACHMENT_TEXT_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  // Meeting transcripts (Zoom/Meet/Teams) — converted from cue soup to
  // "Speaker: sentence" lines below, NEVER sent as a PDF inline part.
  VTT_MIME_TYPE
] as const;
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

/**
 * A caller-composed extra tool set (the MCP bridge). The engine stays
 * ignorant of what the tools are: the caller supplies declarations that
 * are appended to the turn's tool list, a never-throwing executor for
 * calls to those names, the subset of names whose ok:true result COMMITS
 * a side effect (pinning the turn against the worker-fallback rerun,
 * exactly like SIDE_EFFECT_TOOLS), and the owner-facing fact line a
 * degraded wrap-up must carry for each committed effect.
 */
export type InlineExtraTools = {
  declarations: GeminiFunctionDeclaration[];
  execute: (call: { name: string; args: Record<string, unknown> }) => Promise<unknown>;
  sideEffectNames: ReadonlySet<string>;
  noteFor: (name: string, result: unknown) => string;
};

const CREATION_TOOLS: GeminiFunctionDeclaration[] = [
  {
    name: "create_aiflow",
    description:
      "Draft a new AiFlow automation from a plain-English description. Use ONLY when the owner asks to create/build an automation, workflow, or AiFlow. Write a complete, specific description including: what starts it (a text, an email, a webhook, a schedule), every step in order, and any exact message wording the owner gave. The platform compiles and validates it into a draft the owner reviews in the AiFlows builder, it is NOT activated automatically.",
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
      "Draft a new reusable Agent: a saved instruction set the owner runs repeatedly against attachments (PDF/text/markdown/CSV) to get the same kind of output every time, e.g. 'turn an intake form into a clean client summary'. Use ONLY when the owner asks to create a reusable document task/agent. The draft opens pre-filled in the Agents editor for the owner to review and save, it is NOT saved automatically.",
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
          enum: ["markdown", "same_as_input", "pdf", "docx"],
          description:
            "markdown (default, works for everything), same_as_input (CSV in → CSV out), pdf (typeset PDF file), or docx (typeset Word file)."
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
    "Answer a question about THIS business from its approved knowledge base: uploaded business documents, the crawled website summary, and the business's identity/memory. Use whenever the owner asks an operational or business-specific question (processes, policies, required documents, services, hours, what the website says). Returns a grounded answer, or an honest not-found, never invent an answer instead of calling this.",
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

// gemini-3.7-flash (GA Aug 13 2026): successor to 3.6-flash on agentic/
// tool-loop work at the same post-intro list price ($1.50/$7.50 per 1M).
const DEFAULT_INLINE_MODEL = "gemini-3.7-flash";
/**
 * Same 404 safety net as knowledge-tools/handlers.ts: a configured (or
 * newly defaulted) model id that Google has retired/renamed must degrade to
 * a known-live id instead of killing the whole inline path — a dead inline
 * path silently demotes text turns to the worker and hard-fails attachment
 * turns (exactly what shipped when the default was `gemini-3.1-flash`, an
 * id that does not exist on the Gemini API). The fallback deliberately sits
 * on a GA id from a DIFFERENT family than the primary (a "-preview" id can
 * itself be retired).
 */
const INLINE_FALLBACK_MODEL = "gemini-3.5-flash-lite";

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
    const decoded = attachment.data.toString("utf8").replace(/\u0000/g, "");
    const asText = mime === VTT_MIME_TYPE ? vttToPlainText(decoded) : decoded;
    const text = asText.trim().slice(0, CHAT_ATTACHMENT_MAX_TEXT_CHARS);
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
  "send_whatsapp",
  "calendar_book_appointment",
  "calendar_reschedule_appointment",
  "calendar_cancel_appointment",
  // A run_aiflow enqueue is committed the moment it lands in the queue —
  // a fallback rerun would enqueue the same automation twice.
  "run_aiflow",
  // An edit_aiflow update is persisted to the live flow the moment the core
  // reports applied:true. NOTE the extra condition in committedSideEffect
  // below: edit_aiflow also returns ok:true when it merely STAGED a change
  // for the owner to confirm, and that wrote nothing.
  "edit_aiflow",
  // An undo restores a definition over the live one just as irreversibly as
  // an edit writes one. Unpinned, a wrap-up failure would let the worker
  // fallback re-run the message and undo a SECOND time (stepping back past
  // the change the owner actually meant to keep), or answer as though
  // nothing had happened when it already had.
  "undo_aiflow_edit",
  // A generated image is stored, metered against the AI budget, and burns
  // one of the 3 per-conversation slots the moment the core returns ok —
  // a worker-fallback rerun would bill and consume a slot all over again.
  "generate_image",
  // Notification toggles persist the moment the core returns ok. The worker
  // fallback deliberately does NOT declare this tool (no caller role on that
  // path), so a post-write model failure falling back would produce a reply
  // claiming the change is impossible — contradicting a write that already
  // happened (Bugbot Medium on PR #805).
  "update_notification_preferences",
  // The spam flag's opt-out write is IRREVERSIBLE the moment the core
  // returns ok (only the contact texting START lifts it). The worker
  // fallback never declares this tool, so a post-write model failure
  // falling back would deny an action that already happened (Bugbot
  // Medium on PR #884).
  "flag_contact_spam",
  // The reply-mode write + run cancels persist the moment the core returns
  // ok; same fallback-denial hazard as the spam flag.
  "set_contact_reply_mode",
  // The roster write persists the moment the core returns ok, and the worker
  // fallback never declares this tool, so falling back would tell the owner
  // their teammate was not added after the row already exists.
  "manage_employee"
]);

/** Committed side effects + the user-facing facts a degraded wrap-up must carry. */
type SideEffectLog = { happened: boolean; notes: string[] };

/**
 * Whether an ok:true result actually COMMITTED something.
 *
 * `edit_aiflow` is the one tool whose success does not imply a write: the
 * first call of the confirm handshake stages a change and returns ok:true
 * having touched nothing. Pinning on that would let a degraded wrap-up tell
 * the owner their automation was updated when it was only described, and
 * would suppress the worker fallback that should have answered instead.
 */
function committedSideEffect(name: ActionToolName, result: unknown): boolean {
  if (!SIDE_EFFECT_TOOLS.has(name)) return false;
  if (typeof result !== "object" || result === null) return false;
  if ((result as { ok?: unknown }).ok !== true) return false;
  if (name === "edit_aiflow") return (result as { applied?: unknown }).applied === true;
  return true;
}

/**
 * How many automations one turn may actually CHANGE. One.
 *
 * A turn can make several tool calls, so a single message could otherwise
 * rewrite three automations before anyone read a word of it. A written-out
 * multi-part spec ("change these six things across the flows") is a project,
 * not a message: the first change goes through the normal confirm handshake
 * and the rest are refused with a pointer, which is also what keeps the
 * owner's confirmation meaningful (they approved ONE described diff).
 *
 * Staging is deliberately not capped: staging writes nothing, and letting
 * the model describe what it would do to a second automation is useful.
 */
const FLOW_CHANGES_PER_TURN = 1;

/**
 * Whether a call would COMMIT a definition change, as opposed to staging or
 * reading one. `edit_aiflow` only applies when it carries the token from a
 * previous staging call; an undo always applies.
 */
function isFlowChangeCall(call: { name: string; args: Record<string, unknown> }): boolean {
  if (call.name === "undo_aiflow_edit") return true;
  return call.name === "edit_aiflow" && typeof call.args.confirmationToken === "string";
}

/** Per-turn tally of automations actually changed. */
type FlowChangeBudget = { spent: number };

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
    data?: { bookingLink?: unknown; rescheduleLink?: unknown; markdown?: unknown };
  };
  if (name === "send_sms") {
    const to = typeof r.toE164 === "string" ? r.toE164 : "the recipient";
    const body = typeof r.sentBody === "string" ? `, "${r.sentBody}"` : "";
    return `Text sent to ${to}${body}.`;
  }
  if (name === "send_whatsapp") {
    const to = typeof r.toE164 === "string" ? r.toE164 : "the recipient";
    const body = typeof r.sentBody === "string" ? `, "${r.sentBody}"` : "";
    return `WhatsApp message sent to ${to}${body}.`;
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
  if (name === "run_aiflow") {
    const flowName = (r as { flowName?: unknown }).flowName;
    return `Automation run started${typeof flowName === "string" ? ` ("${flowName}")` : ""}, it can be watched at /dashboard/aiflows.`;
  }
  if (name === "edit_aiflow") {
    const flowName = (r as { flowName?: unknown }).flowName;
    return `Automation${typeof flowName === "string" ? ` "${flowName}"` : ""} was updated as requested, it can be reviewed at /dashboard/aiflows.`;
  }
  if (name === "undo_aiflow_edit") {
    const flowName = (r as { flowName?: unknown }).flowName;
    return `Automation${typeof flowName === "string" ? ` "${flowName}"` : ""} was put back to the version before the last change, it can be reviewed at /dashboard/aiflows.`;
  }
  if (name === "generate_image") {
    // The markdown IS the deliverable: without it a degraded wrap-up
    // would charge the owner for an image nobody can see.
    return typeof r.data?.markdown === "string"
      ? `The image was generated:\n\n${r.data.markdown}`
      : "The image was generated, it's saved with this conversation.";
  }
  if (name === "update_notification_preferences") {
    const updated = (r as { updated?: unknown }).updated;
    const changes =
      updated && typeof updated === "object"
        ? Object.entries(updated as Record<string, boolean>)
            .map(([key, value]) => `${key} ${value ? "ON" : "OFF"}`)
            .join(", ")
        : "";
    return `Notification settings were changed${changes ? `: ${changes}` : ""}.`;
  }
  if (name === "set_contact_reply_mode") {
    const phone = (r as { phoneE164?: unknown }).phoneE164;
    const target = typeof phone === "string" ? phone : "the contact";
    const mode = (r as { mode?: unknown }).mode;
    if (mode === "auto") {
      return `Texting resumed for ${target}: the coworker will reply to them automatically again.`;
    }
    // Mirror the core's honesty: an unconfirmed run sweep must not read as
    // "automations were stopped" (Bugbot Medium on PR #898).
    const sweepComplete = (r as { runsSweepComplete?: unknown }).runsSweepComplete !== false;
    return sweepComplete
      ? `Texting stopped for ${target}: the coworker will no longer auto-reply to them and their pending automations were stopped (manual texts still work; reversible).`
      : `Texting stopped for ${target}: the coworker will no longer auto-reply to them, but some of their pending automations could not be confirmed as stopped and may still send (manual texts still work; reversible).`;
  }
  if (name === "flag_contact_spam") {
    // The core's note carries the full honest outcome (blocked numbers,
    // stopped runs, tag state) — keep it, minus the model instruction.
    const phone = (r as { phoneE164?: unknown }).phoneE164;
    const target = typeof phone === "string" ? phone : "the number";
    const note = (r as { note?: unknown }).note;
    const outcome =
      typeof note === "string"
        ? note.replace(/^Tell the owner: /, "")
        : "the number is blocked from all texting and their pending follow-ups were stopped.";
    return `Spam flag applied to ${target}: ${outcome}`;
  }
  if (name === "manage_employee") {
    const employee = (r as { employee?: { name?: unknown; phoneE164?: unknown } }).employee;
    const who =
      typeof employee?.name === "string" && employee.name ? employee.name : "the teammate";
    const phone = typeof employee?.phoneE164 === "string" ? ` (${employee.phoneE164})` : "";
    const action = (r as { action?: unknown }).action;
    if (action === "add") return `${who}${phone} was added to the employee roster.`;
    if (action === "deactivate") {
      return `${who}${phone} was deactivated: they receive no lead offers until reactivated.`;
    }
    if (action === "reactivate") return `${who}${phone} was reactivated on the roster.`;
    // The core's note already states the resulting availability in plain
    // English; keep it minus the model instruction.
    const note = (r as { note?: unknown }).note;
    const outcome =
      typeof note === "string"
        ? note.replace(/^Tell the owner exactly what changed for [^.]*\. /, "")
        : "";
    return `${who}${phone} was updated on the employee roster. ${outcome}`.trim();
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
  sideEffects: SideEffectLog,
  extraTools: InlineExtraTools | null,
  declaredExtraNames: ReadonlySet<string>,
  flowChanges: FlowChangeBudget
): Promise<unknown> {
  // Action tools (send_sms + calendar lifecycle): only dispatch names that
  // were actually DECLARED this turn — a Settings-disabled tool the model
  // hallucinates a call to must fail closed, not execute anyway.
  if (isActionToolName(call.name)) {
    if (!declaredActionTools.has(call.name)) {
      return { ok: false, message: `unknown tool: ${call.name}` };
    }
    if (isFlowChangeCall(call) && flowChanges.spent >= FLOW_CHANGES_PER_TURN) {
      return {
        ok: false,
        message:
          "One automation per message. Another automation was already changed in this turn, so this one was NOT changed. Tell the owner what you did change, and ask them to send the next change as a separate message so they can see each one before it happens."
      };
    }
    const result = await runActionTool(businessId, { name: call.name, args: call.args });
    if (
      isFlowChangeCall(call) &&
      typeof result === "object" &&
      result !== null &&
      (result as { ok?: unknown }).ok === true
    ) {
      flowChanges.spent += 1;
    }
    // Marked only on a CONFIRMED effect: a cleanly-refused send (opt-out,
    // validation, quota), a failed booking, or an edit that was merely
    // STAGED for confirmation committed nothing, so pinning the turn would
    // both suppress a legitimate worker fallback and let the degraded copy
    // imply an action that never happened.
    if (committedSideEffect(call.name, result)) {
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
            "The knowledge base couldn't answer right now. Tell the owner you couldn't check the knowledge base, do NOT invent an answer."
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
          "The knowledge base couldn't answer right now. Tell the owner you couldn't check the knowledge base, do NOT invent an answer."
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
        note: "Draft created and validated. The owner will see an 'Open in AiFlows builder' card under your reply, tell them to review and save it there. Do NOT repeat the JSON definition in your reply."
      };
    } catch (err) {
      logger.warn("dashboard-chat create_aiflow tool failed", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      return { ok: false, message: "The automation drafting service failed, try again later." };
    }
  }
  if (call.name === "create_agent") {
    const name = typeof call.args.name === "string" ? call.args.name.trim() : "";
    const instructions =
      typeof call.args.instructions === "string" ? call.args.instructions.trim() : "";
    const outputFormat: AgentOutputFormat = (
      AGENT_OUTPUT_FORMATS as readonly string[]
    ).includes(call.args.output_format as string)
      ? (call.args.output_format as AgentOutputFormat)
      : "markdown";
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
      note: "Agent draft created. The owner will see an 'Open in Agents' card under your reply, tell them to review and save it there."
    };
  }
  // Extra (bridged) tools, LAST so the built-in names above can never be
  // shadowed by a caller-supplied declaration. Only names the caller
  // actually declared this turn dispatch — a hallucinated call to a
  // gate-filtered bridge tool falls through to the unknown-tool refusal.
  if (extraTools && declaredExtraNames.has(call.name)) {
    let result: unknown;
    try {
      result = await extraTools.execute(call);
    } catch (err) {
      // The executor's contract is never-throw; if it breaks anyway the
      // turn must degrade to an honest tool failure, not die mid-loop.
      logger.warn("dashboard-chat extra tool failed", {
        businessId,
        tool: call.name,
        error: err instanceof Error ? err.message : String(err)
      });
      return {
        ok: false,
        message: `The ${call.name} tool hit an internal error, try again shortly.`
      };
    }
    if (
      extraTools.sideEffectNames.has(call.name) &&
      typeof result === "object" &&
      result !== null &&
      (result as { ok?: unknown }).ok === true
    ) {
      // The effect COMMITTED: pin the turn before formatting anything, and
      // never let a throwing caller-supplied noteFor unpin it by killing
      // the turn after the fact.
      sideEffects.happened = true;
      try {
        sideEffects.notes.push(extraTools.noteFor(call.name, result));
      } catch {
        sideEffects.notes.push(`The ${call.name} action went through.`);
      }
    }
    return result;
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
    /**
     * Declare the create_aiflow / create_agent draft tools (default true).
     * Surfaces with no builder UI to hand a draft card to — owner-over-SMS —
     * pass false so compile work can't succeed into a void.
     */
    includeCreationTools?: boolean;
    /**
     * Caller-composed extra tools (the MCP bridge). The engine appends the
     * declarations, dispatches matching calls through `execute`, and applies
     * the same side-effect pinning rules as the action tools. A name the
     * caller did not declare this turn fails closed like any unknown tool.
     * Omitted/null ⇒ nothing extra is declared.
     */
    extraTools?: InlineExtraTools | null;
    /**
     * Model↔tool round-trip bound for this turn (default MAX_TOOL_STEPS).
     * Surfaces declaring bridged read tools pass a higher bound: "find the
     * contact → read their thread → answer" is three tool steps plus the
     * wrap-up, and the default would truncate legitimate chains mid-work.
     */
    maxToolSteps?: number;
    /**
     * Whole-turn wall-clock budget (ms). Callers whose OWN caller enforces a
     * hard timeout (the SMS worker aborts owner turns at 75s) MUST pass a
     * smaller budget so this engine stops starting/continuing work before
     * that abort — otherwise a slow turn can commit tools AFTER the caller
     * already fell back to another path, leaving the owner a reply that
     * contradicts actions that really happened. When the budget runs out:
     * committed side effects / drafts degrade to the honest ok:true line;
     * a turn that committed nothing fails fast so the fallback stays safe.
     * Omitted = per-step timeouts only (dashboard chat's own 300s function
     * budget applies there).
     */
    budgetMs?: number;
    /**
     * Stream hook for surfaces that can render text progressively (Slack).
     * Called ONLY with the text of a final step (one that requested no
     * tools): interim text accompanying a tool request is superseded by the
     * post-tool wrap-up, and streamed content cannot be unsent. The full
     * final `content` (including degraded-turn notes) still arrives on the
     * result; a throwing callback is swallowed, never failing the turn.
     */
    onTextDelta?: (text: string) => void;
    /**
     * AI-spend surface tag (default "dashboard_chat"). Callers that are a
     * different product surface (Slack chat) pass their own so the usage
     * card attributes the burn honestly.
     */
    spendSurface?: string;
    /**
     * Provenance stamped onto any AiFlow this turn edits, so the definition
     * history says which surface made the change (migration 20260822182135).
     * Per-turn context rather than a tool argument: the model supplies what
     * to change, never who is changing it.
     */
    flowEditSource?: string;
    flowEditActor?: string | null;
    /**
     * "text" where the owner cannot see the automation while deciding (SMS,
     * email): structural edits refuse there and point at the dashboard.
     */
    flowEditSurfaceKind?: EditSurfaceKind;
  },
  deps: InlineTurnDeps = {}
): Promise<InlineTurnResult> {
  /* c8 ignore next 4 -- production defaults; tests inject */
  const chatStep = deps.chatStep ?? geminiChatStep;
  const compileFlow = deps.compileFlow ?? compileAiFlowFromDescription;
  const lookupKnowledge = deps.lookupKnowledge ?? lookupBusinessKnowledge;
  const baseRunActionTool = deps.runActionTool ?? executeActionTool;
  // Wrap rather than widen executeToolCall's parameter list: provenance is
  // the same for every call in the turn, so it belongs on the bound dep.
  const flowEditSource = args.flowEditSource ?? "ai_edit";
  const flowEditActor = args.flowEditActor ?? null;
  const flowEditSurfaceKind = args.flowEditSurfaceKind ?? "rich";
  const runActionTool: typeof executeActionTool = (targetBusinessId, call, callDeps) =>
    baseRunActionTool(targetBusinessId, call, {
      ...callDeps,
      flowEditSource,
      flowEditActor,
      flowEditSurfaceKind
    });

  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) return { ok: false, error: "model_failed", detail: "not_configured" };
  let model = resolveModel();
  const actionDeclarations = args.actionToolGates
    ? actionToolDeclarations(args.actionToolGates)
    : [];
  const declaredActionTools: ReadonlySet<string> = new Set(
    actionDeclarations.map((d) => d.name)
  );
  const creationTools = args.includeCreationTools === false ? [] : CREATION_TOOLS;
  const extraTools = args.extraTools ?? null;
  const declaredExtraNames: ReadonlySet<string> = new Set(
    extraTools?.declarations.map((d) => d.name) ?? []
  );
  const tools = [
    ...creationTools,
    ...(args.knowledgeToolEnabled === false ? [] : [KNOWLEDGE_TOOL]),
    ...actionDeclarations,
    ...(extraTools?.declarations ?? [])
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
  // Per turn, not per call: the cap is about how much one message may change.
  const flowChanges: FlowChangeBudget = { spent: 0 };
  const inputCharsEstimate = args.systemInstruction.length + args.userMessage.length;
  const deadlineMs =
    typeof args.budgetMs === "number" ? Date.now() + Math.max(1, args.budgetMs) : null;
  const maxToolSteps = Math.max(1, args.maxToolSteps ?? MAX_TOOL_STEPS);

  for (let step = 0; step < maxToolSteps; step++) {
    // Budget check BEFORE starting another model step: once the caller's
    // own timeout is near, committing more work (tool calls!) risks acting
    // after the caller already fell back to another reply path.
    const remainingMs = deadlineMs === null ? null : deadlineMs - Date.now();
    if (remainingMs !== null && remainingMs <= 0) {
      logger.warn("dashboard-chat inline turn: budget exhausted", {
        businessId: args.businessId,
        step
      });
      if (drafts.length > 0 || sideEffects.happened) break;
      return { ok: false, error: "model_failed", detail: "budget_exhausted" };
    }
    const controller = new AbortController();
    // The per-step timeout never exceeds what's left of the whole-turn budget.
    const stepTimeoutMs =
      remainingMs === null ? 90_000 : Math.min(90_000, Math.max(1, remainingMs));
    /* c8 ignore next -- timer fires only on a real Gemini hang */
    const timer = setTimeout(() => controller.abort(), stepTimeoutMs);
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
      // Gemini 3 dynamic thinking bills as output and counts against the
      // 4000-token cap — "low" keeps tool-choice reasoning while protecting
      // the cap and owner-facing latency (same posture as the messenger
      // engine; the heavyweight reasoning lives in the compile pipeline at
      // thinking HIGH, not in this loop). Computed per model because the
      // 404 fallback can swap families mid-turn; Gemini 2.5 rejects it.
      const stepFor = (m: string) => ({
        ...stepParams,
        model: m,
        ...(/^gemini-3/i.test(m) ? { thinkingLevel: "low" as const } : {})
      });
      try {
        result = await chatStep(stepFor(model));
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
        result = await chatStep(stepFor(model));
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
      surface: args.spendSurface ?? "dashboard_chat",
      usage: result.usage,
      inputChars: inputCharsEstimate,
      outputChars: result.text?.length ?? 0
    });

    if (result.text) {
      texts.push(result.text);
      // Final-step text only (see the onTextDelta doc above); a throwing
      // callback must never take the turn down with it.
      if (result.functionCalls.length === 0) {
        try {
          args.onTextDelta?.(result.text);
        } catch {
          // Streaming is best-effort by contract.
        }
      }
    }

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
          sideEffects,
          extraTools,
          declaredExtraNames,
          flowChanges
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
  // A tool-created draft (or committed side effect) with a silent final
  // step still deserves an honest line — and must not fail the turn, which
  // would re-run it on the worker. BOTH facts are reported when both
  // happened: the draft hand-off AND the side-effect notes (links, sent
  // bodies) the lost wrap-up would have relayed.
  let fallback = content;
  if (!fallback) {
    const parts: string[] = [];
    if (drafts.length > 0) {
      parts.push(
        "Done, I've prepared a draft for you. Open it from the card below to review and save."
      );
    }
    if (sideEffects.happened) {
      parts.push(
        `${parts.length > 0 ? "Also completed" : "Done, the requested action went through"}, though I hit a hiccup writing my summary. What happened:\n${sideEffects.notes.map((n) => `- ${n}`).join("\n")}`
      );
    }
    fallback = parts.join("\n\n");
  }
  return { ok: true, content: fallback, drafts };
}
