import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as nodeCrypto from "node:crypto";

const getDataBackupMock = vi.fn();
const upsertDataBackupMock = vi.fn();
const deleteDataBackupRowMock = vi.fn();

vi.mock("@/lib/db/data-backups", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/data-backups")>(
    "@/lib/db/data-backups"
  );
  return {
    ...actual,
    getDataBackup: (...args: unknown[]) => getDataBackupMock(...args),
    upsertDataBackup: (...args: unknown[]) => upsertDataBackupMock(...args),
    deleteDataBackupRow: (...args: unknown[]) => deleteDataBackupRowMock(...args)
  };
});

import {
  backupBusinessData,
  restoreBusinessData,
  deleteBusinessBackup,
  buildBackupStoragePath,
  DATA_BACKUP_BUCKET
} from "@/lib/hostinger/data-migration";
import type { VpsSshKeyRow } from "@/lib/db/vps-ssh-keys";

function makeSshKey(): VpsSshKeyRow {
  return {
    id: "k1",
    business_id: "biz-1",
    hostinger_vps_id: "42",
    hostinger_public_key_id: 9,
    public_key: "ssh-ed25519 AAA",
    private_key_pem: "PEM",
    fingerprint_sha256: "SHA256:abc",
    ssh_username: "root",
    created_at: "2026-01-01T00:00:00Z",
    rotated_at: null
  };
}

function fakeTarPayload(body: string): { stdout: string; bytes: Buffer; sha: string } {
  const bytes = Buffer.from(body, "utf8");
  const sha = nodeCrypto.createHash("sha256").update(bytes).digest("hex");
  const base64 = bytes.toString("base64");
  return {
    stdout: `${sha}  ${bytes.byteLength}  ${base64}\n`,
    bytes,
    sha
  };
}

function makeStorage() {
  const uploads: { path: string; body: Buffer; opts: unknown }[] = [];
  const downloads: { path: string; body: Buffer | null }[] = [];
  const removals: string[][] = [];
  let nextDownload: Buffer | null = null;
  const storage = {
    from(_bucket: string) {
      return {
        async upload(
          path: string,
          body: Buffer | ArrayBuffer | Uint8Array | Blob,
          opts?: unknown
        ) {
          const buf = Buffer.isBuffer(body) ? body : Buffer.from(body as ArrayBuffer);
          uploads.push({ path, body: buf, opts });
          return { data: { path }, error: null };
        },
        async download(path: string) {
          downloads.push({ path, body: nextDownload });
          if (!nextDownload) return { data: null, error: { message: "no body" } };
          const blob = new Blob([new Uint8Array(nextDownload)], { type: "application/gzip" });
          return { data: blob, error: null };
        },
        async remove(paths: string[]) {
          removals.push(paths);
          return { data: paths, error: null };
        }
      };
    }
  };
  return {
    storage,
    uploads,
    downloads,
    removals,
    setDownload(body: Buffer) {
      nextDownload = body;
    }
  };
}

function makeFailingStorage(kind: "upload" | "download" | "remove", error: unknown = { message: "storage failed" }) {
  return {
    from() {
      return {
        async upload() {
          return { data: null, error: kind === "upload" ? error : null };
        },
        async download() {
          return { data: null, error: kind === "download" ? error : null };
        },
        async remove() {
          return { data: null, error: kind === "remove" ? error : null };
        }
      };
    }
  };
}

