/**
 * Contact notes, collection endpoint.
 *
 * GET  /api/dashboard/customers/:key/notes?businessId=<uuid>
 *        → { notes }   (newest first, soft-deleted excluded)
 * POST /api/dashboard/customers/:key/notes?businessId=<uuid>
 *        body: { body: "…" } → { note }
 *
 * The path segment is the contact KEY (E.164, short code, or `email:` key),
 * resolved alias-aware to the contacts row exactly like the profile page;
 * notes are stored against that row's id. The author is stamped from the
 * session (`author_user_id`) with a display-name snapshot (`author_label`:
 * roster name, else login email) so the note keeps naming its writer after
 * roster or account churn.
 *
 * Auth: getAuthUser + requireBusinessRole(businessId, "operate_messages"),
 * same bar as the contact page itself; admins bypass.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { getCustomerMemory } from "@/lib/customer-memory/db";
import { resolveCallerEmployeeId } from "@/lib/db/caller-employee";
import { getTeamMember } from "@/lib/db/employees";
import { NOTE_BODY_MAX, noteAuthorLabel, validateNoteBody } from "@/lib/notes/core";
import { createContactNote, listContactNotes } from "@/lib/notes/db";
import { classifyContactKey } from "../../../../../../../supabase/functions/_shared/contact_key";

export const dynamic = "force-dynamic";

const READ_RATE = { interval: 60 * 1000, maxRequests: 60 };
const WRITE_RATE = { interval: 60 * 1000, maxRequests: 30 };

const paramsSchema = z.object({
  customerE164: z.string().refine((v) => classifyContactKey(v) !== null, {
    message: "Not a contact key"
  })
});

const querySchema = z.object({ businessId: z.string().uuid() });

// The trim/length rules live in validateNoteBody (shared with the edit
// route); the schema only bounds the raw payload so an oversized body is
// refused before any work happens.
const postBodySchema = z.object({ body: z.string().max(NOTE_BODY_MAX * 2) });

function decodePathParam(raw: string): string {
  // Next decodes path segments once; if upstream double-encodes, the second
  // decode throws, so guard.
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

type Ctx = { params: Promise<{ customerE164: string }> };

export async function GET(request: Request, ctx: Ctx) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const decoded = decodePathParam((await ctx.params).customerE164);
    const { customerE164 } = paramsSchema.parse({ customerE164: decoded });
    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const limiter = rateLimit(`contact-notes-read:${businessId}:${user.userId}`, READ_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const memory = await getCustomerMemory(businessId, customerE164);
    if (!memory) return errorResponse("NOT_FOUND", "Customer not found");

    const notes = await listContactNotes(businessId, memory.id);
    return successResponse({ notes });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request, ctx: Ctx) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const decoded = decodePathParam((await ctx.params).customerE164);
    const { customerE164 } = paramsSchema.parse({ customerE164: decoded });
    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const limiter = rateLimit(`contact-notes-write:${businessId}:${user.userId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many edits, slow down.", 429);
    }

    const raw = postBodySchema.parse(await request.json());
    const body = validateNoteBody(raw.body);
    if (!body.ok) return errorResponse("VALIDATION_ERROR", body.error);

    // Alias-aware: a merged-away number resolves to the surviving profile,
    // so the note lands on the row the page actually shows.
    const memory = await getCustomerMemory(businessId, customerE164);
    if (!memory) return errorResponse("NOT_FOUND", "Customer not found");

    // Display-name snapshot: the caller's roster name when their login is
    // linked (or they are the owner with a roster row), else their email.
    // Best-effort; a roster read failure falls back to the email label.
    const employeeId = await resolveCallerEmployeeId(businessId, user.email);
    const member = employeeId
      ? await getTeamMember(businessId, employeeId).catch(() => null)
      : null;
    const authorLabel = noteAuthorLabel(member?.name ?? null, user.email);

    const note = await createContactNote({
      business_id: businessId,
      contact_id: memory.id,
      author_user_id: user.userId,
      author_label: authorLabel,
      body: body.body
    });

    return successResponse({ note });
  } catch (err) {
    return handleRouteError(err);
  }
}
