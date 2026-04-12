import { execFileSync } from "node:child_process";
import {
  integrationLlmFetch,
  dockerCompose,
  waitForOllamaHostOk,
  CHAT_FETCH_MS,
  repoRoot,
  formatErrorChain,
  logHostCpuDiagnostic,
  composeServicesLogsTail,
  integrationFailureComposeLogTailLines
} from "../kvm-stack-helpers";
import { expect } from "vitest";
import { INTEGRATION_ROWBOAT_API_KEY, INTEGRATION_ROWBOAT_PROJECT_ID } from "./constants";

/** Abort if Rowboat chat hangs; align with {@link CHAT_FETCH_MS} / Ollama chat budget. */
const ROWBOAT_CHAT_MS = CHAT_FETCH_MS;

export type TurnJson = {
  conversationId?: string;
  /** Server workflow state; pass back on the next `/chat` when continuing a thread. */
  state?: unknown;
  turn?: {
    output?: Array<{ role?: string; content?: string | null }>;
  };
};

export type RowboatChatRequestOpts = {
  conversationId?: string;
  state?: unknown;
};

function composeRowboatLogsTail(composeFile: string, ollamaModel: string): string {
  try {
    return execFileSync(
      "docker",
      ["compose", "-f", composeFile, "logs", "--tail", "120", "rowboat"],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, OLLAMA_MODEL: ollamaModel } }
    );
  } catch {
    return "(could not read rowboat logs)";
  }
}

/**
 * Contract check only: Rowboat returned a parseable turn with a non-empty assistant string.
 * Use in the **correctness** job; the **benchmark** job adds regex / min-length quality gates.
 */
export function expectRowboatChatResponseShape(turnJson: TurnJson, context: string): void {
  const outs = turnJson.turn?.output ?? [];
  expect(outs.length, `${context}: turn.output present`).toBeGreaterThan(0);
  const assistant = outs.find((m) => m.role === "assistant" && typeof m.content === "string");
  expect(assistant, `${context}: assistant message`).toBeDefined();
  expect(String(assistant!.content).trim().length, `${context}: assistant non-empty`).toBeGreaterThan(0);
}

export function firstAssistantTextFromChatResponse(json: TurnJson): string {
  const outs = json.turn?.output ?? [];
  for (const m of outs) {
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
      return m.content;
    }
  }
  return "";
}

function lastUserPreview(messages: { role: string; content: string }[], max = 120): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      const s = messages[i]!.content.replace(/\s+/g, " ").trim();
      return s.length <= max ? s : `${s.slice(0, max)}…`;
    }
  }
  return "(no user message)";
}

