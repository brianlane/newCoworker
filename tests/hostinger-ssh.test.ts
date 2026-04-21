import { describe, expect, it, vi } from "vitest";
import { sshExec } from "@/lib/hostinger/ssh";
import type { SshClientLike, SshStreamLike } from "@/lib/hostinger/ssh";
import { EventEmitter } from "events";

// Minimal fake ssh2 Client: drives `ready`/`error`/`close` on EventEmitter
// and `exec`'s stream on another EventEmitter.
class FakeStream extends EventEmitter {
  stderr = new EventEmitter();
}

type FakeClientOpts = {
  onReady?: (stream: FakeStream, client: FakeClient) => void;
  onError?: Error;
  connectError?: Error;
  execError?: Error;
  /** Expected host key — if provided, we call the hostVerifier with it. */
  hostKeyBlob?: Buffer;
  /** Return value the verifier should receive (for testing strict mode failures). */
};

class FakeClient extends EventEmitter implements SshClientLike {
  lastConnectCfg: Record<string, unknown> | null = null;

  constructor(public opts: FakeClientOpts = {}) {
    super();
  }

  connect(cfg: Record<string, unknown>): this {
    this.lastConnectCfg = cfg;
    queueMicrotask(() => {
      // Optional hostVerifier check
      if (this.opts.hostKeyBlob && typeof cfg.hostVerifier === "function") {
        const ok = (cfg.hostVerifier as (key: Buffer) => boolean)(this.opts.hostKeyBlob);
        if (!ok) {
          this.emit("error", new Error("Host key verification failed"));
          return;
        }
      }
      if (this.opts.connectError) {
        this.emit("error", this.opts.connectError);
        return;
      }
      this.emit("ready");
    });
    return this;
  }

  exec(_cmd: string, cb: (err: Error | undefined, stream: SshStreamLike) => void): this {
    if (this.opts.execError) {
      queueMicrotask(() => cb(this.opts.execError, undefined as unknown as SshStreamLike));
      return this;
    }
    const stream = new FakeStream();
    queueMicrotask(() => {
      cb(undefined, stream as unknown as SshStreamLike);
      if (this.opts.onReady) this.opts.onReady(stream, this);
    });
    return this;
  }

  end(): this {
    this.emit("end");
    this.emit("close");
    return this;
  }
}

