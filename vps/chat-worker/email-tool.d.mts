// Type declarations for email-tool.mjs (plain-ESM worker module). The worker
// runs the .mjs directly under node; these declarations exist so the
// TypeScript test suite (and `tsc --noEmit`) can import the helpers with
// types. Keep in sync with email-tool.mjs.

export const EMAIL_SEND_OPEN: string;
export const EMAIL_SEND_CLOSE: string;
export const MAX_EMAILS_PER_TURN: number;
export const SUBJECT_MAX_CHARS: number;
export const BODY_MAX_CHARS: number;

export interface EmailSendRequest {
  to: string;
  subject: string;
  body: string;
}

export interface EmailSendOutcome {
  ok: boolean;
  to: string;
  subject: string;
  detail?: string;
  error?: string;
}

export function extractEmailSendRequests(content: unknown): {
  cleanedContent: string;
  requests: EmailSendRequest[];
  invalidCount: number;
};

export function describeEmailOutcome(result: {
  ok: boolean;
  to: string;
  subject?: string;
  detail?: string;
}): string;

export function appendEmailResults(
  cleanedContent: string,
  results: Array<{ ok: boolean; to: string; subject?: string; detail?: string }>
): string;

export function postEmailSend(args: {
  url: string;
  bearer: string;
  businessId: string;
  request: EmailSendRequest;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<EmailSendOutcome>;

export function fulfillEmailSends(args: {
  content: string;
  url: string;
  bearer: string;
  businessId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  logger?: (level: string, event: string, data?: object) => void;
}): Promise<{
  content: string;
  sentCount: number;
  failedCount: number;
  invalidCount: number;
}>;
