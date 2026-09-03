/**
 * Inventory of every Gemini model pin in the fleet, and the parser that
 * turns a Google model id into a family + version.
 *
 * Why this file exists: model defaults used to live in a dozen workers with
 * no single map, so "which Gemini does SMS use?" was a conversation every
 * time Google shipped a Flash. The weekly eval (`debug/gemini-model-eval.ts`,
 * `.cursor/skills/gemini-model-eval/SKILL.md`) reads this registry instead
 * of re-grepping. tests/gemini-model-pins.test.ts fails the PR when a pin's
 * `mustContain` string drifts out of its source file.
 *
 * Families match how we actually spend, not Google's marketing names:
 *   flagship  gemini-X.Y-flash (not lite). Compile, dashboard chat, blog,
 *             voice_task. Today gemini-3.7-flash.
 *   mid       gemini-X.Y-flash-lite. SMS, owner chat, extract, summaries.
 *             Today gemini-3.5-flash-lite.
 *   cheap     anonymous public traffic. Webchat stays on 2.5-flash-lite
 *             because 3.5-flash-lite is 3-6x the list price.
 *   live      native audio. Never auto-adopted (preview ids rotate).
 *   image     image generation. Separate price table (per image, not tokens).
 */

export type GeminiModelFamily =
  | "flagship"
  | "mid"
  | "cheap"
  | "live"
  | "image"
  | "pro"
  | "other";

export type GeminiParsedModel = {
  id: string;
  family: GeminiModelFamily;
  /** [major, minor], missing minor is 0 so gemini-3-flash is [3, 0]. */
  version: [number, number];
  unstable: boolean;
};

export type GeminiModelPin = {
  id: string;
  /** Human names of the workers that share this pin. */
  workers: string[];
  envVar: string | null;
  defaultModel: string;
  family: GeminiModelFamily;
  /**
   * Candidate families this pin will consider. Usage family `cheap` still
   * accepts a `mid` id if the list price does not rise (webchat).
   */
  acceptsFamilies: GeminiModelFamily[];
  /** Rowboat reaches Gemini through the llm-router's OpenAI-compat path. */
  needsOpenAiCompat: boolean;
  /**
   * Live audio pins are never a "yes" from the automation. Preview ids
   * rotate, and gemini-3.5-live-translate-preview satisfied "must be live"
   * while being the wrong product.
   */
  autoAdopt: boolean;
  sources: { file: string; mustContain: string }[];
};

