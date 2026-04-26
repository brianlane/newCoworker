/**
 * Audit/index of the most recent SSH-tarball backup per business. The
 * tarball itself lives in Supabase Storage (private bucket); this row lets
 * us locate and verify it during cancel-grace restore and change-plan
 * migration. Only one row per business — upsert overwrites on new backup.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export const DATA_BACKUP_BUCKET = "business-backups";

export type DataBackupRow = {
  business_id: string;
  storage_bucket: string;
  storage_path: string;
  sha256: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
};

export async function upsertDataBackup(
  input: {
    businessId: string;
    storageBucket?: string;
    storagePath: string;
    sha256: string;
    sizeBytes: number;
  },
  client?: SupabaseClient
): Promise<DataBackupRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("data_backups")
    .upsert(
      {
        business_id: input.businessId,
        storage_bucket: input.storageBucket ?? DATA_BACKUP_BUCKET,
        storage_path: input.storagePath,
        sha256: input.sha256,
        size_bytes: input.sizeBytes,
        updated_at: now
      },
      { onConflict: "business_id" }
    )
    .select()
    .single();
  if (error) throw new Error(`upsertDataBackup: ${error.message}`);
  return data as DataBackupRow;
}

export async function getDataBackup(
  businessId: string,
  client?: SupabaseClient
): Promise<DataBackupRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("data_backups")
    .select()
    .eq("business_id", businessId)
    .single();
  if (error) return null;
  return data as DataBackupRow;
}

export async function deleteDataBackupRow(
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("data_backups").delete().eq("business_id", businessId);
  if (error) throw new Error(`deleteDataBackupRow: ${error.message}`);
}
