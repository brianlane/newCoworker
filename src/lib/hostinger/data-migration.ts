/**
 * SSH-based backup/restore of durable tenant data to Supabase Storage.
 *
 * Used by the lifecycle engine in two places:
 *   * cancel-grace — snapshot + tarball before we tear the VM down so the
 *     user's content survives the 30-day data-retention window; restored
 *     on reactivation during grace.
 *   * change-plan — same tarball primitive, restored into the freshly-
 *     provisioned VM at the new tier before we cut the Cloudflare tunnel
 *     over.
 *
 * Why SSH tar and not Hostinger snapshots as the durable artefact?
 * Hostinger snapshots are attached to the VM and destroyed when the VM is
 * destroyed via `cancelBillingSubscription` (see plan blocker B1). To
 * survive cancellation we need an off-VPS artefact, and Supabase Storage
 * is the cheapest durable option already in our stack.
 *
 * Durable directories (must match `vps/scripts/deploy-client.sh`):
 *   * /opt/rowboat/vault   — soul.md, identity.md, memory.md, website.md
 *   * /opt/rowboat/memory  — Organizations/, People/, Topics/, Projects/
 *                            plus `.newcoworker-seeds/` manifests
 *
 * Everything else (the Rowboat image, env files, tunnel credentials, etc.)
 * is re-derived by the deploy-client.sh run on the new VM, so we do NOT
 * back it up — keeping the tarball small and avoiding stale-config drift.
 */

import * as nodeCrypto from "node:crypto";
import { logger } from "@/lib/logger";
import { sshExec, type SshExecResult } from "@/lib/hostinger/ssh";
import { getActiveVpsSshKeyForBusiness, type VpsSshKeyRow } from "@/lib/db/vps-ssh-keys";
import {
  DATA_BACKUP_BUCKET,
  upsertDataBackup,
  getDataBackup,
  type DataBackupRow
} from "@/lib/db/data-backups";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * Absolute paths on the VPS that get tar'd up. We `tar -C /opt/rowboat`
 * these relative names so the archive extracts cleanly on any target VM
 * regardless of its hostname, and so `..` traversal is impossible.
 */
export const DURABLE_DATA_DIRS = ["vault", "memory"] as const;

/** Bucket the tarballs live in. Private — never exposed to tenant clients. */
export { DATA_BACKUP_BUCKET } from "@/lib/db/data-backups";

export type SshExecutor = (opts: {
  host: string;
  privateKeyPem: string;
  username: string;
  command: string;
}) => Promise<SshExecResult>;

export type StorageLike = {
  from(bucket: string): {
    upload(
      path: string,
      body: ArrayBuffer | Buffer | Blob | Uint8Array,
      options?: { upsert?: boolean; contentType?: string }
    ): Promise<{ data: unknown; error: unknown }>;
    download(path: string): Promise<{ data: Blob | null; error: unknown }>;
    remove(paths: string[]): Promise<{ data: unknown; error: unknown }>;
  };
};

export type BackupDeps = {
  sshExecutor?: SshExecutor;
  storage?: StorageLike;
  sshKeyLookup?: (businessId: string) => Promise<VpsSshKeyRow | null>;
};

export type BackupInput = {
  businessId: string;
  /** Public IPv4 of the VPS to read from. */
  vpsHost: string;
  /** Optional override SSH user (defaults to the key row's username, usually "root"). */
  username?: string;
};

export type BackupResult = {
  storageBucket: string;
  storagePath: string;
  sha256: string;
  sizeBytes: number;
};

export type RestoreInput = {
  businessId: string;
  /**
   * Target VPS host. For grace-period reactivation this is the same VM as
   * the backup; for change-plan it's the freshly-provisioned VM.
   */
  vpsHost: string;
  /**
   * Optional SSH key override. Useful during change-plan where the new VM
   * has a different keypair than the old one recorded under the business.
   */
  sshKey?: VpsSshKeyRow;
  username?: string;
};

export type RestoreResult = {
  storagePath: string;
  sha256: string;
  sizeBytes: number;
};

/**
 * Deterministic storage path per business: `backups/<businessId>/latest.tar.gz`.
 * One-per-business (matches the `data_backups` PK on business_id). We
 * deliberately don't timestamp — the lifecycle only ever needs the most
 * recent snapshot and overwriting keeps storage bounded.
 */
export function buildBackupStoragePath(businessId: string): string {
  return `backups/${businessId}/latest.tar.gz`;
}

function defaultSshExecutor(): SshExecutor {
  return async (opts) => {
    return sshExec({
      host: opts.host,
      username: opts.username,
      privateKeyPem: opts.privateKeyPem,
      command: opts.command
    });
  };
}

