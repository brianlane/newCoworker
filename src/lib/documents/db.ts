/**
 * Business Documents knowledge library — DB access.
 *
 * `business_documents` holds owner-uploaded documents (price sheets,
 * policies, contracts, SOPs) with the agent-facing extracted markdown
 * (`content_md`); `business_document_shares` holds tokenized, revocable
 * share links; `document_signature_requests` holds e-sign requests with
 * their audit trail. All tables are service-role-only (RLS on, no policies)
 * — every access flows through the Next.js server after its own auth
 * checks, matching the customer_profiles / vps_ssh_keys posture.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type BusinessDocumentAudience = "clients" | "staff" | "both";
export type BusinessDocumentStatus = "processing" | "ready" | "failed";

export type BusinessDocumentRow = {
  id: string;
  business_id: string;
  title: string;
  category: string;
  audience: BusinessDocumentAudience;
  storage_path: string;
  mime_type: string;
  byte_size: number;
  content_md: string;
  summary: string;
  status: BusinessDocumentStatus;
  error_detail: string | null;
  expires_at: string | null;
  expiring_soon_notified_at: string | null;
  expired_notified_at: string | null;
  /** Contact this document belongs to (policy holder / tenant / member). Null = plain library doc. */
  contact_id: string | null;
  /** Renewal due date — keeps the doc active, unlike expires_at which retires it. */
  renewal_date: string | null;
  /** Roster member (ai_flow_team_members) who handles the renewal. */
  assigned_employee_id: string | null;
  /** One-reminder-per-state stamp for the ~30-day heads-up; reset when renewal_date changes. */
  renewal_due_notified_at: string | null;
  /** One-reminder-per-state stamp for the ~7-day final reminder; reset when renewal_date changes. */
  renewal_final_notified_at: string | null;
  /** One-reminder-per-state stamp for the past-due notice; reset when renewal_date changes. */
  renewal_overdue_notified_at: string | null;
  /** When this renewal fired its document_renewal outreach flow event; reset when renewal_date changes. */
  renewal_outreach_enqueued_at: string | null;
  created_at: string;
  updated_at: string;
};

export type BusinessDocumentShareRow = {
  id: string;
  business_id: string;
  document_id: string;
  token_sha256: string;
  shared_with: string;
  channel: string;
  expires_at: string;
  revoked_at: string | null;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
};

export async function listBusinessDocuments(
  businessId: string,
  client?: SupabaseClient
): Promise<BusinessDocumentRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_documents")
    .select()
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listBusinessDocuments: ${error.message}`);
  return (data ?? []) as BusinessDocumentRow[];
}

export async function getBusinessDocument(
  businessId: string,
  documentId: string,
  client?: SupabaseClient
): Promise<BusinessDocumentRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_documents")
    .select()
    .eq("business_id", businessId)
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw new Error(`getBusinessDocument: ${error.message}`);
  return (data as BusinessDocumentRow | null) ?? null;
}

/**
 * Count documents for cap enforcement. `scope` separates the two caps:
 * "library" counts unlinked knowledge-library docs (the per-tier cap),
 * "contact_records" counts contact-linked records (the flat generous cap) —
 * see CONTACT_DOCUMENT_RECORDS_LIMIT in core.ts.
 */
export async function countBusinessDocuments(
  businessId: string,
  scope: "library" | "contact_records" = "library",
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const base = db
    .from("business_documents")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId);
  const query =
    scope === "contact_records" ? base.not("contact_id", "is", null) : base.is("contact_id", null);
  const { count, error } = await query;
  if (error) throw new Error(`countBusinessDocuments: ${error.message}`);
  return count ?? 0;
}

/** Documents linked to one contact (their policies / contracts / records). */
export async function listBusinessDocumentsForContact(
  businessId: string,
  contactId: string,
  client?: SupabaseClient
): Promise<BusinessDocumentRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_documents")
    .select()
    .eq("business_id", businessId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listBusinessDocumentsForContact: ${error.message}`);
  return (data ?? []) as BusinessDocumentRow[];
}

export async function insertBusinessDocument(
  row: Pick<
    BusinessDocumentRow,
    "id" | "business_id" | "title" | "category" | "audience" | "storage_path" | "mime_type" | "byte_size"
  > &
    Partial<
      Pick<
        BusinessDocumentRow,
        | "content_md"
        | "summary"
        | "status"
        | "expires_at"
        | "contact_id"
        | "renewal_date"
        | "assigned_employee_id"
      >
    >,
  client?: SupabaseClient
): Promise<BusinessDocumentRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_documents")
    .insert({ ...row })
    .select()
    .single();
  if (error) throw new Error(`insertBusinessDocument: ${error.message}`);
  return data as BusinessDocumentRow;
}

