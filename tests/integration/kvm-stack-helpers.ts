import { expect } from "vitest";
import { execFileSync } from "node:child_process";
import { loadavg } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from "undici";
import {
  INTEGRATION_REQUEST_TIMEOUT_SLACK_MS,
  INTEGRATION_TEST_TIMEOUT_MS
} from "../../vitest.integration.constants";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

export const DEFAULT_MODEL_KVM2 = "llama3.2:3b";
export const DEFAULT_MODEL_KVM8 = "qwen3:4b-instruct";

export const KVM_STACKS = [
  {
    label: "kvm2-int",
    composeFile: "vps/integration/real/docker-compose.kvm2.yml",
    ports: { rowboat: 13000, ollama: 11134 },
    ollamaModel: process.env.INTEGRATION_OLLAMA_MODEL_KVM2 ?? DEFAULT_MODEL_KVM2
  },
  {
    label: "kvm8-int",
    composeFile: "vps/integration/real/docker-compose.kvm8.yml",
    ports: { rowboat: 23000, ollama: 21134 },
    ollamaModel: process.env.INTEGRATION_OLLAMA_MODEL_KVM8 ?? DEFAULT_MODEL_KVM8
  }
] as const;

export type KvmStack = (typeof KVM_STACKS)[number];

export function isKvm8ComposeFile(composeFile: string): boolean {
  return composeFile.includes("kvm8");
}

export function integrationKvmStacks(): readonly KvmStack[] {
  const skipKvm8 = process.env.INTEGRATION_SKIP_KVM8 === "1" || process.env.INTEGRATION_SKIP_KVM8 === "true";
  const skipKvm2 = process.env.INTEGRATION_SKIP_KVM2 === "1" || process.env.INTEGRATION_SKIP_KVM2 === "true";
  let out = KVM_STACKS as readonly KvmStack[];
  if (skipKvm8) {
    out = out.filter((s) => !isKvm8ComposeFile(s.composeFile));
  }
  if (skipKvm2) {
    out = out.filter((s) => isKvm8ComposeFile(s.composeFile));
  }
  if (out.length === 0) {
    throw new Error(
      "integrationKvmStacks(): no stacks left — do not set INTEGRATION_SKIP_KVM8 and INTEGRATION_SKIP_KVM2 together."
    );
  }
  return out;
}

export function resolveCorrectnessModelsForStack(stack: KvmStack): readonly string[] {
  const raw = process.env.INTEGRATION_CORRECTNESS_MODEL_SEQUENCE?.trim();
  if (!raw || !stack.composeFile.includes("kvm2")) {
    return [stack.ollamaModel];
  }
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : [stack.ollamaModel];
}

export function integrationKeepVolumes(): boolean {
  const v = process.env.INTEGRATION_KEEP_VOLUMES;
  return v === "1" || v === "true";
}

export function dockerCompose(composeFile: string, args: string[], ollamaModel: string) {
  const cmd = ["compose", "-f", composeFile, ...args];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      execFileSync("docker", cmd, {
        stdio: "inherit",
        cwd: repoRoot,
        env: { ...process.env, OLLAMA_MODEL: ollamaModel }
      });
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const transientNoSuchContainer =
        args.includes("up") && /No such container:/i.test(msg);
      if (!transientNoSuchContainer || attempt === 2) {
        throw err;
      }
      console.warn(
        `[integration] docker compose transient failure on ${composeFile} (${msg.slice(0, 220)}); retrying ${attempt + 2}/3`
      );
    }
  }
}

export function dockerComposeDown(composeFile: string, ollamaModel: string) {
  const args = integrationKeepVolumes() ? ["down"] : ["down", "-v"];
  dockerCompose(composeFile, args, ollamaModel);
}

