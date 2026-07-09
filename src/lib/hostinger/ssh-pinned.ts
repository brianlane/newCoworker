/**
 * SSH host-key pinning layer (security review G7).
 *
 * Policy: TOFU at provision, strict forever after.
 *
 *   - Key row has NO `host_key_fingerprint` → connect with accept-any,
 *     CAPTURE the presented host key's SHA-256 fingerprint during the
 *     handshake, and persist it (best-effort) after the command ran. The
 *     unpinned window is the first connection to a freshly (re)imaged box,
 *     where the fleet previously lived permanently.
 *   - Key row HAS a fingerprint → connect with `hostKeyPolicy: "strict"`;
 *     a mismatch aborts the handshake and surfaces as
 *     {@link HostKeyMismatchError} naming the remediation.
 *
 * The pin lives on the `vps_ssh_keys` row, so every flow that re-images a
 * box under a NEW row (fresh provision, OVH rebuild-then-insert) starts
 * unpinned automatically; flows that re-image under an EXISTING row clear
 * the pin explicitly (adopt/recreate, BYOS placement changes).
 */

import { sshExec, type SshExecOptions, type SshExecResult } from "@/lib/hostinger/ssh";
import { updateVpsSshKeyHostKeyFingerprint } from "@/lib/db/vps-ssh-keys";
import { logger } from "@/lib/logger";

/** The subset of a vps_ssh_keys row the pinning layer needs. */
export type HostKeyPinnable = {
  id: string;
  host_key_fingerprint?: string | null;
};

export class HostKeyMismatchError extends Error {
  constructor(host: string, expected: string, presented: string) {
    super(
      `SSH host key mismatch for ${host}: pinned ${expected}, box presented ${presented}. ` +
        "If the box was legitimately re-imaged, clear the pin (updateVpsSshKeyHostKeyFingerprint(id, null) " +
        "or re-provision, which mints a fresh unpinned key row); otherwise treat as a possible MITM and investigate."
    );
    this.name = "HostKeyMismatchError";
  }
}

export type SshExecPinnedDeps = {
  /** Injectable executor (tests). Defaults to {@link sshExec}. */
  exec?: typeof sshExec;
  /** Injectable fingerprint persistence (tests). */
  persistFingerprint?: typeof updateVpsSshKeyHostKeyFingerprint;
};

/**
 * Run one SSH command with host-key pinning derived from the tenant's key
 * row. Same contract as {@link sshExec} otherwise (resolves with the exit
 * code, rejects on connection failure).
 */
export async function sshExecPinned(
  keyRow: HostKeyPinnable,
  opts: SshExecOptions,
  deps: SshExecPinnedDeps = {}
): Promise<SshExecResult> {
  /* c8 ignore next 2 -- production defaults; tests inject both */
  const exec = deps.exec ?? sshExec;
  const persistFingerprint = deps.persistFingerprint ?? updateVpsSshKeyHostKeyFingerprint;

  const pinned = keyRow.host_key_fingerprint ?? null;
  let captured: string | null = null;
  const capture = (fp: string) => {
    captured = fp;
  };

  if (pinned) {
    try {
      return await exec({
        ...opts,
        hostKeyPolicy: "strict",
        expectedHostKeyFingerprint: pinned,
        onHostKey: capture
      });
    } catch (err) {
      // ssh2 surfaces a hostVerifier rejection as a handshake/connection
      // error. When we captured a fingerprint and it differs from the pin,
      // we KNOW it was the verifier — translate into the typed error with
      // remediation instead of a generic "connection error".
      if (captured !== null && captured !== pinned) {
        throw new HostKeyMismatchError(opts.host, pinned, captured);
      }
      throw err;
    }
  }

  // First connect for this key row: accept, capture, persist.
  const result = await exec({ ...opts, onHostKey: capture });
  if (captured !== null) {
    // Update the caller's row object in place so SUBSEQUENT calls in the
    // same flow (e.g. the orchestrator's deploy right after its bootstrap)
    // verify strictly without a re-read.
    keyRow.host_key_fingerprint = captured;
    try {
      await persistFingerprint(keyRow.id, captured);
    } catch (err) {
      // Best-effort: a failed persist just means the NEXT connection is
      // also TOFU — log it so a persistent write failure is visible.
      logger.warn("host-key fingerprint persist failed (next connect stays TOFU)", {
        sshKeyId: keyRow.id,
        host: opts.host,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return result;
}
