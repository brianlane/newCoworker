import { integrationLlmFetch, CHAT_FETCH_MS, formatErrorChain } from "../kvm-stack-helpers";

const OLLAMA_HOST_WARMUP_ATTEMPTS = 6;

/**
 * Hit Ollama’s HTTP API on the **mapped host port** so the model loads and one completion finishes
 * before Rowboat calls Ollama (avoids tight header timeouts on first token). Prefer this over
 * `docker exec … ollama run`, which can block on TTY / stream handling.
 * Retries: Ollama may reset the socket while loading weights (`other side closed`).
 */
export async function warmupOllamaViaHostApi(ollamaHostPort: number, ollamaModel: string) {
  let lastErr = "";
  for (let attempt = 0; attempt < OLLAMA_HOST_WARMUP_ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CHAT_FETCH_MS);
    let caught: unknown;
    try {
      const res = await integrationLlmFetch(`http://127.0.0.1:${ollamaHostPort}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          model: ollamaModel,
          prompt: "Reply with one word: ok.",
          stream: false
        })
      });
      const text = await res.text();
      if (res.ok) return;
      lastErr = `Ollama warmup /api/generate ${res.status}: ${text.slice(0, 800)}`;
    } catch (e) {
      caught = e;
      lastErr = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
    const waitMs = Math.min(30_000, 4_000 + attempt * 5_000);
    const chain = caught != null ? formatErrorChain(caught).slice(0, 600) : "";
    const chainSuffix =
      chain && chain !== lastErr && !chain.startsWith(lastErr) ? ` | ${chain}` : "";
    console.warn(
      `[integration] Ollama warmup ${ollamaModel} attempt ${attempt + 1}/${OLLAMA_HOST_WARMUP_ATTEMPTS} failed — ${lastErr.slice(0, 220)}${chainSuffix}; retry in ${waitMs}ms`
    );
    await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error(`Ollama warmup failed after ${OLLAMA_HOST_WARMUP_ATTEMPTS} attempts: ${lastErr}`);
}

export async function warmupOllamaViaHostApiTimed(ollamaHostPort: number, ollamaModel: string): Promise<number> {
  const t0 = performance.now();
  await warmupOllamaViaHostApi(ollamaHostPort, ollamaModel);
  return Math.round(performance.now() - t0);
}
