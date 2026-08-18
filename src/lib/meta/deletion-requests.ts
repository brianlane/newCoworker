/**
 * The ledger behind Meta's Data Deletion Request callback.
 *
 * Meta requires the callback to hand back an alphanumeric confirmation code
 * plus a URL where the person can read, in plain language, what happened to
 * their request. That means the request has to outlive the HTTP call, which
 * is what meta_data_deletion_requests is for.
 *
 * The table deliberately holds no personal data beyond the app-scoped id:
 * see the migration comment for why the tenant's own CRM is out of scope.
 */
import { randomBytes } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type MetaDeletionRequestStatus = "completed" | "no_data" | "failed";

export type MetaDeletionRequestRow = {
  id: string;
  confirmation_code: string;
  meta_user_id: string;
  connections_cleared: number;
  status: MetaDeletionRequestStatus;
  detail: string | null;
  requested_at: string;
  completed_at: string | null;
};

/**
 * Unambiguous alphanumeric code. No 0/O/1/I/L: people read this off a screen
 * and quote it back to support, and Meta shows it in their own UI.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 12;

export function generateConfirmationCode(): string {
  // rejection-free: 31 symbols read from a 256-value byte would bias the
  // early letters, so draw a byte per character and reject the tail.
  const out: string[] = [];
  while (out.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      if (out.length >= CODE_LENGTH) break;
      const limit = 256 - (256 % CODE_ALPHABET.length);
      if (byte >= limit) continue;
      out.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]);
    }
  }
  return out.join("");
}

export async function insertMetaDeletionRequest(
  input: {
    confirmationCode: string;
    metaUserId: string;
    connectionsCleared: number;
    status: MetaDeletionRequestStatus;
    detail?: string | null;
  },
  client?: SupabaseClient
): Promise<MetaDeletionRequestRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("meta_data_deletion_requests")
    .insert({
      confirmation_code: input.confirmationCode,
      meta_user_id: input.metaUserId,
      connections_cleared: input.connectionsCleared,
      status: input.status,
      detail: input.detail ?? null,
      completed_at: new Date().toISOString()
    })
    .select()
    .single();
  if (error) throw new Error(`insertMetaDeletionRequest: ${error.message}`);
  return data as MetaDeletionRequestRow;
}

/** Look up one request by the code the person was given. */
export async function getMetaDeletionRequestByCode(
  confirmationCode: string,
  client?: SupabaseClient
): Promise<MetaDeletionRequestRow | null> {
  const code = confirmationCode.trim().toUpperCase();
  // An empty code must not return "some row"; refuse the lookup outright.
  if (!code) return null;
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("meta_data_deletion_requests")
    .select()
    .eq("confirmation_code", code)
    .maybeSingle();
  if (error) throw new Error(`getMetaDeletionRequestByCode: ${error.message}`);
  return (data as MetaDeletionRequestRow | null) ?? null;
}
