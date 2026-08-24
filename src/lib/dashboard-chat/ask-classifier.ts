/**
 * Classify one owner turn so the engine knows how hard to think about it.
 *
 * Why this exists. An owner ask that can only be satisfied by CHANGING an
 * automation was being answered as if it were a request to REMEMBER
 * something. Amy Laidlaw, 2026-08-23: "when I get notifications like this can
 * you please include whether it's a buyer or seller and their name number and
 * email and website source of the lead and price". The turn saved a memory
 * rule and replied "Going forward, all missed live-transfer and AI intake
 * alerts will include...". Nothing changed, and nothing could have: those
 * alerts come from her AiFlow notify steps and the voice bridge's intake
 * template, and no flow step reads `memory_md`. The owner surface has had
 * `list_aiflows` and `edit_aiflow` the whole time; it simply never looked.
 *
 * The engine runs at `thinkingLevel: "low"` (inline-turn.ts) because that is
 * right for the common turn ("text Dave that the showing moved") and keeps
 * owner-facing latency and the output-token cap under control. It is wrong for
 * "change what all my lead alerts say", which needs the model to go and read
 * the account first. Rather than raise the floor for every turn, classify the
 * ask and escalate only the ones that earn it.
 *
 * Cheap by construction: one strict-JSON call on the small model at thinking
 * `minimal`, the same shape the box's owner-rule capture already runs on every
 * turn (`vps/chat-worker/memory-capture.mjs`). It FAILS OPEN in every failure
 * mode, resolving to `unknown`, which selects exactly today's behavior: low
 * thinking and no directive. A classifier outage must never make the assistant
 * worse than it was before this existed.
 *
 * This does NOT replace the memory capture. A durable preference is still
 * saved; classification decides whether saving it is the WHOLE answer.
 */

import { geminiGenerateTextDetailed } from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";

/**
 * What the owner is asking for.
 *
 * - `automation_change`: fulfilling it means changing what an automation says
 *   or does (its messages, timing, recipients, or steps). Memory alone cannot
 *   deliver it, because no flow step reads memory.
 * - `preference`: a durable rule about how the coworker itself behaves in
 *   conversation. Memory IS the mechanism, and it genuinely works.
 * - `action`: do something now (send a text, book, look someone up).
 * - `question`: answer from what is known.
 * - `unknown`: classification was unavailable. Treated exactly as the
 *   pre-classifier engine treated every turn.
 */
export type OwnerAskKind =
  | "automation_change"
  | "preference"
  | "action"
  | "question"
  | "unknown";

export type OwnerAskClassification = {
  kind: OwnerAskKind;
  /** True only when answering honestly requires reading the account first. */
  needsInvestigation: boolean;
  /**
   * What the owner named as the thing to change, in their own words as far as
   * possible ("the notifications I get when a lead comes in"). The directive
   * quotes it so the escalated turn knows what it is hunting for. Empty when
   * the kind does not need one.
   */
  target: string;
};

/** The classification the engine falls back to whenever it cannot classify. */
export const UNKNOWN_ASK: OwnerAskClassification = {
  kind: "unknown",
  needsInvestigation: false,
  target: ""
};

/** Small, fast, and already the fleet default for classify/extract work. */
export const ASK_CLASSIFIER_MODEL = "gemini-3.5-flash-lite";

/** A classification needs no reasoning budget; the answer is one enum. */
export const ASK_CLASSIFIER_THINKING_LEVEL = "minimal" as const;

/**
 * Bounded so a hung classifier cannot add latency to an owner turn. Past this
 * the turn proceeds unclassified, which is the old behavior.
 */
export const ASK_CLASSIFIER_TIMEOUT_MS = 6_000;

/** Long pastes (a forwarded alert, a transcript) are context, not the ask. */
export const ASK_CLASSIFIER_MAX_INPUT_CHARS = 4_000;

/** AI-spend tag for the classification call, distinct from the turn itself. */
export const ASK_CLASSIFIER_SPEND_SURFACE = "owner_ask_classify";

/**
 * Output budget for a turn escalated to thinking `high`.
 *
 * Gemini 3 counts hidden thinking against `maxOutputTokens`, which is the
 * whole reason the turn loop pins thinking `low` at a 4000 cap. Raising the
 * level without raising the cap lets reasoning eat the budget and return an
 * empty step, and an escalated ask that comes back empty falls to a path that
 * cannot investigate anything: worse than never escalating. The compile
 * pipeline pairs `high` with 32000 for the same reason; this is smaller
 * because the output here is a chat reply plus tool calls, not a whole flow
 * definition, and the input is one owner message rather than a full spec.
 */
