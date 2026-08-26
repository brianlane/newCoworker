---
name: project_sidecar_containers_cannot_use_loopback
description: A VPS sidecar container cannot reach another sidecar on 127.0.0.1 or host.docker.internal; use Docker DNS on rowboat_default.
metadata:
  node_type: memory
  type: project
---

Every VPS sidecar (`voice-bridge`, `rowboat`, `data-api`, `aiflow-render`) is a CONTAINER, and they publish on the HOST loopback only (`127.0.0.1:<port>`), because cloudflared is a host process that forwards the tunnel hostname there.

So from inside one sidecar:
- `127.0.0.1:<port>` is **that container itself**. Connection refused.
- `host.docker.internal:<port>` lands on the docker-bridge IP where **nothing is listening**, so it hangs until timeout.
- The only thing that works is **Docker DNS on a shared network**: `http://<container_name>:<port>`, with both services on `rowboat_default` (created by the Rowboat stack, which `deploy-client.sh` brings up first).

`vps/voice-bridge/docker-compose.yml`'s header documents this as a **May 2026 outage**: the bridge accepted the Telnyx WebSocket, opened Gemini Live, then sat silent because every Rowboat fetch hung 30s before failing.

**Why:** "it's on the same box" is true of the HOST and false of a container, and the distinction is invisible in code review. I wrote the same bug in PR #1578 directly underneath that header comment, reasoning that the voice bridge could read the residency data-api on 127.0.0.1:8091. Bugbot caught it.

**How to apply:**
- Adding cross-sidecar traffic means adding the callee to `rowboat_default` in its compose file (keep `default` listed too, or it drops off its own private network and loses its database).
- Keep datastores off the shared network: `residency-postgres` stays on `default` and binds no host port.
- A unit test that injects `fetch` never dials the URL, so it cannot catch this. Assert the URL string AND that both compose files share the network: asserting the DNS name alone is a test that passes while production cannot connect.

See [[project_vps_sidecars_had_no_undef_check]] and [[project_fleet_redeploy_check]].