export function curlOk(url: string): boolean {
  try {
    execFileSync("curl", ["-sf", "--max-time", "5", url], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function assertHeartbeatCurlLikeHeartbeatScript(ports: { rowboat: number; ollama: number }) {
  const host = "http://127.0.0.1";
  const rowboatOk =
    curlOk(`${host}:${ports.rowboat}/health`) || curlOk(`${host}:${ports.rowboat}/`);
  expect(rowboatOk, `Rowboat: curl /health or / on ${ports.rowboat} (heartbeat.sh)`).toBe(true);
  expect(curlOk(`${host}:${ports.ollama}/api/tags`), `Ollama: curl /api/tags on ${ports.ollama}`).toBe(true);
}

export const OLLAMA_CHAT_TIMEOUT_SEC = Math.min(
  7200,
  Math.max(
    120,
    Number.parseInt(
      process.env.INTEGRATION_OLLAMA_CHAT_TIMEOUT_SEC ??
        process.env.INTEGRATION_BIFROST_OLLAMA_TIMEOUT_SEC ??
        "3600",
      10
    ) || 3600
  )
);

export const CHAT_FETCH_MS = Math.min(
  OLLAMA_CHAT_TIMEOUT_SEC * 1000 + 120_000,
  INTEGRATION_TEST_TIMEOUT_MS - INTEGRATION_REQUEST_TIMEOUT_SLACK_MS
);

export function ollamaOpenAiModelName(modelTag: string): string {
  return modelTag.includes(":") ? modelTag : `${modelTag}:latest`;
}

export function ollamaPull(composeFile: string, model: string, ollamaModelEnv: string) {
  dockerCompose(composeFile, ["exec", "-T", "ollama", "ollama", "pull", model], ollamaModelEnv);
}

const integrationLlmHttpDispatcher = new Agent({
  headersTimeout: CHAT_FETCH_MS,
  bodyTimeout: CHAT_FETCH_MS,
  connectTimeout: 120_000
});

function undiciCompatibleInit(init?: RequestInit): RequestInit {
  if (!init) return {};
  const { body, ...rest } = init;
  if (body === null || body === undefined) return rest;
  return { ...rest, body };
}

export async function integrationLlmFetch(url: string | URL, init?: RequestInit): Promise<UndiciResponse> {
  return undiciFetch(url, {
    ...undiciCompatibleInit(init),
    dispatcher: integrationLlmHttpDispatcher
  } as Parameters<typeof undiciFetch>[1]);
}

const OLLAMA_CHAT_ATTEMPTS = Math.min(
  24,
  Math.max(
    5,
    Number.parseInt(
      process.env.INTEGRATION_OLLAMA_CHAT_ATTEMPTS ?? process.env.INTEGRATION_BIFROST_CHAT_ATTEMPTS ?? "12",
      10
    ) || 12
  )
);

function ollamaOutOfMemoryHint(responseBody: string): string {
  if (!/more system memory|requires more system memory/i.test(responseBody)) return "";
  return " — Ollama OOM: raise Docker Desktop / host RAM for the Linux VM, or choose a smaller Ollama tag.";
}

function ollamaChatRetryDelayMs(attempt: number, lastErr: string): number {
  if (
    /fetch failed|HeadersTimeout|UND_ERR_HEADERS|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket|network|other side closed/i.test(
      lastErr
    )
  ) {
    return Math.min(45_000, 6_000 + attempt * 4_000);
  }
  return 5_000;
}

export function formatErrorChain(err: unknown, maxDepth = 6): string {
  const parts: string[] = [];
  let cur: unknown = err;
  let depth = 0;
  while (cur != null && depth < maxDepth) {
    if (cur instanceof Error) {
      if (cur.message) parts.push(cur.message);
      if (cur.cause === undefined) break;
      cur = cur.cause;
    } else if (typeof cur === "string") {
      parts.push(cur);
      break;
    } else {
      parts.push(String(cur));
      break;
    }
    depth++;
  }
  return parts.join(" | cause: ");
}

export function integrationFailureComposeLogTailLines(): number {
  return Math.min(
    500,
    Math.max(40, Number.parseInt(process.env.INTEGRATION_FAILURE_LOG_TAIL ?? "120", 10) || 120)
  );
}

export function composeServicesLogsTail(
  composeFile: string,
  ollamaModel: string,
  services: string[],
  tailLines: number
): string {
  try {
    return execFileSync(
      "docker",
      ["compose", "-f", composeFile, "logs", "--no-color", "--tail", String(tailLines), ...services],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 12 * 1024 * 1024,
        env: { ...process.env, OLLAMA_MODEL: ollamaModel }
      }
    );
  } catch (e) {
    return `(could not read docker compose logs for [${services.join(", ")}]: ${e instanceof Error ? e.message : String(e)})`;
  }
}

export function logHostCpuDiagnostic(): void {
  const [a, b, c] = loadavg();
  console.error(
    `[integration] host loadavg (1m / 5m / 15m): ${a.toFixed(2)} ${b.toFixed(2)} ${c.toFixed(2)} — compare to CPU count; sustained high1m load often means saturation`
  );
  console.error(
    `[integration] host process: pid=${process.pid} uptime=${Math.round(process.uptime())}s platform=${process.platform}`
  );
}

export type LlmProbeDiagnosticsContext = {
  composeFile: string;
  ollamaModel: string;
  label?: string;
};

function logOllamaChatExhaustedDiagnostics(
  ctx: LlmProbeDiagnosticsContext | undefined,
  model: string,
  lastErr: string
) {
  logHostCpuDiagnostic();
  if (ctx == null) {
    console.error(`[integration] Ollama chat last error: ${lastErr.slice(0, 2000)}`);
    return;
  }
  const n = integrationFailureComposeLogTailLines();
  const tag = ctx.label ? ` — ${ctx.label}` : "";
  console.error(`[integration] --- Ollama chat exhausted${tag}: docker compose logs --tail ${n} ollama rowboat ---`);
  console.error(composeServicesLogsTail(ctx.composeFile, ctx.ollamaModel, ["ollama", "rowboat"], n));
}

function warnOllamaChatRetry(attempt: number, model: string, lastErr: string, caught: unknown | undefined) {
  const chain = caught != null ? formatErrorChain(caught) : "";
  const extra =
    caught != null && chain.length > 0 ? ` | causeChain: ${chain.slice(0, 800)}` : "";
  console.warn(
    `[integration] Ollama probe attempt ${attempt + 1}/${OLLAMA_CHAT_ATTEMPTS} model=${model}: ${lastErr.slice(0, 500)}${extra}`
  );
}

export function logIntegrationTierFailureDiagnostics(
  composeFile: string,
  ollamaModel: string,
  stackLabel: string
): void {
  console.error(`[integration] ${stackLabel} tier failure — diagnostics`);
  logHostCpuDiagnostic();
  const n = integrationFailureComposeLogTailLines();
  console.error(`[integration] --- docker compose logs --tail ${n} ollama rowboat ---`);
  console.error(composeServicesLogsTail(composeFile, ollamaModel, ["ollama", "rowboat"], n));
}

export async function waitForRowboatHttpOk(rowboatPort: number, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (curlOk(`http://127.0.0.1:${rowboatPort}/health`) || curlOk(`http://127.0.0.1:${rowboatPort}/`)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Rowboat not healthy on port ${rowboatPort} within ${timeoutMs}ms`);
}

export async function waitForOllamaHostOk(ollamaHostPort: number, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const requestTimeoutMs = Math.max(1, Math.min(5_000, remainingMs));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), requestTimeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${ollamaHostPort}/api/tags`, {
        signal: ac.signal
      });
      if (res.ok) return;
    } catch {
      /* still starting */
    } finally {
      clearTimeout(timer);
    }
    const sleepMs = Math.max(0, Math.min(2_000, deadline - Date.now()));
    if (sleepMs > 0) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }
  throw new Error(`Ollama not healthy on 127.0.0.1:${ollamaHostPort} within ${timeoutMs}ms`);
}

