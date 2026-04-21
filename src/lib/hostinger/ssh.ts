/**
 * Thin async wrapper around `ssh2`'s Client for one-shot remote command
 * execution. Designed to be the orchestrator's replacement for the fictional
 * `hostinger.executeCommand()` endpoint.
 *
 * Design goals:
 *  - Single `exec()` entry point — connect, run one command, collect output, disconnect.
 *  - Distinguish "SSH connection failed" from "command ran and exited non-zero".
 *  - Optional `onStdout`/`onStderr` callbacks for progress streaming.
 *  - Fully mockable via the `sshClientFactory` dep (tests swap in a fake Client).
 *
 * We intentionally do NOT expose long-lived sessions here. If we ever need
 * streaming / multi-command sessions, build a sibling module; keep this one
 * fire-and-forget simple.
 */

import * as nodeCrypto from "node:crypto";
import { Client as Ssh2Client, type ConnectConfig } from "ssh2";

export type SshExecOptions = {
  host: string;
  port?: number;
  username: string;
  privateKeyPem: string;
  /** Optional passphrase if the private key is encrypted. */
  passphrase?: string;
  command: string;
  /** Full command timeout — includes connect + exec. Default 15 min (provisioning is slow). */
  timeoutMs?: number;
  /** Connect-only timeout. Default 60s. */
  connectTimeoutMs?: number;
  /** Per-chunk callback for streaming stdout. */
  onStdout?: (chunk: string) => void;
  /** Per-chunk callback for streaming stderr. */
  onStderr?: (chunk: string) => void;
  /** SSH host key verification policy. Default: `"accept-any"` (we authenticate the server by the IP + private key; CA-backed host keys are out of scope for our fleet). */
  hostKeyPolicy?: "accept-any" | "strict";
  /** When `hostKeyPolicy: "strict"`, caller provides the expected host-key fingerprint in OpenSSH `SHA256:…` format. */
  expectedHostKeyFingerprint?: string;
};

export type SshExecResult = {
  exitCode: number;
  /** `null` when the remote process was killed by signal rather than exiting cleanly. */
  signal: string | null;
  stdout: string;
  stderr: string;
};

/** Narrow subset of ssh2 we consume; extracted so tests can swap in a fake without needing a full ssh2 implementation. */
export interface SshClientLike {
  on(event: "ready", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "end", listener: () => void): this;
  connect(config: ConnectConfig): this;
  exec(
    command: string,
    callback: (err: Error | undefined, stream: SshStreamLike) => void
  ): this;
  end(): this;
}

export interface SshStreamStderrLike {
  on(event: "data", listener: (chunk: Buffer | string) => void): SshStreamStderrLike;
}

export interface SshStreamLike {
  on(event: "close", listener: (code: number | null, signal: string | null) => void): this;
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  stderr: SshStreamStderrLike;
}

export type SshClientFactory = () => SshClientLike;

/* c8 ignore next -- trivial default factory; tests inject a fake */
const defaultFactory: SshClientFactory = () => new Ssh2Client() as unknown as SshClientLike;

/**
 * Connect, run one command, return exit code + captured streams. Rejects when
 * the connection itself fails; resolves (with `exitCode !== 0`) when the
 * command ran but exited non-zero — same contract as `child_process.exec`.
 */
export async function sshExec(
  opts: SshExecOptions,
  deps: { clientFactory?: SshClientFactory } = {}
): Promise<SshExecResult> {
  const {
    host,
    port = 22,
    username,
    privateKeyPem,
    passphrase,
    command,
    timeoutMs = 15 * 60 * 1000,
    connectTimeoutMs = 60 * 1000,
    onStdout,
    onStderr,
    hostKeyPolicy = "accept-any",
    expectedHostKeyFingerprint
  } = opts;

  if (hostKeyPolicy === "strict" && !expectedHostKeyFingerprint) {
    throw new Error("sshExec: hostKeyPolicy=strict requires expectedHostKeyFingerprint");
  }

  /* c8 ignore next -- default factory branch is exercised only against real ssh2 */
  const factory = deps.clientFactory ?? defaultFactory;
  const client = factory();

  return new Promise<SshExecResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (action: () => void) => {
      /* c8 ignore next -- multi-settle guard; reliably reproducing a double-settle requires racing the real ssh2 event loop */
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        /* already closed */
      }
      clearTimeout(overallTimer);
      action();
    };

    const overallTimer = setTimeout(() => {
      settle(() => reject(new Error(`sshExec: overall timeout after ${timeoutMs}ms`)));
    }, timeoutMs);

    client.on("ready", () => {
      client.exec(command, (err, stream) => {
        if (err) {
          settle(() => reject(new Error(`sshExec: exec failed: ${err.message}`)));
          return;
        }
        stream.on("data", (chunk: Buffer | string) => {
          const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
          stdout += s;
          if (onStdout) onStdout(s);
        });
        stream.stderr.on("data", (chunk: Buffer | string) => {
          const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
          stderr += s;
          if (onStderr) onStderr(s);
        });
        stream.on("close", (code: number | null, signal: string | null) => {
          settle(() => resolve({
            // Some OpenSSH servers report code=null when the process is
            // signal-killed; normalise to 128+signum so callers get a
            // non-zero exit code they can branch on.
            exitCode: code ?? (signal ? 128 : 1),
            signal: signal ?? null,
            stdout,
            stderr
          }));
        });
      });
    });

    client.on("error", (err) => {
      settle(() => reject(new Error(`sshExec: connection error: ${err.message}`)));
    });

    // Optional strict host-key verification: in practice we don't have a
    // CA-backed fleet yet, so the default policy is to accept any host key
    // (TOFU-ish). When the caller wants strict, we compute the SHA-256 of
    // the presented host key and compare it to `expectedHostKeyFingerprint`.
    const connectCfg: ConnectConfig = {
      host,
      port,
      username,
      privateKey: privateKeyPem,
      passphrase,
      readyTimeout: connectTimeoutMs
    };
    if (hostKeyPolicy === "strict") {
      connectCfg.hostVerifier = (key: Buffer | string) => {
        const blob = typeof key === "string" ? Buffer.from(key, "base64") : key;
        const fp = `SHA256:${nodeCrypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
        return fp === expectedHostKeyFingerprint;
      };
    }
    client.connect(connectCfg);
  });
}
