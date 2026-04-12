# VPS fragments (single source of truth helpers)

These files document **starter (KVM2)** tuning so it stays aligned with [`vps/scripts/bootstrap.sh`](../scripts/bootstrap.sh) and [`vps/scripts/deploy-client.sh`](../scripts/deploy-client.sh).

## [`starter-ollama-container.env`](starter-ollama-container.env)

Environment variables for the **Ollama** process in **starter** tier: mirrors bootstrap §4 `systemd` overrides (`OLLAMA_NUM_PARALLEL=1`, TurboQuant, Flash Attention). Use as reference when editing Docker Compose or gold images.

## [`ollama-Modelfile-starter-4096.example`](ollama-Modelfile-starter-4096.example)

Example `Modelfile` to cap **`num_ctx` at 4096** for the default starter model (`llama3.2:3b`). Apply on the VPS with `ollama create` / `ollama run` after pulling the base model; **not** wired automatically in `bootstrap.sh` until you standardize on this model definition.

## 2026 model stack (Mercury / Qwen Omni / greeting swap)

Switching to alternate models requires coordinated updates to:

- `bootstrap.sh` (model pulls),
- `deploy-client.sh` (`PROVIDER_DEFAULT_MODEL` / `PROVIDER_BASE_URL` if the backend changes),
- Rowboat runtime (routing / voice).

Track in product planning; starter baseline is **Llama 3.2 3B**; standard (KVM8) remains **Qwen3 4B Instruct**.
