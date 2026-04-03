import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Starter (KVM2) / standard (KVM8) — aligned with deploy-client.sh + bootstrap.sh model pulls. */
const DEFAULT_MODEL_KVM2 = "phi4-mini:3.8b";
const DEFAULT_MODEL_KVM8 = "qwen3.5:9b";

const STACKS = [
  {
    label: "kvm2-int",
    composeFile: "vps/integration/real/docker-compose.kvm2.yml",
    ports: { rowboat: 13000, bifrost: 18080, ollama: 11134 },
    ollamaModel: process.env.INTEGRATION_OLLAMA_MODEL_KVM2 ?? DEFAULT_MODEL_KVM2,
    ollamaProviderBaseUrl: "http://ollama:11434"
  },
  {
    label: "kvm8-int",
    composeFile: "vps/integration/real/docker-compose.kvm8.yml",
    ports: { rowboat: 23000, bifrost: 28080, ollama: 21134 },
    ollamaModel: process.env.INTEGRATION_OLLAMA_MODEL_KVM8 ?? DEFAULT_MODEL_KVM8,
    ollamaProviderBaseUrl: "http://ollama:11434"
  }
] as const;

function dockerCompose(composeFile: string, args: string[], ollamaModel: string) {
  execFileSync("docker", ["compose", "-f", composeFile, ...args], {
    stdio: "inherit",
    cwd: repoRoot,
    env: { ...process.env, OLLAMA_MODEL: ollamaModel }
  });
}

/** Same probes as vps/scripts/heartbeat.sh (curl -sf), using mapped host ports. */
function curlOk(url: string): boolean {
  try {
    execFileSync("curl", ["-sf", "--max-time", "5", url], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function assertHeartbeatCurlLikeHeartbeatScript(ports: { rowboat: number; bifrost: number; ollama: number }) {
  const host = "http://127.0.0.1";
  const rowboatOk =
    curlOk(`${host}:${ports.rowboat}/health`) || curlOk(`${host}:${ports.rowboat}/`);
  expect(rowboatOk, `Rowboat: curl /health or / on ${ports.rowboat} (heartbeat.sh)`).toBe(true);

  expect(curlOk(`${host}:${ports.bifrost}/health`), `Bifrost: curl /health on ${ports.bifrost}`).toBe(true);

  expect(curlOk(`${host}:${ports.ollama}/api/tags`), `Ollama: curl /api/tags on ${ports.ollama}`).toBe(true);
}

async function assertBifrostHealthJson(bifrostPort: number) {
  const res = await fetch(`http://127.0.0.1:${bifrostPort}/health`);
  expect(res.ok, `Bifrost fetch /health JSON on ${bifrostPort}`).toBe(true);
  const bifrostJson = (await res.json()) as { status?: string };
  expect(bifrostJson.status, "Bifrost health JSON status").toBe("ok");
}

/** Large models (e.g. qwen3.5:9b) can exceed 120s on first completion; match generous gateway timeouts. */
const BIFROST_OLLAMA_TIMEOUT_SEC = 600;

async function registerOllamaProvider(bifrostPort: number, baseUrl: string) {
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

function ollamaPull(composeFile: string, model: string, ollamaModelEnv: string) {
  dockerCompose(composeFile, ["exec", "-T", "ollama", "ollama", "pull", model], ollamaModelEnv);
}

const CHAT_FETCH_MS = 600_000;

async function assertBifrostChat(bifrostPort: number, modelTag: string) {
  const model = bifrostModelRef(modelTag);
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CHAT_FETCH_MS);
    try {
      const res = await fetch(`http://127.0.0.1:${bifrostPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with exactly: ok" }],
          max_tokens: 16
        })
      });
      const text = await res.text();
      if (res.ok) {
        const json = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
        expect(json.choices?.length, "Bifrost returned choices").toBeGreaterThan(0);
        return;
      }
      lastErr = `${res.status} ${text.slice(0, 500)}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`Bifrost chat completions (${model}) failed after retries: ${lastErr}`);
}

describe("KVM Docker integration (real Rowboat + Bifrost + Ollama, sequential)", () => {
  it(
    "kvm2-int then kvm8-int: health (curl like heartbeat.sh), Bifrost provider + chat, Ollama model pull",
    async () => {
      for (const stack of STACKS) {
        const model = stack.ollamaModel;
        try {
          dockerCompose(stack.composeFile, ["up", "-d", "--wait"], model);
          assertHeartbeatCurlLikeHeartbeatScript(stack.ports);
          await assertBifrostHealthJson(stack.ports.bifrost);

          for (let attempt = 0; attempt < 5; attempt++) {
            try {
              await registerOllamaProvider(stack.ports.bifrost, stack.ollamaProviderBaseUrl);
              break;
            } catch (e) {
              if (attempt === 4) throw e;
              await new Promise((r) => setTimeout(r, 2000));
            }
          }

          ollamaPull(stack.composeFile, model, model);
          await assertBifrostChat(stack.ports.bifrost, model);
        } finally {
          dockerCompose(stack.composeFile, ["down", "-v"], model);
        }
      }
    },
    600_000
  );
});