async function defaultStorage(): Promise<StorageLike> {
  const supa = await createSupabaseServiceClient();
  return supa.storage as unknown as StorageLike;
}

/**
 * Tar durable dirs on the VPS, read the archive over the SSH stream into
 * an in-memory Buffer, sha-256 verify via a second SSH call, then upload to
 * Supabase Storage. We use `tar -czf - … | base64` so we can reliably carry
 * the archive over the ssh2 stream (which is text/utf8 by default in our
 * wrapper) without reaching for scp/sftp. For tenants at KB-MB scale this
 * is fine; if we ever get a tenant whose archive pushes past tens of MBs
 * we'll switch this to sftp streaming.
 */
export async function backupBusinessData(
  input: BackupInput,
  deps: BackupDeps = {}
): Promise<BackupResult> {
  const sshExecutor = deps.sshExecutor ?? defaultSshExecutor();
  const storage = deps.storage ?? (await defaultStorage());
  const sshKeyLookup = deps.sshKeyLookup ?? getActiveVpsSshKeyForBusiness;

  const sshKey = await sshKeyLookup(input.businessId);
  if (!sshKey || !sshKey.private_key_pem) {
    throw new Error(`backupBusinessData: no SSH key for business ${input.businessId}`);
  }

  const username = input.username ?? sshKey.ssh_username ?? "root";
  const dirList = DURABLE_DATA_DIRS.map((d) => shellSingleQuote(d)).join(" ");

  // Emit a single line: "<sha256>  <size_bytes>  <base64-archive>". Putting
  // all three on one line keeps stdout parsing trivial and avoids a second
  // round-trip to fetch the sha separately.
  const tarCmd = [
    "set -euo pipefail",
    "cd /opt/rowboat",
    `for d in ${dirList}; do mkdir -p "$d"; done`,
    `archive=$(tar -czf - ${dirList} 2>/dev/null | base64 -w 0)`,
    `size=$(printf '%s' "$archive" | base64 -d | wc -c)`,
    `sha=$(printf '%s' "$archive" | base64 -d | sha256sum | awk '{print $1}')`,
    `printf '%s  %s  %s\\n' "$sha" "$size" "$archive"`
  ].join(" && ");

  const res = await sshExecutor({
    host: input.vpsHost,
    privateKeyPem: sshKey.private_key_pem,
    username,
    command: tarCmd
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `backupBusinessData: tar exited ${res.exitCode}${res.stderr ? `: ${res.stderr.slice(0, 400)}` : ""}`
    );
  }
  const trimmed = res.stdout.trim();
  const firstSpace = trimmed.indexOf("  ");
  const secondSpace = trimmed.indexOf("  ", firstSpace + 2);
  if (firstSpace < 0 || secondSpace < 0) {
    throw new Error("backupBusinessData: unexpected tar output (missing sha/size/body sections)");
  }
  const remoteSha = trimmed.slice(0, firstSpace);
  const sizeStr = trimmed.slice(firstSpace + 2, secondSpace);
  const base64Body = trimmed.slice(secondSpace + 2);
  const sizeBytes = Number(sizeStr);
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new Error(`backupBusinessData: invalid size "${sizeStr}"`);
  }
  const buffer = Buffer.from(base64Body, "base64");
  if (buffer.byteLength !== sizeBytes) {
    throw new Error(
      `backupBusinessData: size mismatch (header=${sizeBytes}, decoded=${buffer.byteLength})`
    );
  }
  const localSha = nodeCrypto.createHash("sha256").update(buffer).digest("hex");
  if (localSha !== remoteSha) {
    throw new Error(
      `backupBusinessData: sha256 mismatch (remote=${remoteSha}, local=${localSha})`
    );
  }

  const storagePath = buildBackupStoragePath(input.businessId);
  const { error: uploadErr } = await storage
    .from(DATA_BACKUP_BUCKET)
    .upload(storagePath, buffer, {
      upsert: true,
      contentType: "application/gzip"
    });
  if (uploadErr) {
    throw new Error(
      `backupBusinessData: storage upload failed: ${extractErrorMessage(uploadErr)}`
    );
  }

  await upsertDataBackup({
    businessId: input.businessId,
    storageBucket: DATA_BACKUP_BUCKET,
    storagePath,
    sha256: localSha,
    sizeBytes
  });

  logger.info("Data backup complete", {
    businessId: input.businessId,
    sha256: localSha,
    sizeBytes
  });

  return {
    storageBucket: DATA_BACKUP_BUCKET,
    storagePath,
    sha256: localSha,
    sizeBytes
  };
}

