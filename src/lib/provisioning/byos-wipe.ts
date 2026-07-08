/**
 * Terminal wipe for BYOS boxes (grace-expired lifecycle path).
 *
 * A canceled Hostinger tenant's box is stopped + returned to the pool; a
 * BYOS box belongs to the CUSTOMER, so the equivalent terminal action is to
 * remove everything the platform put on it — containers, images/volumes,
 * the repo checkout, and every `.env` secret (gateway token, tunnel token,
 * backup passphrase, service-role key) — and leave the box otherwise
 * untouched for its owner. Central-side revocation (gateway token, tunnel
 * deletion, business `wiped` status) is handled by the same lifecycle plan
 * that dispatches this op; this module is only the on-box half.
 *
 * The script is embedded (not read from the box's repo checkout) so the
 * wipe never depends on the state it is deleting, and every step is
 * best-effort (`|| true`) — a half-broken box must still shed as many
 * secrets as possible rather than aborting at the first missing unit.
 */

import { getActiveVpsSshKeyForBusiness } from "@/lib/db/vps-ssh-keys";
import { sshExec } from "@/lib/hostinger/ssh";
import { logger } from "@/lib/logger";

export const BYOS_WIPE_DONE_MARKER = "newcoworker-byos-wipe-complete";

export const BYOS_WIPE_SCRIPT = `#!/bin/bash
# newCoworker BYOS terminal wipe. Best-effort by design: keep going on
# errors so a degraded box still sheds every platform secret it can.
set -u
log() { echo "[newcoworker-wipe] $*"; }

log "stopping platform services"
systemctl disable --now cloudflared 2>/dev/null || true
systemctl disable --now ollama 2>/dev/null || true
systemctl disable --now zram-setup 2>/dev/null || true

log "removing cron entries"
crontab -r 2>/dev/null || true

if command -v docker >/dev/null 2>&1; then
  log "tearing down containers, images, and volumes"
  for compose in /opt/rowboat/docker-compose.yml /opt/voice-bridge/docker-compose.yml /opt/chat-worker/docker-compose.yml /opt/aiflow-render/docker-compose.yml /opt/data-api/docker-compose.yml; do
    [ -f "$compose" ] && docker compose -f "$compose" down --remove-orphans -v 2>/dev/null || true
  done
  docker ps -aq | xargs -r docker rm -f 2>/dev/null || true
  docker system prune -af --volumes 2>/dev/null || true
fi

log "shredding platform secrets"
find /opt -maxdepth 2 -name ".env" -type f -exec shred -u {} \\; 2>/dev/null || true

log "removing platform directories"
rm -rf /opt/rowboat /opt/chat-worker /opt/voice-bridge /opt/aiflow-render \\
  /opt/data-api /opt/newcoworker /opt/newcoworker-repo /opt/deploy-client.sh \\
  /etc/cloudflared /root/.cloudflared 2>/dev/null || true

echo "${BYOS_WIPE_DONE_MARKER}"
`;

export type WipeByosBoxDeps = {
  /** Injectable SSH executor (tests). Defaults to {@link sshExec}. */
  exec?: typeof sshExec;
};

/**
 * Run the terminal wipe on a BYOS box over SSH. Throws when the box is
 * unreachable or the wipe never printed its completion marker, so the
 * lifecycle slow-phase logs the failure loudly (the grace-sweep retries on
 * its next tick — the plan is idempotent).
 */
export async function wipeByosBox(
  input: { businessId: string; vpsHost: string },
  deps: WipeByosBoxDeps = {}
): Promise<void> {
  /* c8 ignore next -- production default; tests inject exec */
  const exec = deps.exec ?? sshExec;
  const key = await getActiveVpsSshKeyForBusiness(input.businessId);
  if (!key) {
    throw new Error(
      `wipeByosBox: no active SSH key for business ${input.businessId} — cannot reach the box`
    );
  }
  const b64 = Buffer.from(BYOS_WIPE_SCRIPT, "utf8").toString("base64");
  const result = await exec({
    host: input.vpsHost,
    username: key.ssh_username,
    privateKeyPem: key.private_key_pem,
    command:
      `printf '%s' '${b64}' | base64 -d > /tmp/newcoworker-byos-wipe.sh` +
      ` && chmod +x /tmp/newcoworker-byos-wipe.sh && bash /tmp/newcoworker-byos-wipe.sh`,
    timeoutMs: 10 * 60 * 1000
  });
  if (!result.stdout.includes(BYOS_WIPE_DONE_MARKER)) {
    throw new Error(
      `wipeByosBox: wipe on ${input.vpsHost} did not complete (exit ${result.exitCode}): ` +
        `${(result.stderr || result.stdout || "<no output>").slice(-500)}`
    );
  }
  logger.info("BYOS box wiped", { businessId: input.businessId, host: input.vpsHost });
}
