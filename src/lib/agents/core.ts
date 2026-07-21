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
/** Max attachments per run (compare-N-quotes without unbounded prompts). */
export const AGENT_RUN_MAX_FILES = 5;
/** Combined byte ceiling across a run's attachments (Gemini request headroom). */
export const AGENT_RUN_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export type AgentOutputFormat = "markdown" | "same_as_input" | "pdf" | "docx" | "pdf_retypeset";

/** Every persistable output format (routes/tools validate against this). */
export const AGENT_OUTPUT_FORMATS = [
  "markdown",
  "same_as_input",
  "pdf",
  "docx",
  "pdf_retypeset"
] as const;

/**
 * `pdf_retypeset` renders on the tenant's VPS render sidecar, which is a
 * Standard/Enterprise entitlement (mirrors the provisioning `renderEnabled`
 * gate — Starter boxes have no sidecar or render-* hostname).
 */
export function retypesetAvailableForTier(tier: string | null | undefined): boolean {
  return tier === "standard" || tier === "enterprise";
}

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

// The model always writes markdown for typeset targets (formatWord) — the
// PDF/DOCX bytes are rendered from that markdown by documents/typeset.ts at
// persistence/download time, never by the model.
const PDF_TARGET: AgentOutputTarget = {
  mime: "application/pdf",
  extension: "pdf",
  formatWord: "markdown"
};
const DOCX_TARGET: AgentOutputTarget = {
  mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  extension: "docx",
  formatWord: "markdown"
};

/**
 * Re-typeset mode: the model reads the source document natively and replies
 * with styled HTML mirroring its design; the VPS render sidecar prints it to
 * PDF. formatWord slots into the run prompt's "Produce the result as …"
 * line, so it carries the whole HTML contract. The target mime is
 * `text/html` — the ARTIFACT's own type, stored on the run row as the
 * explicit renderer discriminator (renderAgentArtifactBytes maps it to a
 * PDF download; a markdown artifact that merely looks like HTML can never
 * be misrouted to the sidecar). The extension stays `pdf` because the
 * download/filed representation is the printed PDF.
 */
const RETYPESET_FORMAT_WORD =
  "one complete, self-contained HTML document that visually mirrors the attached document's " +
  "original design — colors, headings, tables, spacing, and layout — with the instructions " +
  "applied. Use inline CSS only (a <style> block in <head> is fine). No <script> tags, no " +
  "event handlers, and no external resources (images, fonts, or stylesheets); small images " +
  "may be inline data: URIs. Start the reply with <!DOCTYPE html> and reply with ONLY the " +
  "HTML document";

export const RETYPESET_ARTIFACT_MIME = "text/html";

const PDF_RETYPESET_TARGET: AgentOutputTarget = {
  mime: RETYPESET_ARTIFACT_MIME,
  extension: "pdf",
  formatWord: RETYPESET_FORMAT_WORD
};

/**
 * What the run should produce for a given input MIME. `pdf` / `docx` always
 * typeset the markdown artifact into that format. `same_as_input` echoes
 * the primary input's format back — text formats in kind, and PDF/DOCX
 * inputs as re-typeset PDF/DOCX (the layout comes from the markdown
 * artifact, not the source file's design); markdown/VTT inputs produce
 * markdown.
 */
export function resolveOutputTarget(
  outputFormat: AgentOutputFormat,
  inputMime: string
): AgentOutputTarget {
  if (outputFormat === "pdf") return PDF_TARGET;
  if (outputFormat === "docx") return DOCX_TARGET;
  if (outputFormat === "pdf_retypeset") return PDF_RETYPESET_TARGET;
  if (outputFormat !== "same_as_input") return MARKDOWN_TARGET;
  const mime = inputMime.trim().toLowerCase();
  if (mime === "text/csv") return { mime: "text/csv", extension: "csv", formatWord: "CSV" };
  if (mime === "text/plain") {
    return { mime: "text/plain", extension: "txt", formatWord: "plain text" };
  }
  if (mime === PDF_TARGET.mime) return PDF_TARGET;
  if (mime === DOCX_TARGET.mime) return DOCX_TARGET;
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

/** One decoded text attachment for the run prompt. */
export type AgentPromptTextSection = { filename: string; text: string };

/**
 * The user turn for a run: the agent's saved instructions + every
 * attachment — inline sections for text formats; PDFs ride along as
 * inlineData parts, so the prompt only names them as attached. A run can
 * carry several files (e.g. one quote PDF per carrier); each text section
 * is labeled with its filename so the model can attribute facts.
 */
export function buildAgentRunPrompt(args: {
  instructions: string;
  formatWord: string;
  /** Decoded text attachments, in run order (may be empty). */
  textSections: AgentPromptTextSection[];
  /** Filenames of PDF attachments riding as inlineData (may be empty). */
  attachedFilenames: string[];
}): string {
  const lines = [
    "Saved instructions (apply these to the attached material):",
    "---",
    args.instructions.trim(),
    "---",
    "",
    `Produce the result as ${args.formatWord}.`
  ];
  for (const section of args.textSections) {
    lines.push(
      "",
      `Attached material (from "${section.filename}", may be truncated):`,
      "---",
      section.text,
      "---"
    );
  }
  if (args.attachedFilenames.length === 1) {
    lines.push("", `The file "${args.attachedFilenames[0]}" is attached.`);
  } else if (args.attachedFilenames.length > 1) {
    lines.push(
      "",
      `The files ${args.attachedFilenames.map((f) => `"${f}"`).join(", ")} are attached.`
    );
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