/**
 * Pull the latest backup tarball out of Supabase Storage, SSH it into the
 * target VPS, untar under /opt/rowboat, chown, and verify sha. Intentionally
 * the inverse of {@link backupBusinessData} so sha equality is the integrity
 * gate. Callers (change-plan, reactivate) are expected to kick the service
 * stack themselves (deploy-client.sh re-run / docker compose up) — this
 * function is a pure data restore, not a service-bring-up.
 */
export async function restoreBusinessData(
  input: RestoreInput,
  deps: BackupDeps = {}
): Promise<RestoreResult> {
  const sshExecutor = deps.sshExecutor ?? defaultSshExecutor();
  const storage = deps.storage ?? (await defaultStorage());
  const sshKeyLookup = deps.sshKeyLookup ?? getActiveVpsSshKeyForBusiness;

  const backupRow: DataBackupRow | null = await getDataBackup(input.businessId);
  if (!backupRow) {
    throw new Error(`restoreBusinessData: no backup recorded for ${input.businessId}`);
  }

  const sshKey = input.sshKey ?? (await sshKeyLookup(input.businessId));
  if (!sshKey || !sshKey.private_key_pem) {
    throw new Error(`restoreBusinessData: no SSH key for business ${input.businessId}`);
  }
  const username = input.username ?? sshKey.ssh_username ?? "root";

  const { data: blob, error: downloadErr } = await storage
    .from(backupRow.storage_bucket)
    .download(backupRow.storage_path);
  if (downloadErr || !blob) {
    throw new Error(
      `restoreBusinessData: storage download failed: ${extractErrorMessage(downloadErr) ?? "empty blob"}`
    );
  }
  const ab = await blob.arrayBuffer();
  const buffer = Buffer.from(ab);
  const localSha = nodeCrypto.createHash("sha256").update(buffer).digest("hex");
  if (localSha !== backupRow.sha256) {
    throw new Error(
      `restoreBusinessData: downloaded sha256 mismatch (expected=${backupRow.sha256}, got=${localSha})`
    );
  }

  const base64Body = buffer.toString("base64");
  // untar under /opt/rowboat, sha-verify the stream we received, then chown
  // so the Rowboat stack (running as root in our containers) and any non-
  // root operator can read the files. The one-shot command is executed via
  // the existing sshExec wrapper; it's big but fits well within ssh2's
  // default command-length limit.
  const untarCmd = [
    "set -euo pipefail",
    "mkdir -p /opt/rowboat",
    "cd /opt/rowboat",
    `printf '%s' ${shellSingleQuote(base64Body)} | base64 -d | tee /tmp/ncb-restore.tar.gz > /dev/null`,
    `remote_sha=$(sha256sum /tmp/ncb-restore.tar.gz | awk '{print $1}')`,
    `[ "$remote_sha" = ${shellSingleQuote(localSha)} ] || { echo "sha mismatch on remote: $remote_sha" >&2; exit 66; }`,
    "tar -xzf /tmp/ncb-restore.tar.gz -C /opt/rowboat",
    "rm -f /tmp/ncb-restore.tar.gz",
    "chown -R root:root /opt/rowboat/vault /opt/rowboat/memory 2>/dev/null || true"
  ].join(" && ");

  const res = await sshExecutor({
    host: input.vpsHost,
    privateKeyPem: sshKey.private_key_pem,
    username,
    command: untarCmd
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `restoreBusinessData: untar exited ${res.exitCode}${res.stderr ? `: ${res.stderr.slice(0, 400)}` : ""}`
    );
  }

  logger.info("Data restore complete", {
    businessId: input.businessId,
    sha256: localSha,
    sizeBytes: backupRow.size_bytes
  });

  return {
    storagePath: backupRow.storage_path,
    sha256: localSha,
    sizeBytes: backupRow.size_bytes
  };
}

/** Delete the backup artefact AND the audit row. Called by the grace sweep. */
export async function deleteBusinessBackup(
  businessId: string,
  deps: { storage?: StorageLike } = {}
): Promise<void> {
  const storage = deps.storage ?? (await defaultStorage());
  const backupRow = await getDataBackup(businessId);
  if (!backupRow) return;
  const { error } = await storage
    .from(backupRow.storage_bucket)
    .remove([backupRow.storage_path]);
  if (error) {
    logger.warn("deleteBusinessBackup: storage remove failed", {
      businessId,
      error: extractErrorMessage(error)
    });
    throw new Error(`deleteBusinessBackup: storage remove failed: ${extractErrorMessage(error)}`);
  }
  const { deleteDataBackupRow } = await import("@/lib/db/data-backups");
  await deleteDataBackupRow(businessId);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function extractErrorMessage(err: unknown): string | null {
  if (!err) return null;
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
