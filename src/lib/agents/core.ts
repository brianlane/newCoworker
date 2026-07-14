/**
 * Agents — pure domain rules shared by every surface.
 *
 * An agent is a reusable attachment→output task template: saved instructions
 * the owner runs repeatedly against different inputs (fresh uploads or
 * existing business documents) to get the same KIND of output every time.
 * Everything here is side-effect free: tier caps, output-format resolution,
 * and the run prompt builder. The IO layers (db.ts, run.ts, routes) defer to
 * these rules so manual dashboard runs and future flow-invoked runs behave
 * identically.
 */

/** Cap on the reusable instruction prompt. */
export const AGENT_INSTRUCTIONS_MAX_CHARS = 8_000;
/** Cap on the agent name. */
export const AGENT_NAME_MAX_CHARS = 120;
/** Raw attachment text fed to the model is clipped to keep prompts bounded. */
export const AGENT_INPUT_MAX_TEXT_CHARS = 40_000;
/** Hard cap on the produced artifact text. */
export const AGENT_OUTPUT_MAX_CHARS = 60_000;

export type AgentOutputFormat = "markdown" | "same_as_input";

/** Per-tier agent-count caps (creates are refused past the cap). */
export const AGENT_TIER_LIMITS: Record<string, number> = {
  starter: 5,
  standard: 25,
  enterprise: 100
};

export function agentLimitForTier(tier: string | null | undefined): number {
  return AGENT_TIER_LIMITS[tier ?? ""] ?? AGENT_TIER_LIMITS.starter;
}

export type AgentOutputTarget = {
  /** MIME of the produced artifact (download representation). */
  mime: string;
  /** File extension (no dot) for the download filename. */
  extension: string;
  /** Human word used in the model prompt ("markdown", "CSV", ...). */
  formatWord: string;
};

const MARKDOWN_TARGET: AgentOutputTarget = {
  mime: "text/markdown",
  extension: "md",
  formatWord: "markdown"
};

/**
 * What the run should produce for a given input MIME. `same_as_input`
 * echoes text formats (csv/plain text) back in kind; markdown inputs and
 * PDFs always produce markdown (v1 never regenerates a PDF — the artifact
 * is the extracted/edited content, not a re-typeset file).
 */
export function resolveOutputTarget(
  outputFormat: AgentOutputFormat,
  inputMime: string
): AgentOutputTarget {
  if (outputFormat !== "same_as_input") return MARKDOWN_TARGET;
  const mime = inputMime.trim().toLowerCase();
  if (mime === "text/csv") return { mime: "text/csv", extension: "csv", formatWord: "CSV" };
  if (mime === "text/plain") {
    return { mime: "text/plain", extension: "txt", formatWord: "plain text" };
  }
  return MARKDOWN_TARGET;
}

/**
 * Filename for the produced artifact: derived from the input filename with
 * the target extension, sanitized the same way document uploads are.
 */
export function buildOutputFilename(inputFilename: string, target: AgentOutputTarget): string {
  const sanitized = inputFilename
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 100);
  // A base with no alphanumeric at all ("...", "___") is degenerate — fall
  // back rather than emitting a dotfile-looking artifact name.
  const base = /[A-Za-z0-9]/.test(sanitized) ? sanitized : "output";
  return `${base}.${target.extension}`;
}

export const AGENT_RUN_SYSTEM_PROMPT =
  "You are a small business's document assistant. Apply the owner's saved instructions to the attached material exactly. Preserve every concrete fact — prices, names, dates, contact info — unless the instructions say to change it. Never invent facts. Reply with ONLY the finished result: no preamble, no commentary, no code fences around the whole reply.";

/**
 * The user turn for a run: the agent's saved instructions + the attachment
 * (inline text for text formats; PDFs ride along as an inlineData part, so
 * `inputText` is omitted and the prompt says the file is attached).
 */
export function buildAgentRunPrompt(args: {
  instructions: string;
  inputFilename: string;
  formatWord: string;
  inputText?: string;
}): string {
  const lines = [
    "Saved instructions (apply these to the attached material):",
    "---",
    args.instructions.trim(),
    "---",
    "",
    `Produce the result as ${args.formatWord}.`
  ];
  if (args.inputText !== undefined) {
    lines.push(
      "",
      `Attached material (from "${args.inputFilename}", may be truncated):`,
      "---",
      args.inputText,
      "---"
    );
  } else {
    lines.push("", `The file "${args.inputFilename}" is attached.`);
  }
  return lines.join("\n");
}

/**
 * Strip a whole-reply code fence if the model wrapped its output in one
 * despite the system prompt, then clip to the artifact cap. Inner fences
 * (legitimate markdown) are untouched — only a fence enclosing the entire
 * reply is removed.
 */
export function normalizeAgentOutput(raw: string): string {
  let text = raw.trim();
  const fence = /^```[a-z0-9_-]*\n([\s\S]*)\n```$/i.exec(text);
  if (fence) text = fence[1].trim();
  return text.slice(0, AGENT_OUTPUT_MAX_CHARS);
}
