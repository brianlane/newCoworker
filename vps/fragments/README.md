# VPS fragments (single source of truth helpers)

These files document **KVM2** tuning so it stays aligned with [`vps/scripts/bootstrap.sh`](../scripts/bootstrap.sh) and [`vps/scripts/deploy-client.sh`](../scripts/deploy-client.sh). The `starter-` filenames predate the tier/hardware split (KVM2 was the starter box until Jul 2026); today KVM2 is the STANDARD default and the legacy starter pins (`businesses.vps_size = 'kvm2'`), while new starter boxes are KVM1 and run no local Ollama at all (`src/lib/vps/size.ts`).

## [`starter-ollama-container.env`](starter-ollama-container.env)

Environment variables for the **Ollama** process on a **KVM2** box: mirrors bootstrap §4 `systemd` overrides (`OLLAMA_NUM_PARALLEL=1`, TurboQuant, Flash Attention). Use as reference when editing Docker Compose or gold images.

## [`ollama-Modelfile-starter-4096.example`](ollama-Modelfile-starter-4096.example)

Example `Modelfile` to cap **`num_ctx` at 4096** for the KVM2 fallback model (`llama3.2:3b`). Apply on the VPS with `ollama create` / `ollama run` after pulling the base model; **not** wired automatically in `bootstrap.sh` until you standardize on this model definition.

## 2026 model stack (Mercury / Qwen Omni / greeting swap)

Switching to alternate models requires coordinated updates to:

- `bootstrap.sh` (model pulls),
- `deploy-client.sh` (`PROVIDER_DEFAULT_MODEL` / `PROVIDER_BASE_URL` if the backend changes),
- Rowboat runtime (routing / voice).

Track in product planning. The local model is per box SIZE, not per tier: KVM1 carries none, KVM2/KVM4 carry **Llama 3.2 3B**, KVM8 carries **Qwen3 4B Instruct** (`vpsSizeHasLocalModel` in `src/lib/vps/size.ts`).
