/**
 * Contact notes, DB access.
 *
 * `contact_notes` holds authored, timestamped notes on a contact (see
 * `supabase/migrations/20260822212305_contact_notes.sql`). Service-role only
 * (RLS on, no policies): every access flows through the Next.js API after
 * its own auth checks, matching the business_documents posture. Ownership
 * rules (edit/delete own, owner deletes any) are enforced by the routes;
 * the writers here take the author filter as an explicit argument so the
 * database check and the route decision cannot drift apart.
 *
 * Every update/delete returns the matched row count: PostgREST reports no
 * error when a filter matches zero rows, so callers must check the count
 * instead of trusting the absence of an error.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ContactNoteRow = {
  id: string;
  business_id: string;
  /** Contact the note is about; null only after the contact row was deleted. */
  contact_id: string | null;
  /** Auth user who wrote it (no FK; may outlive the account). */
  author_user_id: string | null;
  /** Display-name snapshot at write time (roster name, else login email). */
  author_label: string;
  body: string;
  created_at: string;
  updated_at: string;
  /** Soft delete stamp; listed queries exclude non-null. */
  deleted_at: string | null;
};

/**
 * Cap on one contact's listed notes. Explicit so the query never leans on
 * PostgREST's silent 1000-row default; far above any realistic per-contact
 * volume.
 */
export const CONTACT_NOTES_LIST_LIMIT = 200;

/** Newest-first notes for one contact, excluding soft-deleted rows. */
export async function listContactNotes(
  businessId: string,
  contactId: string,
  client?: SupabaseClient
): Promise<ContactNoteRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("contact_notes")
    .select()
    .eq("business_id", businessId)
    .eq("contact_id", contactId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(CONTACT_NOTES_LIST_LIMIT);
  if (error) throw new Error(`listContactNotes: ${error.message}`);
  return (data ?? []) as ContactNoteRow[];
}

/** One note by id, scoped to its business + contact. Soft-deleted rows included (callers branch on deleted_at). */
export async function getContactNote(
  businessId: string,
  contactId: string,
  noteId: string,
  client?: SupabaseClient
): Promise<ContactNoteRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("contact_notes")
    .select()
    .eq("business_id", businessId)
    .eq("contact_id", contactId)
    .eq("id", noteId)
    .maybeSingle();
  if (error) throw new Error(`getContactNote: ${error.message}`);
  return (data as ContactNoteRow | null) ?? null;
}

export async function createContactNote(
  row: {
    business_id: string;
    contact_id: string;
    author_user_id: string | null;
    author_label: string;
    body: string;
  },
  client?: SupabaseClient
): Promise<ContactNoteRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("contact_notes")
    .insert({ ...row })
    .select()
    .single();
  if (error) throw new Error(`createContactNote: ${error.message}`);
  return data as ContactNoteRow;
}

/**
 * Edit a note's body, conditional on the caller BEING its author
 * (`author_user_id` filter, race-safe in the same statement) and the note
 * not being soft-deleted. Returns the matched row count: 0 = missing, not
 * yours, or already deleted; the route turns that into its 403/404.
 */
export async function updateOwnContactNote(
  businessId: string,
  contactId: string,
  noteId: string,
  authorUserId: string,
  body: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("contact_notes")
    .update({ body, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("contact_id", contactId)
    .eq("id", noteId)
    .eq("author_user_id", authorUserId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw new Error(`updateOwnContactNote: ${error.message}`);
  return Array.isArray(data) ? data.length : 0;
}

/**
 * Soft-delete a note. `authorUserId` (when given) restricts the delete to
 * the caller's own note in the same statement; the owner/admin path omits
 * it after the route's role check. Already-deleted rows never match
 * (`deleted_at is null`), so a repeat delete reports 0 and stays idempotent.
 * Returns the matched row count.
 */
export async function softDeleteContactNote(
  businessId: string,
  contactId: string,
  noteId: string,
  opts: { authorUserId?: string } = {},
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const base = db
    .from("contact_notes")
    .update({ deleted_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("contact_id", contactId)
    .eq("id", noteId)
    .is("deleted_at", null);
  const query = opts.authorUserId ? base.eq("author_user_id", opts.authorUserId) : base;
  const { data, error } = await query.select("id");
  if (error) throw new Error(`softDeleteContactNote: ${error.message}`);
  return Array.isArray(data) ? data.length : 0;
}

/**
 * Re-point every note (soft-deleted included, they are still this person's
 * history) from one contact to another: the profile-merge path, mirroring
 * how merge_customer_memories re-points business_documents. Returns the
 * moved note ids so a failed merge can move exactly those rows back
 * ({@link repointContactNoteIds}) without touching notes the target already
 * had.
 *
 * Deliberately does NOT bump `updated_at`: that stamp means "the author
 * edited the body" (the panel renders an "(edited)" marker off it), and a
 * merge changes where the note hangs, not what it says.
 */
export async function repointContactNotes(
  businessId: string,
  fromContactId: string,
  toContactId: string,
  client?: SupabaseClient
): Promise<string[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("contact_notes")
    .update({ contact_id: toContactId })
    .eq("business_id", businessId)
    .eq("contact_id", fromContactId)
    .select("id");
  if (error) throw new Error(`repointContactNotes: ${error.message}`);
  return Array.isArray(data) ? (data as { id: string }[]).map((r) => r.id) : [];
}

/**
 * Move a specific set of notes onto `toContactId`: the compensation half of
 * {@link repointContactNotes} when the merge RPC fails after the re-point.
 * Id-scoped so it can never drag along notes that always belonged to the
 * other profile. No-op on an empty id list. Like the forward re-point, it
 * leaves `updated_at` alone: moving a note is not editing it.
 */
export async function repointContactNoteIds(
  businessId: string,
  noteIds: string[],
  toContactId: string,
  client?: SupabaseClient
): Promise<void> {
  if (noteIds.length === 0) return;
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("contact_notes")
    .update({ contact_id: toContactId })
    .eq("business_id", businessId)
    .in("id", noteIds);
  if (error) throw new Error(`repointContactNoteIds: ${error.message}`);
}

/**
 * Hard-delete every note for a contact (soft-deleted included): the
 * profile-delete path. Without this, the FK's ON DELETE SET NULL would
 * leave unreachable orphan rows behind (the same reason the delete route
 * cleans up contact-linked documents). Returns how many rows were removed.
 */
export async function deleteNotesForContact(
  businessId: string,
  contactId: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("contact_notes")
    .delete()
    .eq("business_id", businessId)
    .eq("contact_id", contactId)
    .select("id");
  if (error) throw new Error(`deleteNotesForContact: ${error.message}`);
  return Array.isArray(data) ? data.length : 0;
}
