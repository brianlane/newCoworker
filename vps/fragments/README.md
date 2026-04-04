# VPS fragments (single source of truth helpers)

These files document **starter (KVM2)** tuning so it stays aligned with [`vps/scripts/bootstrap.sh`](../scripts/bootstrap.sh) and [`vps/scripts/deploy-client.sh`](../scripts/deploy-client.sh).

## [`starter-ollama-container.env`](starter-ollama-container.env)

Environment variables for the **Ollama** process in **starter** tier: mirrors bootstrap §4 `systemd` overrides (`OLLAMA_NUM_PARALLEL=1`, TurboQuant, Flash Attention). Use as reference when editing Docker Compose or gold images.

## [`ollama-Modelfile-starter-4096.example`](ollama-Modelfile-starter-4096.example)

Example `Modelfile` to cap **`num_ctx` at 4096** for the default starter model (`phi4-mini:3.8b`). Apply on the VPS with `ollama create` / `ollama run` after pulling the base model; **not** wired automatically in `bootstrap.sh` until you standardize on this model definition.

## 2026 model stack (Mercury / Qwen Omni / greeting swap)

Switching to alternate models requires coordinated updates to:

- `bootstrap.sh` (model pulls),
- `vps/bifrost/config-kvm2.yaml` and `vps/integration/bifrost/kvm2-config.yaml` (routing intent; production gateway is [`maximhq/bifrost`](https://github.com/maximhq/bifrost) — see [`vps/bifrost/README.md`](../bifrost/README.md)),
- `deploy-client.sh` (`PROVIDER_DEFAULT_MODEL`),
- Rowboat runtime (routing / voice).

Track in product planning; fragments above are the **current** Phi-4 baseline.
