import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const COMPOSE = "vps/integration/real/docker-compose.kvm2-prodlike.yml";
const OLLAMA_CONTAINER = "rowboat-integration-prodlike-ollama";
const DEFAULT_MODEL = process.env.INTEGRATION_OLLAMA_MODEL_KVM2 ?? "phi4-mini:3.8b";

/** Default 11435 avoids bind conflicts with a typical host Ollama on 11434. */
const OLLAMA_HOST_PORT = process.env.INTEGRATION_PRODLIKE_OLLAMA_HOST_PORT ?? "11435";

const PORTS = { rowboat: 13100, bifrost: 18100 } as const;

function dockerCompose(args: string[], ollamaModel: string) {
  execFileSync("docker", ["compose", "-f", COMPOSE, ...args], {
    stdio: "inherit",
    cwd: repoRoot,
    env: {
      ...process.env,
      OLLAMA_MODEL: ollamaModel,
      INTEGRATION_PRODLIKE_OLLAMA_HOST_PORT: OLLAMA_HOST_PORT
    }
  });
}

function curlOk(url: string): boolean {
  try {
    execFileSync("curl", ["-sf", "--max-time", "5", url], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function waitForOllamaOnHost(maxAttempts = 60) {
  const url = `http://127.0.0.1:${OLLAMA_HOST_PORT}/api/tags`;
  for (let i = 0; i < maxAttempts; i++) {
    if (curlOk(url)) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Ollama did not become ready on 127.0.0.1:${OLLAMA_HOST_PORT}`);
}

const BIFROST_OLLAMA_TIMEOUT_SEC = 600;

async function registerOllamaProvider(bifrostPort: number) {
  const baseUrl = `http://host.docker.internal:${OLLAMA_HOST_PORT}`;
  const res = await fetch(`http://127.0.0.1:${bifrostPort}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "ollama",
      network_config: {
        base_url: baseUrl,
        default_request_timeout_in_seconds: BIFROST_OLLAMA_TIMEOUT_SEC
      }
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bifrost POST /api/providers failed: ${res.status} ${text}`);
  }
}

function bifrostModelRef(model: string): string {
  const tagged = model.includes(":") ? model : `${model}:latest`;
  return `ollama/${tagged}`;
}

const CHAT_FETCH_MS = 600_000;

describe("KVM prod-like integration (host Ollama + host.docker.internal)", () => {
  it(
    "starts Ollama on a host port, stack without in-compose Ollama, Bifrost chat via host.docker.internal",
    async () => {
      const model = DEFAULT_MODEL;
      try {
        execFileSync("docker", ["rm", "-f", OLLAMA_CONTAINER], { stdio: "ignore", cwd: repoRoot });
        execFileSync(
          "docker",
          [
            "run",
            "-d",
            "--name",
            OLLAMA_CONTAINER,
            "-p",
            `127.0.0.1:${OLLAMA_HOST_PORT}:11434`,
            "ollama/ollama:latest"
          ],
          { stdio: "inherit", cwd: repoRoot }
        );
        await waitForOllamaOnHost();

        dockerCompose(["up", "-d", "--wait"], model);

        const rowboatOk =
          curlOk(`http://127.0.0.1:${PORTS.rowboat}/health`) ||
          curlOk(`http://127.0.0.1:${PORTS.rowboat}/`);
        expect(rowboatOk, "Rowboat curl /health or /").toBe(true);
        expect(curlOk(`http://127.0.0.1:${PORTS.bifrost}/health`), "Bifrost curl /health").toBe(true);

        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await registerOllamaProvider(PORTS.bifrost);
            break;
          } catch (e) {
            if (attempt === 4) throw e;
            await new Promise((r) => setTimeout(r, 2000));
          }
        }

        execFileSync(
          "docker",
          ["exec", OLLAMA_CONTAINER, "ollama", "pull", model],
          { stdio: "inherit", cwd: repoRoot }
        );

        const m = bifrostModelRef(model);
        let lastErr = "";
        for (let attempt = 0; attempt < 5; attempt++) {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), CHAT_FETCH_MS);
          try {
            const chat = await fetch(`http://127.0.0.1:${PORTS.bifrost}/v1/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: ac.signal,
              body: JSON.stringify({
                model: m,
                messages: [{ role: "user", content: "Reply with exactly: ok" }],
                max_tokens: 16
              })
            });
            const text = await chat.text();
            if (chat.ok) {
              const json = JSON.parse(text) as { choices?: unknown[] };
              expect(json.choices?.length, "Bifrost returned choices").toBeGreaterThan(0);
              return;
            }
            lastErr = `${chat.status} ${text.slice(0, 500)}`;
          } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e);
          } finally {
            clearTimeout(timer);
          }
          await new Promise((r) => setTimeout(r, 5000));
        }
        throw new Error(`Bifrost chat (${m}) failed after retries: ${lastErr}`);
      } finally {
        try {
          dockerCompose(["down", "-v"], model);
        } catch {
          /* teardown best-effort */
        }
        execFileSync("docker", ["rm", "-f", OLLAMA_CONTAINER], { stdio: "ignore", cwd: repoRoot });
      }
    },
    600_000
  );
});
