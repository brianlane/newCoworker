# llm-router

A ~200-line Node service that lets a single Rowboat container serve two agents:

- `dispatcher` (SMS) via Ollama on the host
- `voice_task` (voice tools) via Gemini's OpenAI-compatible endpoint

Rowboat points `PROVIDER_BASE_URL` at this service (`http://llm-router:11435/v1`).
We inspect the `model` field on each request and forward to the right upstream:

| Model prefix   | Upstream                                                    |
| -------------- | ----------------------------------------------------------- |
| `gemini-*`     | `https://generativelanguage.googleapis.com/v1beta/openai`   |
| everything else | `${OLLAMA_URL}` (default `http://127.0.0.1:11434`)         |

Streaming responses (SSE) are passed through unchanged.

## Environment

| Variable         | Default                                         | Notes                                     |
| ---------------- | ----------------------------------------------- | ----------------------------------------- |
| `LLM_ROUTER_PORT`| `11435`                                         | Bind port                                 |
| `OLLAMA_URL`     | `http://127.0.0.1:11434`                        | Set to `http://host.docker.internal:11434` when running in Docker with systemd Ollama on the host |
| `GOOGLE_API_KEY` | _(empty)_                                       | Required to serve `gemini-*` models       |
| `GEMINI_BASE_URL`| `https://generativelanguage.googleapis.com/v1beta/openai` | Override for tests                |

If `GOOGLE_API_KEY` is blank, `gemini-*` requests return a structured 503 so
Rowboat surfaces a clean error up to the caller.

## Health

`GET /health` (or `GET /`) returns `{ ok: true, ollama, geminiConfigured }`.
`GET /v1/models` returns a minimal OpenAI-shaped list (Rowboat's probe).

## Deployment

Containerized alongside Rowboat in `bootstrap.sh`'s docker-compose stack.
The container exposes port `11435` on the default compose network; Rowboat
reaches it via the service alias `llm-router`.
