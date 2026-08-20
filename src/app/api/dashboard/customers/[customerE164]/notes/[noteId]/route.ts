/**
 * Manage one contact note.
 *
 * PATCH  /api/dashboard/customers/:key/notes/:noteId?businessId=<uuid>
 *          body: { body: "…" } → { note: { id } }
 * DELETE /api/dashboard/customers/:key/notes/:noteId?businessId=<uuid>
 *          → { ok: true }   (soft delete; idempotent)
 *
 * Ownership: a note is edited and deleted by its AUTHOR only
 * (author_user_id must match the session user; the DB write repeats the
 * filter so the check is race-safe), with one widening: the business owner
 * (role "owner", the businesses.owner_email login) and the platform admin
 * may delete anyone's note. Nobody edits someone else's words.
 *
 * Auth: getAuthUser + requireBusinessRole(businessId, "operate_messages"),
 * same bar as the contact page; admins bypass.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { getCustomerMemory } from "@/lib/customer-memory/db";
import { getBusinessRoleForEmail } from "@/lib/db/business-members";
import { NOTE_BODY_MAX, validateNoteBody } from "@/lib/notes/core";
import {
  getContactNote,
  softDeleteContactNote,
  updateOwnContactNote
} from "@/lib/notes/db";
import { classifyContactKey } from "../../../../../../../../supabase/functions/_shared/contact_key";

export const dynamic = "force-dynamic";

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 30 };

const paramsSchema = z.object({
  customerE164: z.string().refine((v) => classifyContactKey(v) !== null, {
    message: "Not a contact key"
  }),
  noteId: z.string().uuid()
});

const querySchema = z.object({ businessId: z.string().uuid() });

const patchBodySchema = z.object({ body: z.string().max(NOTE_BODY_MAX * 2) });

function decodePathParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

type Ctx = { params: Promise<{ customerE164: string; noteId: string }> };

/** Shared auth + resolution: session, businessId, contact row, note id. */
async function authorize(request: Request, params: Ctx["params"]) {
  const user = await getAuthUser();
  if (!user) return { error: errorResponse("UNAUTHORIZED", "Authentication required") };

  const rawParams = await params;
  const { customerE164, noteId } = paramsSchema.parse({
    customerE164: decodePathParam(rawParams.customerE164),
    noteId: rawParams.noteId
  });
  const url = new URL(request.url);
  const { businessId } = querySchema.parse({
    businessId: url.searchParams.get("businessId") ?? ""
  });

  if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

  const limiter = rateLimit(`contact-notes-write:${businessId}:${user.userId}`, WRITE_RATE);
  if (!limiter.success) {
    return { error: errorResponse("CONFLICT", "Too many edits, slow down.", 429) };
  }

  const memory = await getCustomerMemory(businessId, customerE164);
  if (!memory) return { error: errorResponse("NOT_FOUND", "Customer not found") };

  return { user, businessId, contactId: memory.id, noteId };
}

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const auth = await authorize(request, params);
    if ("error" in auth) return auth.error;

    const raw = patchBodySchema.parse(await request.json());
    const body = validateNoteBody(raw.body);
    if (!body.ok) return errorResponse("VALIDATION_ERROR", body.error);

    // Read first so "not yours" answers 403 rather than a misleading 404;
    // the update below still repeats the author filter, so a race cannot
    // widen the check.
    const note = await getContactNote(auth.businessId, auth.contactId, auth.noteId);
    if (!note || note.deleted_at) return errorResponse("NOT_FOUND", "Note not found");
    if (note.author_user_id !== auth.user.userId) {
      return errorResponse("FORBIDDEN", "Only the note's author can edit it");
    }

    const updated = await updateOwnContactNote(
      auth.businessId,
      auth.contactId,
      auth.noteId,
      auth.user.userId,
      body.body
    );
    // Zero rows: the note vanished (or was soft-deleted) between the read
    // and the conditional write.
    if (updated === 0) return errorResponse("NOT_FOUND", "Note not found");

    return successResponse({ note: { id: auth.noteId } });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const auth = await authorize(request, params);
    if ("error" in auth) return auth.error;

    const note = await getContactNote(auth.businessId, auth.contactId, auth.noteId);
    // Idempotent: a repeated delete of a gone/already-deleted note succeeds,
    // matching the customer-profile delete semantics.
    if (!note || note.deleted_at) return successResponse({ ok: true });

    const isAuthor = note.author_user_id === auth.user.userId;
    if (!isAuthor) {
      // The owner (and the platform admin) may clear anyone's note; other
      // roles only their own. Resolved by the caller's real login email,
      // the same identity requireBusinessRole admitted above.
      const role = auth.user.isAdmin
        ? "owner"
        : auth.user.email
          ? await getBusinessRoleForEmail(auth.businessId, auth.user.email)
          : null;
      if (role !== "owner") {
        return errorResponse("FORBIDDEN", "Only the note's author or the business owner can delete it");
      }
    }

    await softDeleteContactNote(
      auth.businessId,
      auth.contactId,
      auth.noteId,
      // Authors delete through the author filter (race-safe even if the
      // read above went stale); the owner/admin path deletes by id alone.
      isAuthor ? { authorUserId: auth.user.userId } : {}
    );

    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