export async function assertOllamaOpenAiChat(
  ollamaHostPort: number,
  modelTag: string,
  diagnostics?: LlmProbeDiagnosticsContext
) {
  const model = ollamaOpenAiModelName(modelTag);
  let lastErr = "";
  for (let attempt = 0; attempt < OLLAMA_CHAT_ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CHAT_FETCH_MS);
    try {
      const res = await undiciFetch(`http://127.0.0.1:${ollamaHostPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        dispatcher: integrationLlmHttpDispatcher,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with exactly: ok" }],
          max_tokens: 16
        })
      });
      const text = await res.text();
      if (res.ok) {
        const json = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
        expect(json.choices?.length, "Ollama returned choices").toBeGreaterThan(0);
        return;
      }
      lastErr = `${res.status} ${text.slice(0, 500)}${ollamaOutOfMemoryHint(text)}`;
      warnOllamaChatRetry(attempt, model, lastErr, undefined);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      warnOllamaChatRetry(attempt, model, lastErr, e);
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, ollamaChatRetryDelayMs(attempt, lastErr)));
  }
  logOllamaChatExhaustedDiagnostics(diagnostics, model, lastErr);
  throw new Error(
    `Ollama /v1/chat/completions (${model}) failed after retries: ${lastErr} (stderr: compose log tail + loadavg above)`
  );
}