/** Strip a `models/` prefix Google's list API sometimes includes. */
export function stripGeminiModelsPrefix(raw: string): string {
  return raw.trim().replace(/^models\//i, "");
}

/**
 * True when the id is a preview, experiment, alias, or a specialist SKU
 * we would never make a fleet default. GA Flash ids do not match.
 */
export function isUnstableGeminiId(id: string): boolean {
  const n = stripGeminiModelsPrefix(id).toLowerCase();
  return (
    /-preview(?:-|$)/.test(n) ||
    /(^|-)(exp|experimental)(-|$)/.test(n) ||
    n.endsWith("-latest") ||
    n.includes("-latest-") ||
    n.includes("cyber") ||
    n.includes("-tts") ||
    n.includes("robotics")
  );
}

/**
 * Classify a Gemini model id. Returns null when the string is not a
 * gemini-* id we can version-compare.
 */
export function parseGeminiModelId(raw: string): GeminiParsedModel | null {
  const id = stripGeminiModelsPrefix(raw);
  if (!id) return null;
  const lower = id.toLowerCase();
  if (!lower.startsWith("gemini-")) return null;

  const unstable = isUnstableGeminiId(lower);

  let family: GeminiModelFamily;
  if (lower.includes("image")) {
    family = "image";
  } else if (/(^|-)(live)(-|$)/.test(lower) || lower.includes("native-audio")) {
    family = "live";
  } else if (/(^|-)pro(-|$)/.test(lower)) {
    family = "pro";
  } else if (lower.includes("flash-lite")) {
    family = "mid";
  } else if (/(^|-)flash(-|$)/.test(lower)) {
    family = "flagship";
  } else {
    family = "other";
  }

  const versionMatch = /^gemini-(\d+)(?:\.(\d+))?/i.exec(lower);
  if (!versionMatch) return null;

  return {
    id: lower,
    family,
    version: [Number(versionMatch[1]), versionMatch[2] !== undefined ? Number(versionMatch[2]) : 0],
    unstable
  };
}

/** Negative if a < b, 0 if equal, positive if a > b. */
export function compareGeminiVersions(
  a: [number, number],
  b: [number, number]
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

/**
 * Every worker pin. One row per independently-set default, not per file:
 * website ingest, document ingest, meeting classify, and AiFlow doc-extract
 * share GEMINI_SUMMARY_MODEL and move together.
 */
export const GEMINI_MODEL_PINS: readonly GeminiModelPin[] = [
  {
    id: "sms-chat",
    workers: ["SMS Coworker (Rowboat dispatcher)"],
    envVar: "SMS_CHAT_MODEL",
    defaultModel: "gemini-3.5-flash-lite",
    family: "mid",
    acceptsFamilies: ["mid"],
    needsOpenAiCompat: true,
    autoAdopt: true,
    sources: [
      { file: "vps/scripts/deploy-client.sh", mustContain: 'SMS_CHAT_MODEL_DEFAULT="gemini-3.5-flash-lite"' },
      { file: "vps/rowboat/rowboat.json", mustContain: "{{SMS_CHAT_MODEL}}" }
    ]
  },
  {
    id: "owner-chat",
    workers: ["OwnerCoworker (Rowboat owner dashboard)"],
    envVar: "OWNER_CHAT_MODEL",
    defaultModel: "gemini-3.5-flash-lite",
    family: "mid",
    acceptsFamilies: ["mid"],
    needsOpenAiCompat: true,
    autoAdopt: true,
    sources: [
      {
        file: "vps/scripts/deploy-client.sh",
        mustContain: 'OWNER_CHAT_MODEL_DEFAULT="gemini-3.5-flash-lite"'
      }
    ]
  },
  {
    id: "voice-task",
    workers: ["voice_task (Rowboat text turns on a live call)"],
    envVar: "GEMINI_ROWBOAT_MODEL",
    defaultModel: "gemini-3.7-flash",
    family: "flagship",
    acceptsFamilies: ["flagship"],
    needsOpenAiCompat: true,
    autoAdopt: true,
    sources: [
      {
        file: "vps/scripts/deploy-client.sh",
        mustContain: 'GEMINI_ROWBOAT_MODEL_DEFAULT="gemini-3.7-flash"'
      },
      { file: "vps/rowboat/rowboat.json", mustContain: "{{GEMINI_ROWBOAT_MODEL}}" }
    ]
  },
  {
    id: "gemini-live",
    workers: ["Voice bridge (Gemini Live native audio)"],
    envVar: "GEMINI_LIVE_MODEL",
    defaultModel: "gemini-live-audio",
    family: "live",
    acceptsFamilies: ["live"],
    needsOpenAiCompat: false,
    autoAdopt: false,
    sources: [
      { file: "vps/voice-bridge/src/index.ts", mustContain: "GEMINI_LIVE_MODEL" },
      { file: "vps/scripts/deploy-client.sh", mustContain: "GEMINI_LIVE_MODEL=" }
    ]
  },
  {
    id: "dashboard-chat",
    workers: ["Dashboard inline chat (Owner operator)"],
    envVar: "DASHBOARD_CHAT_MODEL",
    defaultModel: "gemini-3.7-flash",
    family: "flagship",
    acceptsFamilies: ["flagship"],
    needsOpenAiCompat: false,
    autoAdopt: true,
    sources: [
      {
        file: "src/lib/dashboard-chat/inline-turn.ts",
        mustContain: 'const DEFAULT_INLINE_MODEL = "gemini-3.7-flash"'
      }
    ]
  },
  {
    id: "dashboard-chat-fallback",
    workers: ["Dashboard inline chat 404 fallback"],
    envVar: null,
    defaultModel: "gemini-3.5-flash-lite",
    family: "mid",
    acceptsFamilies: ["mid"],
    needsOpenAiCompat: false,
    autoAdopt: true,
    sources: [
      {
        file: "src/lib/dashboard-chat/inline-turn.ts",
        mustContain: 'const INLINE_FALLBACK_MODEL = "gemini-3.5-flash-lite"'
      }
    ]
  },
  {
    id: "ask-classifier",
    workers: ["Owner-ask classifier (dashboard)"],
    envVar: null,
    defaultModel: "gemini-3.5-flash-lite",
    family: "mid",
    acceptsFamilies: ["mid"],
    needsOpenAiCompat: false,
    autoAdopt: true,
    sources: [
      {
        file: "src/lib/dashboard-chat/ask-classifier.ts",
        mustContain: 'export const ASK_CLASSIFIER_MODEL = "gemini-3.5-flash-lite"'
      }
    ]
  },
  {
    id: "memory-capture",
    workers: ["Owner memory capture (platform + chat-worker)"],
    envVar: "MEMORY_CAPTURE_MODEL",
    defaultModel: "gemini-3.5-flash-lite",
    family: "mid",
    acceptsFamilies: ["mid"],
    needsOpenAiCompat: true,
    autoAdopt: true,
    sources: [
      {
        file: "src/lib/dashboard-chat/memory-capture.ts",
        mustContain: 'const DEFAULT_CAPTURE_MODEL = "gemini-3.5-flash-lite"'
      },
      {
        file: "vps/chat-worker/worker.mjs",
        mustContain: '"gemini-3.5-flash-lite"'
      },
      {
        file: "vps/scripts/deploy-client.sh",
        mustContain: 'MEMORY_CAPTURE_MODEL_DEFAULT="gemini-3.5-flash-lite"'
      }
    ]
  },
  {
    id: "aiflow-extract",
    workers: ["AiFlow extract (ai-flow-worker)", "e2e live Gemini client"],
    envVar: "AIFLOW_EXTRACT_MODEL",
    defaultModel: "gemini-3.5-flash-lite",
    family: "mid",
    acceptsFamilies: ["mid"],
    needsOpenAiCompat: false,
    autoAdopt: true,
    sources: [
      {
        file: "supabase/functions/ai-flow-worker/index.ts",
        mustContain: 'Deno.env.get("AIFLOW_EXTRACT_MODEL") ?? "gemini-3.5-flash-lite"'
      },
      {
        file: "tests/e2e/gemini.ts",
        mustContain: 'process.env.AIFLOW_EXTRACT_MODEL ?? "gemini-3.5-flash-lite"'
      }
    ]
  },
  {
    id: "aiflow-compile",
    workers: ["AiFlow compile / edit / library adapt"],
    envVar: "AIFLOW_COMPILE_MODEL",
    defaultModel: "gemini-3.7-flash",
    family: "flagship",
    acceptsFamilies: ["flagship"],
    needsOpenAiCompat: false,
    autoAdopt: true,
    sources: [
      {
        file: "src/lib/ai-flows/compile-service.ts",
        mustContain: 'process.env.AIFLOW_COMPILE_MODEL ?? "gemini-3.7-flash"'
      }
    ]
  },
  {
    id: "agent-run",
    workers: ["Document agents (executeAgentRun)"],
    envVar: "AGENT_RUN_MODEL",
    defaultModel: "gemini-3.7-flash",
    family: "flagship",
    acceptsFamilies: ["flagship"],
    needsOpenAiCompat: false,
    autoAdopt: true,
    sources: [
      {
        file: "src/lib/agents/run.ts",
        mustContain: 'const DEFAULT_AGENT_MODEL = "gemini-3.7-flash"'
      }
    ]
  },
  {
    id: "summarizers",
    workers: [
      "Website ingest summarizer",
      "Document ingest summarizer",
      "Meeting-minutes classify",
      "AiFlow doc_extract"
    ],
    envVar: "GEMINI_SUMMARY_MODEL",
    defaultModel: "gemini-3.5-flash-lite",
    family: "mid",
    acceptsFamilies: ["mid"],
    needsOpenAiCompat: false,
    autoAdopt: true,
    sources: [
      {
        file: "src/lib/website-ingest.ts",
        mustContain: 'const WEBSITE_SUMMARY_GEMINI_MODEL_DEFAULT = "gemini-3.5-flash-lite"'
      },
      {
        file: "src/lib/documents/ingest.ts",
        mustContain: 'const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"'
      },
      {
        file: "src/lib/meetings/classify.ts",
        mustContain: 'const DEFAULT_MEETING_MODEL = "gemini-3.5-flash-lite"'
      },
      {
        file: "src/lib/ai-flows/doc-extract.ts",
        mustContain: 'const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"'
      }
    ]
  },
  {
    id: "call-summary",
    workers: ["Voice call summary sweep"],
    envVar: "GEMINI_CALL_SUMMARY_MODEL",
    defaultModel: "gemini-3.5-flash-lite",
    family: "mid",
    acceptsFamilies: ["mid"],
    needsOpenAiCompat: false,
    autoAdopt: true,
    sources: [
      {
        file: "src/lib/call-summaries/summarizer.ts",
        mustContain: 'export const CALL_SUMMARY_DEFAULT_MODEL = "gemini-3.5-flash-lite"'
      }
    ]
  },
  {
    id: "knowledge-lookup",
    workers: ["business_knowledge_lookup (voice/SMS/dashboard/webchat)"],
    envVar: "GEMINI_ROWBOAT_MODEL",
    defaultModel: "gemini-3.5-flash-lite",
    family: "mid",
    acceptsFamilies: ["mid"],
    needsOpenAiCompat: false,
    autoAdopt: true,
    sources: [
      {
        file: "src/lib/knowledge-tools/handlers.ts",
        mustContain: 'const GEMINI_LOOKUP_DEFAULT_MODEL = "gemini-3.5-flash-lite"'
      }
    ]
  },
  {
    id: "messenger",
    workers: ["Messenger / Instagram / WhatsApp Gemini engine"],
    envVar: "MESSENGER_GEMINI_ENGINE_MODEL",
    defaultModel: "gemini-3.5-flash-lite",
    family: "mid",
    acceptsFamilies: ["mid"],
    needsOpenAiCompat: false,
    autoAdopt: true,
    sources: [
      {
        file: "src/lib/messenger/engine.ts",
        mustContain: 'export const MESSENGER_ENGINE_DEFAULT_MODEL = "gemini-3.5-flash-lite"'
      }
    ]
  },
  {
    id: "webchat",
    workers: ["Public website chat widget"],
    envVar: "WEBCHAT_GEMINI_ENGINE_MODEL",
    defaultModel: "gemini-2.5-flash-lite",
    family: "cheap",
    acceptsFamilies: ["mid", "flagship", "cheap"],
    needsOpenAiCompat: false,
    autoAdopt: true,
    sources: [
      {
        file: "src/lib/webchat/gemini-engine.ts",
        mustContain: 'export const WEBCHAT_ENGINE_DEFAULT_MODEL = "gemini-2.5-flash-lite"'
      }
    ]
  },
  {
    id: "memory-graph",
    workers: [
      "Memory-graph ingest",
      "Memory-graph longform extract",
      "Memory-graph conversational extract"
    ],
    envVar: "MEMORY_GRAPH_EXTRACT_MODEL",
    defaultModel: "gemini-3.5-flash-lite",
    family: "mid",
    acceptsFamilies: ["mid"],
    needsOpenAiCompat: false,
    autoAdopt: true,
    sources: [
      {
        file: "src/lib/memory/graph-ingest.ts",
        mustContain: 'const DEFAULT_GRAPH_EXTRACT_MODEL = "gemini-3.5-flash-lite"'
      },
      {
        file: "src/lib/memory/graph-longform.ts",
        mustContain: 'const DEFAULT_GRAPH_EXTRACT_MODEL = "gemini-3.5-flash-lite"'
      },
      {
        file: "src/lib/memory/graph-conversational.ts",
        mustContain: 'const DEFAULT_GRAPH_EXTRACT_MODEL = "gemini-3.5-flash-lite"'
      }
    ]
  },
  {
    id: "blog-text",
    workers: ["Admin blog AI assist", "Weekly PR digest"],
    envVar: "BLOG_DIGEST_TEXT_MODEL",
    defaultModel: "gemini-3.7-flash",
    family: "flagship",
    acceptsFamilies: ["flagship"],
    needsOpenAiCompat: false,
    autoAdopt: true,
    sources: [
      {
        file: "src/lib/blog/ai.ts",
        mustContain: 'export const DEFAULT_BLOG_AI_TEXT_MODEL = "gemini-3.7-flash"'
      },
      {
        file: "src/lib/blog/weekly-digest.ts",
        mustContain: 'export const DEFAULT_DIGEST_TEXT_MODEL = "gemini-3.7-flash"'
      }
    ]
  },
  {
    id: "images",
    workers: ["generate_image tool", "AiFlow image step", "Blog featured image"],
    envVar: "GEMINI_IMAGE_MODEL",
    defaultModel: "gemini-3.1-flash-lite-image",
    family: "image",
    acceptsFamilies: ["image"],
    needsOpenAiCompat: false,
    autoAdopt: true,
    sources: [
      {
        file: "src/lib/image-tools/handlers.ts",
        mustContain: 'export const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-lite-image"'
      },
      {
        file: "supabase/functions/ai-flow-worker/index.ts",
        mustContain: 'Deno.env.get("GEMINI_IMAGE_MODEL") ?? "gemini-3.1-flash-lite-image"'
      },
      {
        file: "src/lib/blog/ai.ts",
        mustContain: 'export const DEFAULT_BLOG_AI_IMAGE_MODEL = "gemini-3.1-flash-lite-image"'
      }
    ]
  },
  {
    id: "pitch-polish",
    workers: ["Outreach pitch tone pass"],
    envVar: null,
    defaultModel: "gemini-3.5-flash-lite",
    family: "mid",
    acceptsFamilies: ["mid"],
    needsOpenAiCompat: false,
    autoAdopt: true,
    sources: [
      {
        file: "src/lib/outreach/compose.ts",
        mustContain: 'export const PITCH_POLISH_MODEL = "gemini-3.5-flash-lite"'
      }
    ]
  }
];

export function pinById(id: string): GeminiModelPin | undefined {
  return GEMINI_MODEL_PINS.find((p) => p.id === id);
}

export function pinsForFamily(family: GeminiModelFamily): GeminiModelPin[] {
  return GEMINI_MODEL_PINS.filter((p) => p.family === family);
}