describe("data-migration (backup)", () => {
  beforeEach(() => {
    getDataBackupMock.mockReset();
    upsertDataBackupMock.mockReset();
    deleteDataBackupRowMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("builds a deterministic storage path per business", () => {
    expect(buildBackupStoragePath("abc")).toBe("backups/abc/latest.tar.gz");
  });

  it("runs tar over SSH, verifies sha, uploads tarball, and upserts audit row", async () => {
    const { stdout, sha, bytes } = fakeTarPayload("tarball-body");
    const sshExecutor = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, signal: null, stdout, stderr: "" });
    const { storage, uploads } = makeStorage();
    upsertDataBackupMock.mockResolvedValue({
      business_id: "biz-1",
      storage_bucket: DATA_BACKUP_BUCKET,
      storage_path: buildBackupStoragePath("biz-1"),
      sha256: sha,
      size_bytes: bytes.byteLength,
      created_at: "now",
      updated_at: "now"
    });

    const result = await backupBusinessData(
      { businessId: "biz-1", vpsHost: "1.2.3.4" },
      {
        sshExecutor,
        storage,
        sshKeyLookup: async () => makeSshKey()
      }
    );

    expect(result).toEqual({
      storageBucket: DATA_BACKUP_BUCKET,
      storagePath: buildBackupStoragePath("biz-1"),
      sha256: sha,
      sizeBytes: bytes.byteLength
    });
    expect(sshExecutor).toHaveBeenCalledTimes(1);
    const cmd = sshExecutor.mock.calls[0][0].command as string;
    expect(cmd).toContain("tar -czf - 'vault' 'memory'");
    expect(cmd).toContain("sha256sum");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].path).toBe(buildBackupStoragePath("biz-1"));
    expect(Buffer.compare(uploads[0].body, bytes)).toBe(0);
    expect(upsertDataBackupMock).toHaveBeenCalledWith({
      businessId: "biz-1",
      storageBucket: DATA_BACKUP_BUCKET,
      storagePath: buildBackupStoragePath("biz-1"),
      sha256: sha,
      sizeBytes: bytes.byteLength
    });
  });

  it("throws on sha mismatch between remote-reported and local-recomputed digest", async () => {
    const sshExecutor = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: `deadbeef  3  ${Buffer.from("abc").toString("base64")}\n`,
      stderr: ""
    });
    const { storage } = makeStorage();

    await expect(
      backupBusinessData(
        { businessId: "biz-1", vpsHost: "1.2.3.4" },
        { sshExecutor, storage, sshKeyLookup: async () => makeSshKey() }
      )
    ).rejects.toThrow(/sha256 mismatch/);
  });

  it("throws when tar exits non-zero and exposes stderr", async () => {
    const sshExecutor = vi
      .fn()
      .mockResolvedValue({ exitCode: 2, signal: null, stdout: "", stderr: "disk full" });
    const { storage } = makeStorage();

    await expect(
      backupBusinessData(
        { businessId: "biz-1", vpsHost: "1.2.3.4" },
        { sshExecutor, storage, sshKeyLookup: async () => makeSshKey() }
      )
    ).rejects.toThrow(/tar exited 2.*disk full/);
  });

  it("throws when no SSH key is recorded for the business", async () => {
    const sshExecutor = vi.fn();
    const { storage } = makeStorage();
    await expect(
      backupBusinessData(
        { businessId: "biz-none", vpsHost: "1.2.3.4" },
        { sshExecutor, storage, sshKeyLookup: async () => null }
      )
    ).rejects.toThrow(/no SSH key/);
  });

  it("throws on malformed tar output, invalid sizes, size mismatch, and upload errors", async () => {
    const { storage } = makeStorage();
    await expect(
      backupBusinessData(
        { businessId: "biz-1", vpsHost: "1.2.3.4" },
        {
          storage,
          sshKeyLookup: async () => makeSshKey(),
          sshExecutor: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "bad-output", stderr: "" })
        }
      )
    ).rejects.toThrow(/unexpected tar output/);

    await expect(
      backupBusinessData(
        { businessId: "biz-1", vpsHost: "1.2.3.4" },
        {
          storage,
          sshKeyLookup: async () => makeSshKey(),
          sshExecutor: vi.fn().mockResolvedValue({
            exitCode: 0,
            stdout: `${"00".repeat(32)}  nope  ${Buffer.from("abc").toString("base64")}`,
            stderr: ""
          })
        }
      )
    ).rejects.toThrow(/invalid size/);

    const body = Buffer.from("abc");
    const sha = nodeCrypto.createHash("sha256").update(body).digest("hex");
    await expect(
      backupBusinessData(
        { businessId: "biz-1", vpsHost: "1.2.3.4" },
        {
          storage,
          sshKeyLookup: async () => makeSshKey(),
          sshExecutor: vi.fn().mockResolvedValue({
            exitCode: 0,
            stdout: `${sha}  999  ${body.toString("base64")}`,
            stderr: ""
          })
        }
      )
    ).rejects.toThrow(/size mismatch/);

    await expect(
      backupBusinessData(
        { businessId: "biz-1", vpsHost: "1.2.3.4" },
        {
          storage: makeFailingStorage("upload"),
          sshKeyLookup: async () => makeSshKey(),
          sshExecutor: vi.fn().mockResolvedValue({
            exitCode: 0,
            stdout: `${sha}  ${body.byteLength}  ${body.toString("base64")}`,
            stderr: ""
          })
        }
      )
    ).rejects.toThrow(/storage upload failed/);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      backupBusinessData(
        { businessId: "biz-1", vpsHost: "1.2.3.4" },
        {
          storage: makeFailingStorage("upload", circular),
          sshKeyLookup: async () => makeSshKey(),
          sshExecutor: vi.fn().mockResolvedValue({
            exitCode: 0,
            stdout: `${sha}  ${body.byteLength}  ${body.toString("base64")}`,
            stderr: ""
          })
        }
      )
    ).rejects.toThrow(/storage upload failed/);
  });
});

