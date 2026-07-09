import { beforeEach, describe, expect, it, vi } from "vitest";

const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: loggerWarn, error: vi.fn() }
}));
vi.mock("@/lib/db/vps-ssh-keys", () => ({
  updateVpsSshKeyHostKeyFingerprint: vi.fn()
}));

import { HostKeyMismatchError, sshExecPinned } from "@/lib/hostinger/ssh-pinned";

const OK = { exitCode: 0, signal: null, stdout: "ok", stderr: "" };
const baseOpts = { host: "1.2.3.4", username: "root", privateKeyPem: "PEM", command: "true" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sshExecPinned — pinned row (strict)", () => {
  it("passes the pin through as strict policy and returns the result", async () => {
    const exec = vi.fn().mockResolvedValue(OK);
    const res = await sshExecPinned(
      { id: "k1", host_key_fingerprint: "SHA256:pinned" },
      baseOpts,
      { exec, persistFingerprint: vi.fn() }
    );
    expect(res).toBe(OK);
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({
        ...baseOpts,
        hostKeyPolicy: "strict",
        expectedHostKeyFingerprint: "SHA256:pinned"
      })
    );
  });

  it("translates a verifier rejection into HostKeyMismatchError naming both fingerprints", async () => {
    const exec = vi.fn(async (opts: { onHostKey?: (fp: string) => void }) => {
      opts.onHostKey?.("SHA256:presented-by-box");
      throw new Error("sshExec: connection error: Host key verification failed");
    });
    const persistFingerprint = vi.fn();
    await expect(
      sshExecPinned({ id: "k1", host_key_fingerprint: "SHA256:pinned" }, baseOpts, {
        exec: exec as never,
        persistFingerprint
      })
    ).rejects.toThrow(HostKeyMismatchError);
    await expect(
      sshExecPinned({ id: "k1", host_key_fingerprint: "SHA256:pinned" }, baseOpts, {
        exec: exec as never,
        persistFingerprint
      })
    ).rejects.toThrow(/pinned SHA256:pinned, box presented SHA256:presented-by-box/);
    expect(persistFingerprint).not.toHaveBeenCalled();
  });

  it("rethrows plain connection errors untranslated (no fingerprint captured)", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      sshExecPinned({ id: "k1", host_key_fingerprint: "SHA256:pinned" }, baseOpts, {
        exec,
        persistFingerprint: vi.fn()
      })
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("rethrows untranslated when the captured fingerprint MATCHES the pin (error was elsewhere)", async () => {
    const exec = vi.fn(async (opts: { onHostKey?: (fp: string) => void }) => {
      opts.onHostKey?.("SHA256:pinned");
      throw new Error("auth failed after handshake");
    });
    await expect(
      sshExecPinned({ id: "k1", host_key_fingerprint: "SHA256:pinned" }, baseOpts, {
        exec: exec as never,
        persistFingerprint: vi.fn()
      })
    ).rejects.toThrow("auth failed after handshake");
  });
});

describe("sshExecPinned — unpinned row (TOFU capture)", () => {
  it("captures, persists, and updates the row object in place", async () => {
    const exec = vi.fn(async (opts: { onHostKey?: (fp: string) => void }) => {
      opts.onHostKey?.("SHA256:first-connect");
      return OK;
    });
    const persistFingerprint = vi.fn().mockResolvedValue(undefined);
    const keyRow = { id: "k1", host_key_fingerprint: null };
    const res = await sshExecPinned(keyRow, baseOpts, {
      exec: exec as never,
      persistFingerprint
    });
    expect(res).toBe(OK);
    expect(exec).toHaveBeenCalledWith(
      expect.not.objectContaining({ hostKeyPolicy: "strict" })
    );
    expect(persistFingerprint).toHaveBeenCalledWith("k1", "SHA256:first-connect");
    // In-place update lets a same-flow second call go strict without a re-read.
    expect(keyRow.host_key_fingerprint).toBe("SHA256:first-connect");
  });

  it("goes strict on the second call after an in-place capture", async () => {
    const exec = vi.fn(async (opts: { onHostKey?: (fp: string) => void }) => {
      opts.onHostKey?.("SHA256:first-connect");
      return OK;
    });
    const keyRow = { id: "k1", host_key_fingerprint: null };
    const deps = { exec: exec as never, persistFingerprint: vi.fn() };
    await sshExecPinned(keyRow, baseOpts, deps);
    await sshExecPinned(keyRow, baseOpts, deps);
    expect(exec).toHaveBeenLastCalledWith(
      expect.objectContaining({
        hostKeyPolicy: "strict",
        expectedHostKeyFingerprint: "SHA256:first-connect"
      })
    );
  });

  it("a failed persist logs a warning but still returns the result", async () => {
    const exec = vi.fn(async (opts: { onHostKey?: (fp: string) => void }) => {
      opts.onHostKey?.("SHA256:first-connect");
      return OK;
    });
    const persistFingerprint = vi.fn().mockRejectedValue(new Error("db down"));
    const res = await sshExecPinned({ id: "k1", host_key_fingerprint: null }, baseOpts, {
      exec: exec as never,
      persistFingerprint
    });
    expect(res).toBe(OK);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("persist failed"),
      expect.objectContaining({ sshKeyId: "k1", error: "db down" })
    );
  });

  it("non-Error persist failures are stringified in the warning", async () => {
    const exec = vi.fn(async (opts: { onHostKey?: (fp: string) => void }) => {
      opts.onHostKey?.("SHA256:fp");
      return OK;
    });
    const persistFingerprint = vi.fn().mockRejectedValue("string-reason");
    await sshExecPinned({ id: "k1" }, baseOpts, {
      exec: exec as never,
      persistFingerprint
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("persist failed"),
      expect.objectContaining({ error: "string-reason" })
    );
  });

  it("no capture (executor never saw a host key) → nothing persisted", async () => {
    const exec = vi.fn().mockResolvedValue(OK);
    const persistFingerprint = vi.fn();
    const keyRow = { id: "k1" };
    const res = await sshExecPinned(keyRow, baseOpts, { exec, persistFingerprint });
    expect(res).toBe(OK);
    expect(persistFingerprint).not.toHaveBeenCalled();
    expect(keyRow).not.toHaveProperty("host_key_fingerprint");
  });
});
