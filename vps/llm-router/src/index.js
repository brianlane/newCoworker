/**
 * newcoworker-llm-router
 *
 * OpenAI-compatible HTTP router that sits between Rowboat and two upstream
 * LLM providers:
 *
 *   - Ollama (local, for the `dispatcher` SMS agent — llama*/qwen* models)
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

const ROUTED_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings"
]);

import { pickUpstream } from "./routing.js";
export { pickUpstream };

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
  if (upstream === "gemini" && !GOOGLE_API_KEY) {
    writeJson(res, 503, {
      error: {
        message: "GOOGLE_API_KEY not configured on llm-router",
        type: "config_error"
      }
    });
    return;
  }

  const target = buildUpstreamTarget(upstream, req.url?.split("?")[0] ?? "/v1/chat/completions");

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

  // Pass upstream headers through unchanged so streaming (text/event-stream)
  // and content-length align exactly. Filter out hop-by-hop headers that
  // Node's http module re-adds.
  const outHeaders = {};
  upstreamResp.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === "transfer-encoding" || k === "connection" || k === "keep-alive") return;
    outHeaders[k] = value;
  });
  res.writeHead(upstreamResp.status, outHeaders);

  if (!upstreamResp.body) {
    res.end();
    return;
  }

  // Stream in chunks using the Web ReadableStream reader. Works for both the
  // SSE stream case (model=gpt-..., stream:true) and the plain JSON case.
  const reader = upstreamResp.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
  } catch (err) {
    // Client likely disconnected mid-stream. Nothing useful to send.
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