describe("data-migration (restore)", () => {
  beforeEach(() => {
    getDataBackupMock.mockReset();
    upsertDataBackupMock.mockReset();
    deleteDataBackupRowMock.mockReset();
  });

  it("downloads tarball, verifies sha, runs untar command, returns metadata", async () => {
    const body = Buffer.from("some-restore-body");
    const sha = nodeCrypto.createHash("sha256").update(body).digest("hex");
    const { storage, setDownload } = makeStorage();
    setDownload(body);
    getDataBackupMock.mockResolvedValue({
      business_id: "biz-1",
      storage_bucket: DATA_BACKUP_BUCKET,
      storage_path: buildBackupStoragePath("biz-1"),
      sha256: sha,
      size_bytes: body.byteLength,
      created_at: "now",
      updated_at: "now"
    });

    const sshExecutor = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, signal: null, stdout: "", stderr: "" });

    const result = await restoreBusinessData(
      { businessId: "biz-1", vpsHost: "4.3.2.1" },
      { storage, sshExecutor, sshKeyLookup: async () => makeSshKey() }
    );

    expect(result).toEqual({
      storagePath: buildBackupStoragePath("biz-1"),
      sha256: sha,
      sizeBytes: body.byteLength
    });
    expect(sshExecutor).toHaveBeenCalledTimes(1);
    const cmd = sshExecutor.mock.calls[0][0].command as string;
    expect(cmd).toContain("base64 -d");
    expect(cmd).toContain("tar -xzf /tmp/ncb-restore.tar.gz -C /opt/rowboat");
    expect(cmd).toContain(sha);
  });

  it("fails when no backup row exists", async () => {
    getDataBackupMock.mockResolvedValue(null);
    const { storage } = makeStorage();
    await expect(
      restoreBusinessData(
        { businessId: "biz-nope", vpsHost: "4.3.2.1" },
        { storage, sshExecutor: vi.fn(), sshKeyLookup: async () => makeSshKey() }
      )
    ).rejects.toThrow(/no backup recorded/);
  });

  it("fails when downloaded sha doesn't match the audit row", async () => {
    const body = Buffer.from("good");
    const { storage, setDownload } = makeStorage();
    setDownload(body);
    getDataBackupMock.mockResolvedValue({
      business_id: "biz-1",
      storage_bucket: DATA_BACKUP_BUCKET,
      storage_path: buildBackupStoragePath("biz-1"),
      sha256: "00".repeat(32),
      size_bytes: body.byteLength,
      created_at: "now",
      updated_at: "now"
    });
    await expect(
      restoreBusinessData(
        { businessId: "biz-1", vpsHost: "4.3.2.1" },
        { storage, sshExecutor: vi.fn(), sshKeyLookup: async () => makeSshKey() }
      )
    ).rejects.toThrow(/downloaded sha256 mismatch/);
  });

  it("fails when no SSH key, download fails, or remote untar exits non-zero", async () => {
    const body = Buffer.from("restore");
    const sha = nodeCrypto.createHash("sha256").update(body).digest("hex");
    getDataBackupMock.mockResolvedValue({
      business_id: "biz-1",
      storage_bucket: DATA_BACKUP_BUCKET,
      storage_path: buildBackupStoragePath("biz-1"),
      sha256: sha,
      size_bytes: body.byteLength,
      created_at: "now",
      updated_at: "now"
    });

    const { storage, setDownload } = makeStorage();
    setDownload(body);
    await expect(
      restoreBusinessData(
        { businessId: "biz-1", vpsHost: "4.3.2.1" },
        { storage, sshExecutor: vi.fn(), sshKeyLookup: async () => null }
      )
    ).rejects.toThrow(/no SSH key/);

    await expect(
      restoreBusinessData(
        { businessId: "biz-1", vpsHost: "4.3.2.1" },
        { storage: makeFailingStorage("download"), sshExecutor: vi.fn(), sshKeyLookup: async () => makeSshKey() }
      )
    ).rejects.toThrow(/storage download failed/);

    await expect(
      restoreBusinessData(
        { businessId: "biz-1", vpsHost: "4.3.2.1", sshKey: makeSshKey(), username: "ubuntu" },
        {
          storage,
          sshExecutor: vi.fn().mockResolvedValue({ exitCode: 66, stdout: "", stderr: "sha mismatch" }),
          sshKeyLookup: async () => {
            throw new Error("should not lookup");
          }
        }
      )
    ).rejects.toThrow(/untar exited 66.*sha mismatch/);
  });
});

