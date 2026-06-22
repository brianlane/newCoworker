/**
 * newcoworker-llm-router
 *
 * OpenAI-compatible HTTP router that sits between Rowboat and two upstream
 * LLM providers:
 *
 *   - Ollama (local, for the `dispatcher` SMS agent — llama / qwen models)
 *   - Gemini via its OpenAI-compatible endpoint (for the `voice_task` voice
 *     agent — gemini-* models)
 *
 * Rowboat is configured with a single `PROVIDER_BASE_URL` pointing at this
 * service. We inspect the `model` field on each `/v1/chat/completions` or
 * `/v1/completions` request and forward to the appropriate upstream with
 * the correct auth. Streaming is passed through verbatim.
 *
 * Environment:
 *   LLM_ROUTER_PORT       — listen port (default 11435)
 *   OLLAMA_URL            — e.g. http://host.docker.internal:11434
 *                           (default http://127.0.0.1:11434)
 *   GOOGLE_API_KEY        — required to serve gemini-* models
 *   GEMINI_BASE_URL       — override for testing (default Google's public
 *                           OpenAI-compat endpoint)
 *
 * Deliberate non-goals:
 *   - Auth. The router binds to loopback / docker bridge only. Rowboat trusts
 *     it implicitly, and the bridge doesn't talk to it.
 *   - Request validation. We forward as-is; upstream returns OpenAI-shaped
 *     errors on malformed bodies.
 *   - Model name rewriting. Ollama accepts the model name verbatim, as does
 *     Gemini's OpenAI-compat endpoint.
 */

import http from "node:http";

const PORT = Number(process.env.LLM_ROUTER_PORT || 11435);
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const GEMINI_BASE_URL = (
  process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai"
).replace(/\/+$/, "");
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";

// ── Exact AI-chat-budget metering ─────────────────────────────────────────
// This sidecar is the ONLY component on the box that sees both the request
// `model` and the response token `usage` for every Gemini call Rowboat makes
// (Rowboat's /chat reply hides usage from the chat-worker / SMS worker, which
// is why those surfaces previously metered a chars/4 ESTIMATE). We meter the
// exact billed tokens here by POSTing them to the platform, which records them
// into the same `owner_chat_model_spend` pool the billing page reads.
//
// All three come from /opt/rowboat/.env (env_file on this service) which
// deploy-client.sh already writes. When any is absent we silently skip
// metering — a misconfigured box must never break model proxying.
const BUSINESS_ID = process.env.BUSINESS_ID || "";
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
const GATEWAY_TOKEN = process.env.ROWBOAT_GATEWAY_TOKEN || "";
// Voice_task model (default gemini-3.1-flash); its spend is voice minutes, not
// the chat budget, so isChatBudgetModel() excludes it. Mirrors deploy-client.sh.
const VOICE_MODEL = process.env.GEMINI_ROWBOAT_MODEL || "gemini-3.1-flash";
const METER_ENABLED = Boolean(BUSINESS_ID && APP_BASE_URL && GATEWAY_TOKEN);

/**
 * Fire-and-forget: report one exact Gemini turn's billed tokens to the
 * platform meter endpoint. Never awaited and never throws — the model reply
 * already streamed to Rowboat, so a metering hiccup may only under-count the
 * fuse, never fail a turn. (The app endpoint is idempotent-safe per call: each
 * proxied completion is a distinct spend event.)
 */