export type BusinessDocumentPatch = Partial<
  Pick<
    BusinessDocumentRow,
    | "title"
    | "category"
    | "audience"
    | "content_md"
    | "summary"
    | "status"
    | "error_detail"
    | "expires_at"
    | "expiring_soon_notified_at"
    | "expired_notified_at"
    | "contact_id"
    | "renewal_date"
    | "assigned_employee_id"
    | "renewal_due_notified_at"
    | "renewal_final_notified_at"
    | "renewal_overdue_notified_at"
    | "renewal_outreach_enqueued_at"
  >
>;

export async function patchBusinessDocument(
  businessId: string,
  documentId: string,
  patch: BusinessDocumentPatch,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("business_documents")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", documentId);
  if (error) throw new Error(`patchBusinessDocument: ${error.message}`);
}

export async function deleteBusinessDocument(
  businessId: string,
  documentId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("business_documents")
    .delete()
    .eq("business_id", businessId)
    .eq("id", documentId);
  if (error) throw new Error(`deleteBusinessDocument: ${error.message}`);
}

export async function insertDocumentShare(
  row: Pick<
    BusinessDocumentShareRow,
    "id" | "business_id" | "document_id" | "token_sha256" | "shared_with" | "channel" | "expires_at"
  >,
  client?: SupabaseClient
): Promise<BusinessDocumentShareRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_document_shares")
    .insert({ ...row })
    .select()
    .single();
  if (error) throw new Error(`insertDocumentShare: ${error.message}`);
  return data as BusinessDocumentShareRow;
}

export async function getDocumentShareByTokenSha(
  tokenSha256: string,
  client?: SupabaseClient
): Promise<BusinessDocumentShareRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_document_shares")
    .select()
    .eq("token_sha256", tokenSha256)
    .maybeSingle();
  if (error) throw new Error(`getDocumentShareByTokenSha: ${error.message}`);
  return (data as BusinessDocumentShareRow | null) ?? null;
}

export async function listDocumentShares(
  businessId: string,
  documentId?: string,
  client?: SupabaseClient
): Promise<BusinessDocumentShareRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const base = db
    .from("business_document_shares")
    .select()
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  const query = documentId ? base.eq("document_id", documentId) : base;
  const { data, error } = await query;
  if (error) throw new Error(`listDocumentShares: ${error.message}`);
  return (data ?? []) as BusinessDocumentShareRow[];
}

/**
 * Revoke a share link. `documentId` (when given) scopes the revoke to that
 * document, so a caller acting on one document's panel can't kill another
 * document's link by id. Returns the number of rows revoked (0 = no match).
 */
export async function revokeDocumentShare(
  businessId: string,
  shareId: string,
  documentId?: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const base = db
    .from("business_document_shares")
    .update({ revoked_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", shareId);
  const query = documentId ? base.eq("document_id", documentId) : base;
  const { data, error } = await query.select("id");
  if (error) throw new Error(`revokeDocumentShare: ${error.message}`);
  return Array.isArray(data) ? data.length : 0;
}

export type DocumentSignatureRequestStatus = "sent" | "viewed" | "signed" | "void";

export type DocumentSignatureRequestRow = {
  id: string;
  business_id: string;
  document_id: string;
  token_sha256: string;
  signer_name: string;
  signer_email: string;
  signer_phone: string;
  message: string;
  status: DocumentSignatureRequestStatus;
  signature_name: string | null;
  signed_at: string | null;
  signer_ip: string | null;
  signer_user_agent: string | null;
  content_sha256: string | null;
  /** Snapshot of content_md at signing — what the certificate renders. */
  signed_content_md: string | null;
  expires_at: string;
  created_at: string;
};

export async function insertDocumentSignatureRequest(
  row: Pick<
    DocumentSignatureRequestRow,
    "id" | "business_id" | "document_id" | "token_sha256" | "signer_name" | "expires_at"
  > &
    Partial<Pick<DocumentSignatureRequestRow, "signer_email" | "signer_phone" | "message">>,
  client?: SupabaseClient
): Promise<DocumentSignatureRequestRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("document_signature_requests")
    .insert({ ...row })
    .select()
    .single();
  if (error) throw new Error(`insertDocumentSignatureRequest: ${error.message}`);
  return data as DocumentSignatureRequestRow;
}

export async function getDocumentSignatureRequestByTokenSha(
  tokenSha256: string,
  client?: SupabaseClient
): Promise<DocumentSignatureRequestRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("document_signature_requests")
    .select()
    .eq("token_sha256", tokenSha256)
    .maybeSingle();
  if (error) throw new Error(`getDocumentSignatureRequestByTokenSha: ${error.message}`);
  return (data as DocumentSignatureRequestRow | null) ?? null;
}