describe("data-migration (delete)", () => {
  beforeEach(() => {
    getDataBackupMock.mockReset();
    upsertDataBackupMock.mockReset();
    deleteDataBackupRowMock.mockReset();
  });

  it("removes storage object and deletes audit row", async () => {
    const { storage, removals } = makeStorage();
    getDataBackupMock.mockResolvedValue({
      business_id: "biz-1",
      storage_bucket: DATA_BACKUP_BUCKET,
      storage_path: buildBackupStoragePath("biz-1"),
      sha256: "x",
      size_bytes: 1,
      created_at: "now",
      updated_at: "now"
    });

    await deleteBusinessBackup("biz-1", { storage });
    expect(removals).toEqual([[buildBackupStoragePath("biz-1")]]);
    expect(deleteDataBackupRowMock).toHaveBeenCalledWith("biz-1");
  });

  it("noops when there is no backup row", async () => {
    const { storage, removals } = makeStorage();
    getDataBackupMock.mockResolvedValue(null);
    await deleteBusinessBackup("biz-2", { storage });
    expect(removals).toEqual([]);
    expect(deleteDataBackupRowMock).not.toHaveBeenCalled();
  });

  it("throws and keeps audit row when storage removal fails", async () => {
    getDataBackupMock.mockResolvedValue({
      business_id: "biz-1",
      storage_bucket: DATA_BACKUP_BUCKET,
      storage_path: buildBackupStoragePath("biz-1"),
      sha256: "x",
      size_bytes: 1,
      created_at: "now",
      updated_at: "now"
    });

    await expect(deleteBusinessBackup("biz-1", { storage: makeFailingStorage("remove") })).rejects.toThrow(
      /storage remove failed/
    );
    expect(deleteDataBackupRowMock).not.toHaveBeenCalled();
  });
});