export const INVESTIGATING_MAX_OUTPUT_TOKENS = 16_000;

/** What an ordinary (non-escalated) turn has always had. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_000;

/**
 * Output cap for this ask. Escalated turns get room for the thinking their
 * level implies; everything else keeps the historical 4000 exactly.
 */
export function maxOutputTokensForAsk(c: OwnerAskClassification): number {
  return c.needsInvestigation ? INVESTIGATING_MAX_OUTPUT_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS;
}

export const OWNER_ASK_CLASSIFIER_PROMPT = [
  "You classify ONE message a business OWNER sent to their AI coworker.",
  "Decide what would actually have to happen for the owner to get what they asked for.",
  "",
  "Answer with one `kind`:",
  "",
  '- "automation_change": satisfying this means CHANGING AN EXISTING AUTOMATION,',
  "  what it says, who it goes to, when it fires, or what it does. Anything about",
  "  the CONTENT OF MESSAGES THE SYSTEM SENDS ON ITS OWN belongs here: alerts,",
  "  notifications, reminders, follow-ups, lead texts, owner texts, emails the",
  "  system sends. Phrases like \"can you include X on these\", \"stop sending me\",",
  '  "add X to the alert", "these should say", "when I get notifications like this"',
  "  are all this kind, INCLUDING when the owner pastes an example of the message",
  "  they are unhappy with.",
  '- "preference": a durable rule about how YOU behave while talking with people:',
  '  tone, length, language, what to say or avoid saying in conversation, business',
  "  facts to remember. Nothing that the system sends automatically is involved.",
  '- "action": do one concrete thing right now (send this text, book this, look',
  "  this person up, add this teammate).",
  '- "question": they are asking for information, not asking for a change.',
  "",
  "The distinction that matters most: a rule about how YOU TALK is a preference,",
  "but a rule about WHAT AN AUTOMATED MESSAGE CONTAINS is an automation_change,",
  "because automated messages are produced by automations and do not read your",
  "memory. When a message could be read either way, prefer automation_change:",
  "investigating and finding nothing costs a little time, while saving a rule that",
  "changes nothing leaves the owner believing something was fixed when it was not.",
  "",
  "Set `needs_investigation` true ONLY for automation_change.",
  "",
  "Set `target` to a short phrase naming what they want changed, in their own",
  "words where possible, for example \"the notifications I get when a lead comes",
  'in" or "the reminder text customers get the day before". Empty string for',
  "every other kind.",
  "",
  "Respond with JSON only."
].join("\n");

/**
 * Response schema handed to Gemini's JSON mode. Strict enough that a valid
 * response needs no repair, and anything else falls to the open failure.
 */
export const ASK_CLASSIFIER_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["automation_change", "preference", "action", "question"]
    },
    needs_investigation: { type: "boolean" },
    target: { type: "string" }
  },
  required: ["kind", "needs_investigation", "target"]
} as const;

/** Channel markers the surfaces prepend ("[SMS from owner] ...", "[Dashboard] ..."). */
const CHANNEL_MARKER_RE = /^\[[^\]]{1,40}\]\s*/;

const VALID_KINDS = new Set<OwnerAskKind>([
  "automation_change",
  "preference",
  "action",
  "question"
]);

/**
 * Parse a classifier response into a classification, or `UNKNOWN_ASK`.
 *
 * Deliberately strict about `kind` (an unrecognized value is an outage, not a
 * new category) and forgiving about the rest: `needs_investigation` is
 * RECOMPUTED from the kind rather than trusted, because the two must agree and
 * the kind is the half the prompt puts the most weight on. A model that says
 * `automation_change` with `needs_investigation: false` is contradicting
 * itself, and the useful reading is the kind.
 */
export function parseAskClassification(raw: string): OwnerAskClassification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return UNKNOWN_ASK;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return UNKNOWN_ASK;
  const obj = parsed as Record<string, unknown>;
  const kind = typeof obj.kind === "string" ? (obj.kind.trim() as OwnerAskKind) : "unknown";
  if (!VALID_KINDS.has(kind)) return UNKNOWN_ASK;
  const target = typeof obj.target === "string" ? obj.target.trim() : "";
  return {
    kind,
    needsInvestigation: kind === "automation_change",
    target: kind === "automation_change" ? target : ""
  };
}