export async function postRowboatChat(
  rowboatPort: number,
  messages: { role: "user" | "assistant" | "system"; content: string }[],
  logCtx?: { composeFile: string; ollamaModel: string },
  rowboatOpts?: RowboatChatRequestOpts
): Promise<{ ms: number; turnJson: TurnJson }> {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ROWBOAT_CHAT_MS);
  try {
    const body: Record<string, unknown> = { messages, stream: false };
    if (rowboatOpts?.conversationId != null && rowboatOpts.conversationId !== "") {
      body.conversationId = rowboatOpts.conversationId;
    }
    if (rowboatOpts != null && Object.prototype.hasOwnProperty.call(rowboatOpts, "state")) {
      body.state = rowboatOpts.state;
    }
    const res = await integrationLlmFetch(
      `http://127.0.0.1:${rowboatPort}/api/v1/${INTEGRATION_ROWBOAT_PROJECT_ID}/chat`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INTEGRATION_ROWBOAT_API_KEY}`
        },
        signal: ac.signal,
        body: JSON.stringify(body)
      }
    );
    const ms = performance.now() - t0;
    const text = await res.text();
    if (!res.ok) {
      const ct = res.headers.get("content-type") ?? "";
      const rid = res.headers.get("x-request-id") ?? res.headers.get("cf-ray") ?? "";
      const snippet = text.replace(/\s+/g, " ").trim().slice(0, 280);
      console.warn(
        `[integration] Rowboat /chat HTTP ${res.status} in ${Math.round(ms)}ms model=${logCtx?.ollamaModel ?? "?"} ` +
          `bodyLen=${text.length} content-type=${ct}${rid ? ` request-id=${rid}` : ""}` +
          `${snippet ? ` snippet="${snippet}"` : ""}`
      );
      const tail =
        logCtx != null
          ? `\n--- rowboat logs (tail) ---\n${composeRowboatLogsTail(logCtx.composeFile, logCtx.ollamaModel)}`
          : "";
      throw new Error(
        `Rowboat chat ${res.status}: ${text.length ? text.slice(0, 2000) : "(empty body)"}${tail}`
      );
    }
    let turnJson: TurnJson;
    try {
      turnJson = JSON.parse(text) as TurnJson;
    } catch (parseErr) {
      console.error(
        `[integration] Rowboat /chat 200 but non-JSON after ${Math.round(ms)}ms model=${logCtx?.ollamaModel ?? "?"} ` +
          `bodyLen=${text.length} head=${text.slice(0, 500).replace(/\s+/g, " ")}`
      );
      throw parseErr;
    }
    return { ms, turnJson };
  } catch (e) {
    const elapsed = Math.round(performance.now() - t0);
    if (e instanceof Error && e.name === "AbortError") {
      console.error(
        `[integration] Rowboat /chat AbortError after ${elapsed}ms (cap ${ROWBOAT_CHAT_MS}ms) model=${logCtx?.ollamaModel ?? "?"} ` +
          `— likely Rowboat/Ollama still working; see docker logs. Try INTEGRATION_OLLAMA_CHAT_TIMEOUT_SEC or a smaller/faster model.`
      );
    } else if (!(e instanceof Error && e.message.startsWith("Rowboat chat "))) {
      console.error(
        `[integration] Rowboat /chat failed after ${elapsed}ms model=${logCtx?.ollamaModel ?? "?"}: ${formatErrorChain(e).slice(0, 800)}`
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function postRowboatChatWithRetry(
  rowboatPort: number,
  messages: { role: "user" | "assistant" | "system"; content: string }[],
  logCtx?: {
    composeFile: string;
    ollamaModel: string;
    ollamaHostPort?: number;
    /** Only kvm8: restarting Ollama can recover from runner crashes; on kvm2 it usually makes things worse. */
    recoverOllama?: boolean;
  },
  rowboatOpts?: RowboatChatRequestOpts
): Promise<{ ms: number; turnJson: TurnJson }> {
  let lastErr = "";
  const preview = lastUserPreview(messages);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      console.log(
        `[integration] Rowboat /chat attempt ${attempt + 1}/6 ollamaModel=${logCtx?.ollamaModel ?? "?"} ` +
          `timeoutMs=${ROWBOAT_CHAT_MS} lastUser="${preview}"`
      );
      return await postRowboatChat(rowboatPort, messages, logCtx, rowboatOpts);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      console.warn(
        `[integration] Rowboat /chat attempt ${attempt + 1}/6 failed: ${formatErrorChain(e).slice(0, 1200)}`
      );
      const ollamaLikelyDown =
        logCtx?.recoverOllama === true &&
        logCtx.ollamaHostPort != null &&
        /connection refused|ECONNREFUSED|model runner has unexpectedly stopped|other side closed|UND_ERR_SOCKET/i.test(
          lastErr
        );
      if (ollamaLikelyDown && logCtx != null && logCtx.ollamaHostPort != null) {
        const ollamaPort = logCtx.ollamaHostPort;
        console.warn(
          `[integration] restarting ollama after recoverable error (attempt ${attempt + 1}): ${lastErr.slice(0, 220)}`
        );
        dockerCompose(logCtx.composeFile, ["restart", "ollama"], logCtx.ollamaModel);
        await waitForOllamaHostOk(ollamaPort);
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (logCtx != null) {
    logHostCpuDiagnostic();
    const n = integrationFailureComposeLogTailLines();
    console.error(`[integration] --- Rowboat /chat retries exhausted: docker compose logs --tail ${n} ollama rowboat ---`);
    console.error(composeServicesLogsTail(logCtx.composeFile, logCtx.ollamaModel, ["ollama", "rowboat"], n));
  }
  throw new Error(
    `Rowboat chat failed after retries: ${lastErr} (stderr: loadavg + compose log tail above when logCtx set)`
  );
}

export type RowboatChatMessage = { role: "user" | "assistant" | "system"; content: string };

/**
 * Multi-turn E2E: Rowboat continues a thread via `conversationId` + optional `state` from the prior response.
 * Each leg sends **only** the new user message (see Rowboat HTTP API); do not replay `{ role: "assistant", content }`
 * — upstream Zod expects agent/tool-shaped assistant rows, not plain text.
 */
export async function postRowboatMultiTurnThread(
  rowboatPort: number,
  userTurnContents: string[],
  logCtx?: {
    composeFile: string;
    ollamaModel: string;
    ollamaHostPort?: number;
    recoverOllama?: boolean;
  }
): Promise<{
  turns: Array<{ userMessage: string; assistantText: string; roundTripMs: number; turnJson: TurnJson }>;
  totalRoundTripMs: number;
}> {
  const turns: Array<{
    userMessage: string;
    assistantText: string;
    roundTripMs: number;
    turnJson: TurnJson;
  }> = [];
  let totalRoundTripMs = 0;
  let conversationId: string | undefined;
  let stateForNext: RowboatChatRequestOpts | undefined;
  for (let i = 0; i < userTurnContents.length; i++) {
    const userMessage = userTurnContents[i];
    const messages: RowboatChatMessage[] = [{ role: "user", content: userMessage }];
    const continueOpts =
      conversationId != null && conversationId !== ""
        ? stateForNext != null
          ? { conversationId, ...stateForNext }
          : { conversationId }
        : undefined;
    const r = await postRowboatChatWithRetry(rowboatPort, messages, logCtx, continueOpts);
    const cid = r.turnJson.conversationId;
    if (cid != null && cid !== "") {
      conversationId = cid;
    } else if (i < userTurnContents.length - 1) {
      throw new Error(
        "Rowboat /chat response missing conversationId; cannot continue multi-turn thread (see Rowboat API: pass conversationId + new user message only)"
      );
    }
    stateForNext = Object.prototype.hasOwnProperty.call(r.turnJson, "state")
      ? { state: r.turnJson.state }
      : undefined;
    const assistantText = firstAssistantTextFromChatResponse(r.turnJson);
    const roundTripMs = Math.round(r.ms);
    totalRoundTripMs += roundTripMs;
    turns.push({ userMessage, assistantText, roundTripMs, turnJson: r.turnJson });
  }
  return { turns, totalRoundTripMs };
}
