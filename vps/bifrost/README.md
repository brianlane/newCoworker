# Bifrost ([maximhq/bifrost](https://github.com/maximhq/bifrost))

Production installs use the **official Docker image** `maximhq/bifrost` (see [Quick Start](https://github.com/maximhq/bifrost#quick-start)): Web UI on port **8080**, OpenAI-compatible API, Ollama as a provider.

- **Documentation:** [docs.getbifrost.ai](https://docs.getbifrost.ai)
- **Heartbeat:** `GET http://127.0.0.1:8080/health` (used by [`vps/scripts/heartbeat.sh`](../scripts/heartbeat.sh))

## Files in this folder

| File | Purpose |
|------|--------|
| [`config-kvm2.yaml`](config-kvm2.yaml) | **Design reference** for **starter / KVM 2**: single-model routing to Ollama (`phi4-mini:3.8b`). The current gateway uses JSON / Web UI configuration — mirror this intent when adding the Ollama provider and routes. |
| [`config-kvm8.yaml`](config-kvm8.yaml) | **Design reference** for **standard / KVM 8**: multi-route fast / balanced / deep / verify. Mirror in the gateway UI or exported config. |

These YAML snippets match the **intent** of the old inline `config.yaml` from earlier bootstrap scripts; they are **not** guaranteed to be a drop-in schema for the latest Bifrost config format.

## On the VPS (bootstrap)

[`vps/scripts/bootstrap.sh`](../scripts/bootstrap.sh) writes **`/opt/bifrost/routing-intent.yaml`** from the same intent as `config-kvm2.yaml` (starter) or `config-kvm8.yaml` (standard), then starts:

```bash
docker run -d --name bifrost --restart unless-stopped --network host \
  -v /opt/bifrost/data:/app/data maximhq/bifrost:latest
```

Use **`--network host`** so the gateway can reach Ollama at `http://127.0.0.1:11434` without extra Docker networking. The live gateway stores configuration under `/opt/bifrost/data` inside the container; **`routing-intent.yaml` is a reference** for operators—mirror it in the Web UI (or import if your Bifrost version supports this shape).
