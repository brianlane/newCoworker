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

export function extractExistingBullets(memoryMd: unknown): string[];

export interface ExtractionInputOpts {
  assistantReply?: string;
  existingBullets?: string[];
}

export function composeExtractionInput(ownerMessage: string, opts?: ExtractionInputOpts): string;

export const ADAPTER_BULLETS_MAX_CHARS: number;

export function normalizeBullets(raw: unknown): string[];

export function fitBulletsToPayload(bullets: string[], maxChars?: number): string[];

export function parseMemoryExtraction(content: unknown): {
  save: boolean;
  bullets: string[];
};

export function buildExtractionRequestBody(
  model: string,
  ownerMessage: string,
  opts?: ExtractionInputOpts
): {
  model: string;
  stream: boolean;
  format: typeof MEMORY_EXTRACTION_FORMAT;
  options: { temperature: number };
  messages: Array<{ role: string; content: string }>;
};

export const MEMORY_EXTRACTION_JSON_SCHEMA: {
  name: string;
  strict: boolean;
  schema: {
    type: "object";
    additionalProperties: false;
    properties: {
      save: { type: "boolean" };
      bullets: { type: "array"; items: { type: "string" } };
    };
    required: string[];
  };
};

export function buildExtractionRequestBodyOpenAI(
  model: string,
  ownerMessage: string,
  opts?: ExtractionInputOpts
): {
  model: string;
  stream: boolean;
  temperature: number;
  response_format: { type: "json_schema"; json_schema: typeof MEMORY_EXTRACTION_JSON_SCHEMA };
  messages: Array<{ role: string; content: string }>;
};

export function formatSavedConfirmation(bullets: string[]): string;

export function extractOwnerRule(args: {
  ownerMessage: string;
  assistantReply?: string;
  existingBullets?: string[];
  model: string;
  ollamaBaseUrl?: string;
  geminiBaseUrl?: string;
  geminiApiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  logger?: (level: string, event: string, data?: object) => void;
}): Promise<{ save: boolean; bullets: string[] }>;
