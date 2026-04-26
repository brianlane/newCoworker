import { beforeEach, describe, expect, it, vi } from "vitest";
import * as nodeCrypto from "node:crypto";

const sshExecMock = vi.hoisted(() => vi.fn());
const getActiveKeyMock = vi.hoisted(() => vi.fn());
const getDataBackupMock = vi.hoisted(() => vi.fn());
const upsertDataBackupMock = vi.hoisted(() => vi.fn());
const createSupabaseServiceClientMock = vi.hoisted(() => vi.fn());

describe("data-migration default dependencies", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/hostinger/ssh", () => ({
      sshExec: sshExecMock
    }));
    vi.doMock("@/lib/db/vps-ssh-keys", () => ({
      getActiveVpsSshKeyForBusiness: getActiveKeyMock
    }));
    vi.doMock("@/lib/db/data-backups", async () => {
      const actual = await vi.importActual<typeof import("@/lib/db/data-backups")>(
        "@/lib/db/data-backups"
      );
      return {
        ...actual,
        getDataBackup: getDataBackupMock,
        upsertDataBackup: upsertDataBackupMock
      };
    });
    vi.doMock("@/lib/supabase/server", () => ({
      createSupabaseServiceClient: createSupabaseServiceClientMock
    }));
  });

  it("uses default SSH, storage, and SSH-key dependencies for backup/restore/delete", async () => {
    const body = Buffer.from("archive");
    const sha = nodeCrypto.createHash("sha256").update(body).digest("hex");
    const storage = {
      from: vi.fn(() => ({
        upload: vi.fn().mockResolvedValue({ data: {}, error: null }),
        download: vi.fn().mockResolvedValue({
          data: new Blob([new Uint8Array(body)], { type: "application/gzip" }),
          error: null
        }),
        remove: vi.fn().mockResolvedValue({ data: {}, error: null })
      }))
    };
    createSupabaseServiceClientMock.mockResolvedValue({ storage });
    getActiveKeyMock.mockResolvedValue({
      private_key_pem: "PEM",
      ssh_username: null
    });
    sshExecMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: `${sha}  ${body.byteLength}  ${body.toString("base64")}\n`,
      stderr: ""
    });
    upsertDataBackupMock.mockResolvedValue({});
    getDataBackupMock
      .mockResolvedValueOnce({
        business_id: "biz-1",
        storage_bucket: "business-backups",
        storage_path: "backups/biz-1/latest.tar.gz",
        sha256: sha,
        size_bytes: body.byteLength,
        created_at: "now",
        updated_at: "now"
      })
      .mockResolvedValueOnce(null);

    const {
      backupBusinessData,
      restoreBusinessData,
      deleteBusinessBackup
    } = await import("@/lib/hostinger/data-migration");

    await expect(backupBusinessData({ businessId: "biz-1", vpsHost: "1.2.3.4" })).resolves.toEqual(
      expect.objectContaining({ sha256: sha, sizeBytes: body.byteLength })
    );
    expect(sshExecMock).toHaveBeenCalledWith(
      expect.objectContaining({ host: "1.2.3.4", username: "root" })
    );
    await expect(restoreBusinessData({ businessId: "biz-1", vpsHost: "1.2.3.5" })).resolves.toEqual(
      expect.objectContaining({ sha256: sha, sizeBytes: body.byteLength })
    );
    await expect(deleteBusinessBackup("biz-1")).resolves.toBeUndefined();
    expect(createSupabaseServiceClientMock).toHaveBeenCalled();
  });
});
