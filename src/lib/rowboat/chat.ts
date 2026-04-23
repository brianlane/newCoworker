/**
 * Node-side Rowboat chat client used by /api/dashboard/chat.
 *
 * Mirrors the Edge function behaviour in
 *   supabase/functions/sms-inbound-worker/index.ts (lines 66-104, 205-246)
 * so platform surfaces send identical payloads to the per-tenant Rowboat
 * running on Cloudflare Tunnel. Kept intentionally small and dependency-free
 * so the Deno worker could import it too via a shared ports/adapters split
 * later; for now we duplicate the shape knowingly.
 *
 * The Rowboat reply is NOT `{ reply: string }` — the assistant text lives in
 * `turn.output[]` where `role === "assistant"`.
 */

export type RowboatChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type RowboatTurnJson = {
  conversationId?: string;
  /** Server workflow state; pass back on the next /chat to continue a thread. */
  state?: unknown;
  turn?: {
    output?: Array<{ role?: string; content?: string | null }>;
  };
};

export type ParsedRowboatChat = {
  reply: string;
  conversationId: string | undefined;
  state: unknown | undefined;
  hasStateKey: boolean;
};

export const DEFAULT_ROWBOAT_CHAT_URL_TEMPLATE =
  "https://{businessId}.tunnel.newcoworker.com/api/v1/{projectId}/chat";

export const DEFAULT_ROWBOAT_CHAT_TIMEOUT_MS = 30_000;

export function buildRowboatChatUrl(businessId: string, projectId: string): string {
  const template =
    process.env.ROWBOAT_CHAT_URL_TEMPLATE ?? DEFAULT_ROWBOAT_CHAT_URL_TEMPLATE;
  return template
    .replace(/\{businessId\}/g, businessId)
    .replace(/\{projectId\}/g, projectId);
}

export function assistantFromRowboat(json: unknown): string {
  const o = json as RowboatTurnJson | null | undefined;
  const outs = o?.turn?.output ?? [];
  for (const m of outs) {
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
      return m.content.trim();
    }
  }
  return "";
}

export function parseRowboatChatJson(json: unknown): ParsedRowboatChat {
  const isObj = json !== null && typeof json === "object";
  const o = (isObj ? json : {}) as { conversationId?: string; state?: unknown };
  const hasStateKey =
    isObj && Object.prototype.hasOwnProperty.call(json, "state");
  return {
    reply: assistantFromRowboat(json),
    conversationId: o.conversationId,
    state: hasStateKey ? o.state : undefined,
    hasStateKey
  };
}

export type CallRowboatChatInput = {
  businessId: string;
  projectId: string;
  bearer: string;
  messages: RowboatChatMessage[];
  conversationId?: string | null;
  state?: unknown | null;
  /** Override for tests or slow tunnels. */
  timeoutMs?: number;
};

export type CallRowboatChatOutput = ParsedRowboatChat;

/**
 * Throws with one of these Error messages so callers can map to friendly
 * copy without string sniffing on arbitrary network errors:
 *   - `rowboat_timeout`
 *   - `rowboat_http_<status>`
 *   - `rowboat_empty_assistant`
 *   - `rowboat_invalid_json`
 */
export async function callRowboatChat(
  input: CallRowboatChatInput
): Promise<CallRowboatChatOutput> {
  const {
    businessId,
    projectId,
    bearer,
    messages,
    conversationId,
    state,
    timeoutMs
  } = input;

  const url = buildRowboatChatUrl(businessId, projectId);

  const body: Record<string, unknown> = {
    messages,
    stream: false
  };
  if (conversationId && conversationId.trim()) {
    body.conversationId = conversationId.trim();
    if (state != null) body.state = state;
  }

  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(),
    timeoutMs ?? DEFAULT_ROWBOAT_CHAT_TIMEOUT_MS
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`
      },
      body: JSON.stringify(body),
      signal: abort.signal
    });
  } catch (err) {
    if (abort.signal.aborted) throw new Error("rowboat_timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`rowboat_http_${res.status}`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error("rowboat_invalid_json");
  }

  const parsed = parseRowboatChatJson(json);
  if (!parsed.reply) throw new Error("rowboat_empty_assistant");
  return parsed;
}

/**
 * Maps the error messages thrown by callRowboatChat into owner-friendly copy
 * for /dashboard/chat. Unknown errors bubble up as a generic message.
 */
export function describeRowboatError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message === "rowboat_timeout") {
      return "Your coworker took too long to reply. Try again in a moment.";
    }
    if (err.message === "rowboat_empty_assistant") {
      return "Your coworker didn't produce a reply. Try rephrasing.";
    }
    if (err.message === "rowboat_invalid_json") {
      return "Your coworker returned an unexpected response. Try again.";
    }
    if (err.message.startsWith("rowboat_http_")) {
      const status = err.message.replace("rowboat_http_", "");
      if (status === "401" || status === "403") {
        return "Your coworker isn't accepting requests right now (auth). Please contact support.";
      }
      if (status === "404") {
        return "Your coworker's chat service isn't ready yet. Provisioning may still be in progress.";
      }
      return `Your coworker is having trouble (status ${status}). Please try again shortly.`;
    }
  }
  return "We couldn't reach your coworker right now. Please try again in a moment.";
}