export async function listDocumentSignatureRequests(
  businessId: string,
  documentId?: string,
  client?: SupabaseClient
): Promise<DocumentSignatureRequestRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const base = db
    .from("document_signature_requests")
    .select()
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  const query = documentId ? base.eq("document_id", documentId) : base;
  const { data, error } = await query;
  if (error) throw new Error(`listDocumentSignatureRequests: ${error.message}`);
  return (data ?? []) as DocumentSignatureRequestRow[];
}

/**
 * First-open stamp: `sent → viewed`. Conditional on the current status so a
 * signed/void request is never regressed. Best-effort — the caller ignores
 * the outcome (a failed stamp must not block rendering the document).
 */
export async function markSignatureRequestViewed(
  requestId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("document_signature_requests")
    .update({ status: "viewed" })
    .eq("id", requestId)
    .eq("status", "sent");
  if (error) throw new Error(`markSignatureRequestViewed: ${error.message}`);
}

/**
 * The signing write. TOCTOU-safe: the update is conditional on the request
 * still being signable (`status in sent/viewed`), so a double-submit — or a
 * void racing the signer — loses cleanly. Returns the number of rows
 * updated (0 = lost the race / no longer signable).
 */
export async function completeSignatureRequest(
  requestId: string,
  fields: Pick<
    DocumentSignatureRequestRow,
    | "signature_name"
    | "signed_at"
    | "signer_ip"
    | "signer_user_agent"
    | "content_sha256"
    | "signed_content_md"
  >,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("document_signature_requests")
    .update({ ...fields, status: "signed" })
    .eq("id", requestId)
    .in("status", ["sent", "viewed"])
    .select("id");
  if (error) throw new Error(`completeSignatureRequest: ${error.message}`);
  return Array.isArray(data) ? data.length : 0;
}

/**
 * Owner-side void of an unsigned request (kills the link). `documentId`
 * (when given) scopes the void to that document, mirroring
 * revokeDocumentShare. Signed requests are immutable evidence and cannot be
 * voided. Returns the number of rows voided (0 = no signable match).
 */
export async function voidSignatureRequest(
  businessId: string,
  requestId: string,
  documentId?: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const base = db
    .from("document_signature_requests")
    .update({ status: "void" })
    .eq("business_id", businessId)
    .eq("id", requestId)
    .in("status", ["sent", "viewed"]);
  const query = documentId ? base.eq("document_id", documentId) : base;
  const { data, error } = await query.select("id");
  if (error) throw new Error(`voidSignatureRequest: ${error.message}`);
  return Array.isArray(data) ? data.length : 0;
}

/**
 * Void EVERY still-signable request for a document. Used as the first
 * phase of document deletion: after this sweep no request can transition
 * to signed (the signing write requires status in sent/viewed), which
 * closes the check-then-delete race against a concurrent signer. Returns
 * the number of rows voided.
 */
export async function voidAllSignatureRequestsForDocument(
  businessId: string,
  documentId: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("document_signature_requests")
    .update({ status: "void" })
    .eq("business_id", businessId)
    .eq("document_id", documentId)
    .in("status", ["sent", "viewed"])
    .select("id");
  if (error) throw new Error(`voidAllSignatureRequestsForDocument: ${error.message}`);
  return Array.isArray(data) ? data.length : 0;
}

/**
 * Best-effort access stamp on a successful public download. Read-side
 * telemetry only — failures must never block the file response, so the
 * caller fire-and-forgets this.
 */
export async function touchDocumentShareAccess(
  shareId: string,
  currentCount: number,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("business_document_shares")
    .update({
      access_count: currentCount + 1,
      last_accessed_at: new Date().toISOString()
    })
    .eq("id", shareId);
  if (error) throw new Error(`touchDocumentShareAccess: ${error.message}`);
}