describe("sshExec", () => {
  it("resolves with collected stdout/stderr + exitCode on clean exit", async () => {
    const client = new FakeClient({
      onReady: (stream) => {
        stream.emit("data", Buffer.from("hello "));
        stream.emit("data", "world\n");
        stream.stderr.emit("data", Buffer.from("warn\n"));
        stream.emit("close", 0, null);
      }
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const res = await sshExec(
      {
        host: "1.2.3.4",
        username: "root",
        privateKeyPem: "PEM",
        command: "echo hi",
        onStdout: (c) => stdoutChunks.push(c),
        onStderr: (c) => stderrChunks.push(c)
      },
      { clientFactory: () => client }
    );
    expect(res.exitCode).toBe(0);
    expect(res.signal).toBeNull();
    expect(res.stdout).toBe("hello world\n");
    expect(res.stderr).toBe("warn\n");
    expect(stdoutChunks.join("")).toBe("hello world\n");
    expect(stderrChunks.join("")).toBe("warn\n");
    expect(client.lastConnectCfg?.host).toBe("1.2.3.4");
    expect(client.lastConnectCfg?.username).toBe("root");
    expect(client.lastConnectCfg?.privateKey).toBe("PEM");
  });

  it("non-zero exit code still resolves (does not throw)", async () => {
    const client = new FakeClient({
      onReady: (stream) => {
        stream.emit("data", "fail");
        stream.emit("close", 2, null);
      }
    });
    const res = await sshExec(
      { host: "h", username: "u", privateKeyPem: "P", command: "false" },
      { clientFactory: () => client }
    );
    expect(res.exitCode).toBe(2);
  });

  it("normalises signal-killed processes to exitCode 128 when code is null", async () => {
    const client = new FakeClient({
      onReady: (stream) => {
        stream.emit("close", null, "SIGTERM");
      }
    });
    const res = await sshExec(
      { host: "h", username: "u", privateKeyPem: "P", command: "sleep 999" },
      { clientFactory: () => client }
    );
    expect(res.exitCode).toBe(128);
    expect(res.signal).toBe("SIGTERM");
  });

  it("defaults exitCode to 1 when both code and signal are null", async () => {
    const client = new FakeClient({
      onReady: (stream) => {
        stream.emit("close", null, null);
      }
    });
    const res = await sshExec(
      { host: "h", username: "u", privateKeyPem: "P", command: "echo" },
      { clientFactory: () => client }
    );
    expect(res.exitCode).toBe(1);
    expect(res.signal).toBeNull();
  });

  it("rejects when the connection errors", async () => {
    const client = new FakeClient({ connectError: new Error("ECONNREFUSED") });
    await expect(
      sshExec(
        { host: "h", username: "u", privateKeyPem: "P", command: "x" },
        { clientFactory: () => client }
      )
    ).rejects.toThrow(/connection error.*ECONNREFUSED/);
  });

  it("rejects when exec fails", async () => {
    const client = new FakeClient({ execError: new Error("no shell") });
    await expect(
      sshExec(
        { host: "h", username: "u", privateKeyPem: "P", command: "x" },
        { clientFactory: () => client }
      )
    ).rejects.toThrow(/exec failed.*no shell/);
  });

  it("rejects with timeout when the command exceeds timeoutMs", async () => {
    const client = new FakeClient({
      // Never emit close — let the timer fire.
      onReady: () => {}
    });
    await expect(
      sshExec(
        {
          host: "h",
          username: "u",
          privateKeyPem: "P",
          command: "sleep",
          timeoutMs: 20
        },
        { clientFactory: () => client }
      )
    ).rejects.toThrow(/overall timeout/);
  });

  it("strict host-key policy: rejects when the fingerprint does not match", async () => {
    const client = new FakeClient({
      hostKeyBlob: Buffer.from("host-key-bytes")
    });
    await expect(
      sshExec(
        {
          host: "h",
          username: "u",
          privateKeyPem: "P",
          command: "x",
          hostKeyPolicy: "strict",
          expectedHostKeyFingerprint: "SHA256:wrong"
        },
        { clientFactory: () => client }
      )
    ).rejects.toThrow(/Host key verification failed/);
  });

  it("strict host-key policy: requires expectedHostKeyFingerprint", async () => {
    await expect(
      sshExec(
        {
          host: "h",
          username: "u",
          privateKeyPem: "P",
          command: "x",
          hostKeyPolicy: "strict"
        },
        { clientFactory: () => new FakeClient() }
      )
    ).rejects.toThrow(/expectedHostKeyFingerprint/);
  });

  it("strict host-key policy: accepts when fingerprint matches", async () => {
    const blob = Buffer.from("host-key-bytes-strict-ok");
    const crypto = await import("node:crypto");
    const expected =
      "SHA256:" +
      crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
    const client = new FakeClient({
      hostKeyBlob: blob,
      onReady: (stream) => stream.emit("close", 0, null)
    });
    const res = await sshExec(
      {
        host: "h",
        username: "u",
        privateKeyPem: "P",
        command: "x",
        hostKeyPolicy: "strict",
        expectedHostKeyFingerprint: expected
      },
      { clientFactory: () => client }
    );
    expect(res.exitCode).toBe(0);
  });

  it("handles string (not Buffer) stderr chunks via the typeof fallback", async () => {
    const client = new FakeClient({
      onReady: (stream) => {
        stream.emit("data", "stdout-string");
        stream.stderr.emit("data", "stderr-string");
        stream.emit("close", 0, null);
      }
    });
    const res = await sshExec(
      { host: "h", username: "u", privateKeyPem: "P", command: "x" },
      { clientFactory: () => client }
    );
    expect(res.stdout).toBe("stdout-string");
    expect(res.stderr).toBe("stderr-string");
  });

  it("strict host-key policy: accepts when the host key is provided as a base64 string", async () => {
    const blob = Buffer.from("string-host-key-bytes");
    const asBase64 = blob.toString("base64");
    const crypto = await import("node:crypto");
    const expected =
      "SHA256:" +
      crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
    // Our FakeClient calls hostVerifier with `hostKeyBlob` as Buffer; we wrap
    // it in a stub that forwards the base64 string instead to exercise the
    // `typeof key === "string"` branch of the verifier.
    const client = new FakeClient({
      onReady: (stream) => stream.emit("close", 0, null)
    });
    const origConnect = client.connect.bind(client);
    client.connect = (cfg) => {
      queueMicrotask(() => {
        if (typeof cfg.hostVerifier === "function") {
          const ok = (cfg.hostVerifier as (key: Buffer | string) => boolean)(asBase64);
          if (!ok) {
            client.emit("error", new Error("Host key verification failed"));
            return;
          }
        }
        client.emit("ready");
      });
      return client;
    };
    void origConnect;
    const res = await sshExec(
      {
        host: "h",
        username: "u",
        privateKeyPem: "P",
        command: "x",
        hostKeyPolicy: "strict",
        expectedHostKeyFingerprint: expected
      },
      { clientFactory: () => client }
    );
    expect(res.exitCode).toBe(0);
  });

  it("overall timer is cleared on successful completion (no leaked timers)", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const client = new FakeClient({
      onReady: (stream) => stream.emit("close", 0, null)
    });
    await sshExec(
      { host: "h", username: "u", privateKeyPem: "P", command: "x" },
      { clientFactory: () => client }
    );
    expect(clearTimeoutSpy).toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });
});
