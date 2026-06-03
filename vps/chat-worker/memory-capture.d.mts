// Type declarations for memory-capture.mjs (plain-ESM worker module). The
// worker itself runs the .mjs directly under node; these declarations exist so
// the TypeScript test suite (and `tsc --noEmit`) can import the helpers with
// types. Keep in sync with memory-capture.mjs.

export const OWNER_MEMORY_SYSTEM_PROMPT: string;

export const MEMORY_EXTRACTION_FORMAT: {
  type: "object";
  properties: {
    save: { type: "boolean" };
    bullets: { type: "array"; items: { type: "string" } };
  };
  required: string[];
};

export function extractLatestOwnerMessage(
  inputMessages: Array<{ role?: string; content?: unknown }> | null | undefined
): string;

export function normalizeBullets(raw: unknown): string[];

export function parseMemoryExtraction(content: unknown): {
  save: boolean;
  bullets: string[];
};

export function buildExtractionRequestBody(
  model: string,
  ownerMessage: string
): {
  model: string;
  stream: boolean;
  format: typeof MEMORY_EXTRACTION_FORMAT;
  options: { temperature: number };
  messages: Array<{ role: string; content: string }>;
};

export function formatSavedConfirmation(bullets: string[]): string;

export function extractOwnerRule(args: {
  ownerMessage: string;
  model: string;
  ollamaBaseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  logger?: (level: string, event: string, data?: object) => void;
}): Promise<{ save: boolean; bullets: string[] }>;