function reportGeminiSpend(model, usage) {
  if (!METER_ENABLED || !usage) return;
  const url = `${APP_BASE_URL}/api/internal/meter-gemini-spend`;
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${GATEWAY_TOKEN}`
    },
    body: JSON.stringify({ businessId: BUSINESS_ID, model, usage })
  }).catch((err) => {
    console.warn(`llm-router: meter report failed: ${err instanceof Error ? err.message : err}`);
  });
}

const ROUTED_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings"
]);

import {
  pickUpstream,
  filterUpstreamHeaders,
  mergeSystemMessages,
  addToolCallIndices,
  createSseToolCallIndexNormalizer,
  isChatBudgetModel,
  extractOpenAiUsage,
  createSseUsageCollector
} from "./routing.js";
export {
  pickUpstream,
  filterUpstreamHeaders,
  mergeSystemMessages,
  addToolCallIndices,
  createSseToolCallIndexNormalizer,
  isChatBudgetModel,
  extractOpenAiUsage,
  createSseUsageCollector
};

function buildUpstreamTarget(upstream, pathname) {
  if (upstream === "gemini") {
    return {
      url: `${GEMINI_BASE_URL}${pathname.replace(/^\/v1/, "")}`,
      headers: {
        authorization: `Bearer ${GOOGLE_API_KEY}`,
        "content-type": "application/json"
      }
    };
  }
  return {
    url: `${OLLAMA_URL}${pathname}`,
    headers: { "content-type": "application/json" }
  };
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    total += chunk.length;
    // 2 MB hard cap. Prompts + history can be large but should never need this
    // much; reject runaways so a buggy upstream can't OOM the router.
    if (total > 2 * 1024 * 1024) {
      throw new Error("body_too_large");
    }
  }
  return Buffer.concat(chunks);
}

function writeJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": payload.length
  });
  res.end(payload);
}

async function handleRoutedRequest(req, res) {
  let bodyBuf;
  try {
    bodyBuf = await readBody(req);
  } catch (err) {
    writeJson(res, 413, { error: { message: "body_too_large", type: "invalid_request_error" } });
    return;
  }

  // Parse the body to inspect `model`. Fall back to ollama on parse failure
  // (Rowboat may eventually POST non-JSON for /embeddings in some modes; we
  // never want to mis-route mid-sentence).
  let parsed = null;
  if (bodyBuf.length > 0) {
    try {
      parsed = JSON.parse(bodyBuf.toString("utf8"));
    } catch {
      parsed = null;
    }
  }

  const upstream = pickUpstream(parsed?.model);
  const requestPath = req.url?.split("?")[0] ?? "/v1/chat/completions";
  // Meter this turn's exact tokens into the chat budget unless it's the voice
  // path (see isChatBudgetModel). Scoped to /v1/chat/completions: the agentic
  // chat surfaces (owner chat / SMS / summarizers) all run there; /v1/embeddings
  // and /v1/completions are a different cost line and stay out of this budget.
  // Decided pre-fetch so we know whether to accumulate the response body for
  // usage and whether to request usage on a streamed turn.
  const meterGemini =
    upstream === "gemini" &&
    requestPath === "/v1/chat/completions" &&
    isChatBudgetModel(parsed?.model, VOICE_MODEL);

  // Build the outgoing body once, applying two rewrites where needed:
  //  1) Collapse multiple system messages — Gemini's OpenAI-compat keeps only
  //     the LAST, which silently dropped Rowboat's vault-grounded agent
  //     instructions when a second system message was present (see routing.js).
  //  2) On a metered streamed turn, ask for `stream_options.include_usage` so
  //     the upstream emits a terminal `{choices:[],usage:{...}}` chunk we can
  //     harvest exact tokens from. (OpenAI-compat consumers like Rowboat's AI
  //     SDK ignore the usage-only chunk, so this is transparent to Rowboat.)
  if (parsed) {
    let outgoing = Array.isArray(parsed.messages) ? mergeSystemMessages(parsed) : parsed;
    if (meterGemini && parsed.stream === true) {
      outgoing = {
        ...outgoing,
        stream_options: { ...(outgoing.stream_options ?? {}), include_usage: true }
      };
    }
    if (outgoing !== parsed) {
      bodyBuf = Buffer.from(JSON.stringify(outgoing), "utf8");
    }
  }

  if (upstream === "gemini" && !GOOGLE_API_KEY) {
    writeJson(res, 503, {
      error: {
        message: "GOOGLE_API_KEY not configured on llm-router",
        type: "config_error"
      }
    });
    return;
  }

  const target = buildUpstreamTarget(upstream, requestPath);

  let upstreamResp;
  try {
    upstreamResp = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: bodyBuf
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeJson(res, 502, {
      error: {
        message: `llm-router upstream error: ${message}`,
        type: "upstream_error",
        upstream
      }
    });
    return;
  }

  // Forward upstream headers, dropping hop-by-hop framing AND the body-encoding
  // headers (content-encoding/content-length): undici's fetch already decoded
  // the body we're about to re-stream, so those headers would describe bytes
  // that no longer exist (see filterUpstreamHeaders). Node re-frames the
  // decoded body as chunked.
  res.writeHead(upstreamResp.status, filterUpstreamHeaders(upstreamResp.headers));

  if (!upstreamResp.body) {
    res.end();
    return;
  }

  // Stream in chunks using the Web ReadableStream reader. Works for both the
  // SSE stream case (model=gpt-..., stream:true) and the plain JSON case.
  //
  // SSE streams get rewritten through the tool-call index normalizer: Gemini
  // omits the REQUIRED `index` on streamed tool_calls deltas, which made
  // Rowboat's AI SDK reject every function call (see routing.js).
  const contentType = upstreamResp.headers.get("content-type") || "";
  const isSse = contentType.includes("text/event-stream");
  const normalizer = isSse ? createSseToolCallIndexNormalizer() : null;
  const decoder = isSse ? new TextDecoder("utf-8") : null;

  // Usage harvesting (only for metered gemini turns): SSE streams feed an SSE
  // usage collector; buffered JSON bodies accumulate into a string we parse
  // once at end-of-stream. The bytes forwarded downstream are unchanged.
  const usageCollector = meterGemini && isSse ? createSseUsageCollector() : null;
  const jsonDecoder = meterGemini && !isSse ? new TextDecoder("utf-8") : null;
  let jsonBuf = meterGemini && !isSse ? "" : null;

  const reader = upstreamResp.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (normalizer) {
        const text = decoder.decode(value, { stream: true });
        if (usageCollector) usageCollector.collect(text);
        const out = normalizer.transform(text);
        if (out) res.write(out);
      } else {
        res.write(Buffer.from(value));
        if (jsonBuf !== null) jsonBuf += jsonDecoder.decode(value, { stream: true });
      }
    }
    if (normalizer) {
      const tailText = decoder.decode();
      if (usageCollector) usageCollector.collect(tailText);
      const tail = normalizer.transform(tailText) + normalizer.flush();
      if (tail) res.write(tail);
    }
    // Stream completed cleanly — extract the exact usage and report it.
    if (meterGemini) {
      let usage = null;
      if (usageCollector) {
        usageCollector.flush();
        usage = usageCollector.result();
      } else if (jsonBuf !== null) {
        jsonBuf += jsonDecoder.decode();
        try {
          usage = extractOpenAiUsage(JSON.parse(jsonBuf));
        } catch {
          usage = null;
        }
      }
      if (usage) reportGeminiSpend(parsed?.model, usage);
    }
  } catch (err) {
    // Client likely disconnected mid-stream. Nothing useful to send, and we
    // skip metering a turn we couldn't fully observe (never over-counts).
  } finally {
    res.end();
  }
}

function handleHealth(_req, res) {
  writeJson(res, 200, {
    ok: true,
    service: "llm-router",
    port: PORT,
    ollama: OLLAMA_URL,
    geminiConfigured: Boolean(GOOGLE_API_KEY)
  });
}

function handleModels(_req, res) {
  // Minimal model list so Rowboat's probe (`GET /v1/models`) doesn't 404. We
  // advertise the two tiers the rest of the system knows about; Rowboat
  // never filters on this list.
  writeJson(res, 200, {
    object: "list",
    data: [
      { id: "llama3.2:3b", object: "model", owned_by: "ollama" },
      { id: "qwen3:4b-instruct", object: "model", owned_by: "ollama" },
      { id: "gemini-3.1-flash", object: "model", owned_by: "google" }
    ]
  });
}

const server = http.createServer((req, res) => {
  const url = req.url?.split("?")[0] ?? "/";
  if (req.method === "GET" && (url === "/" || url === "/health")) {
    handleHealth(req, res);
    return;
  }
  if (req.method === "GET" && url === "/v1/models") {
    handleModels(req, res);
    return;
  }
  if (req.method === "POST" && ROUTED_PATHS.has(url)) {
    void handleRoutedRequest(req, res);
    return;
  }
  writeJson(res, 404, { error: { message: "not_found", type: "invalid_request_error" } });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `llm-router: listening on :${PORT} (ollama=${OLLAMA_URL}, gemini=${GOOGLE_API_KEY ? "ready" : "disabled"})`
  );
});

function shutdown(signal) {
  console.log(`llm-router: received ${signal}, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