/**
 * Classify one owner message. Never throws and never rejects: every failure
 * (no key, network, timeout, non-JSON, unknown kind) resolves to
 * `UNKNOWN_ASK`, which selects the engine's pre-existing behavior.
 *
 * The call is METERED against the business AI budget like every other model
 * call on these surfaces. It is small, but it runs on every edit-capable
 * owner turn, and an unmetered call is spend that the cap gating this very
 * surface cannot see. Metering is best-effort: a meter failure must never
 * cost the owner their turn, so it degrades to the classification we already
 * have.
 */
export async function classifyOwnerAsk(args: {
  ownerMessage: string;
  apiKey: string;
  /** Metered against this business's AI budget. Omit to skip metering. */
  businessId?: string;
  model?: string;
  timeoutMs?: number;
  /** Injected in tests; defaults to the shared Gemini text helper. */
  generate?: typeof geminiGenerateTextDetailed;
  /** Injected in tests; defaults to the shared spend meter. */
  meter?: typeof meterGeminiSpendForBusiness;
}): Promise<OwnerAskClassification> {
  const message = (args.ownerMessage ?? "").replace(CHANNEL_MARKER_RE, "").trim();
  if (!message || !args.apiKey) return UNKNOWN_ASK;

  const generate = args.generate ?? geminiGenerateTextDetailed;
  const meter = args.meter ?? meterGeminiSpendForBusiness;
  const model = args.model ?? ASK_CLASSIFIER_MODEL;
  const userText = message.slice(0, ASK_CLASSIFIER_MAX_INPUT_CHARS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? ASK_CLASSIFIER_TIMEOUT_MS);
  try {
    const { text, usage } = await generate({
      apiKey: args.apiKey,
      model,
      systemInstruction: OWNER_ASK_CLASSIFIER_PROMPT,
      userText,
      temperature: 0,
      maxOutputTokens: 200,
      responseMimeType: "application/json",
      thinkingLevel: ASK_CLASSIFIER_THINKING_LEVEL,
      signal: controller.signal
    });
    if (args.businessId) {
      try {
        await meter({
          businessId: args.businessId,
          model,
          surface: ASK_CLASSIFIER_SPEND_SURFACE,
          usage,
          inputChars: OWNER_ASK_CLASSIFIER_PROMPT.length + userText.length,
          outputChars: text.length
        });
      } catch {
        // Spend bookkeeping must never cost the owner their answer.
      }
    }
    return parseAskClassification(text);
  } catch {
    return UNKNOWN_ASK;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How hard the turn should think. Only an ask that needs the account read gets
 * the expensive level; everything else keeps the engine's existing `low`, so
 * this can never slow down or inflate the ordinary turn.
 */
export function thinkingLevelForAsk(
  c: OwnerAskClassification
): "minimal" | "low" | "medium" | "high" {
  return c.needsInvestigation ? "high" : "low";
}

/**
 * Extra tool steps an investigating turn is allowed. Listing the automations
 * and reading the relevant one costs calls the ordinary budget does not carry,
 * and a turn that runs out mid-investigation answers from a half-read account,
 * which is the failure this whole feature exists to remove.
 */
export function toolStepsForAsk(c: OwnerAskClassification, base: number): number {
  return c.needsInvestigation ? base + 4 : base;
}

/**
 * The system-prompt block appended for an investigating turn. Empty for every
 * other kind, so the ordinary prompt is byte-identical to before.
 *
 * It states the mechanism rather than just the instruction ("automated
 * messages do not read your memory"), because the model's own wrong belief is
 * what produced the promise: it saved a rule and reasoned that the rule would
 * take effect.
 */
export function investigationDirective(c: OwnerAskClassification): string {
  if (!c.needsInvestigation) return "";
  const target = c.target ? ` The owner is asking about: ${c.target}.` : "";
  return [
    `THIS ASK NEEDS THE ACCOUNT READ FIRST.${target}`,
    "The owner is asking you to change something an automation sends or does, not to remember a preference.",
    "Automations do NOT read the business memory, so saving a rule cannot change what an automated message says. If you only save it, nothing the owner asked for will happen.",
    "Before you answer: call `list_aiflows` and work out which automations actually produce the thing they named. Read the ones that look right.",
    "Then answer from what you FOUND, naming the real automations. Never name an automation you did not see in the list.",
    "If a change is needed, use `edit_aiflow` to stage it and read the summary back for a yes before applying anything.",
    "If you cannot find what produces it, say so plainly and say what you did look at. An honest miss is worth more than a promise.",
    "Never tell the owner that future messages will include something unless you have actually staged or applied the change that makes it true."
  ].join(" ");
}
