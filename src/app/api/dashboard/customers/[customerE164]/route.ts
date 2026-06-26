/**
 * Per-customer cross-channel detail endpoint (Phase 4).
 *
 * GET    /api/dashboard/customers/:e164?businessId=<uuid>
 *          → { memory, smsHistory, voiceTurnCount }
 *
 * PATCH  /api/dashboard/customers/:e164?businessId=<uuid>
 *          body: { displayName?, pinnedMd? }
 *          → { ok: true }
 *
 * DELETE /api/dashboard/customers/:e164?businessId=<uuid>
 *          → { ok: true }
 *
 * Auth: getAuthUser + requireOwner(businessId). Admins may bypass the
 * ownership check, matching the rest of the dashboard API. The
 * cascade-on-business-delete is enforced by the FK in
 * supabase/migrations/20260507000000_customer_memories.sql; this
 * route is the per-row delete affordance the customers page calls
 * when the owner removes someone explicitly.
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  deleteCustomerMemory,
  getCustomerMemory,
  listSmsHistoryForCustomer,
  updateCustomerOwnerFields
} from "@/lib/customer-memory/db";
import { CONTACT_TYPES } from "@/lib/customer-memory/types";

export const dynamic = "force-dynamic";

const READ_RATE = { interval: 60 * 1000, maxRequests: 60 };
const WRITE_RATE = { interval: 60 * 1000, maxRequests: 20 };

// E.164 or a bare 3-8 digit short code — service/lead-source contacts (folded
// from the old overrides) are keyed by short codes and must be viewable too.
const paramsSchema = z.object({
  customerE164: z.string().regex(/^(\+[1-9]\d{6,15}|\d{3,8})$/)
});

const querySchema = z.object({
  businessId: z.string().uuid()
});

const patchBodySchema = z
  .object({
    displayName: z.string().trim().max(120).nullable().optional(),
    pinnedMd: z.string().trim().max(2000).nullable().optional(),
    email: z.string().trim().email("Enter a valid email").max(254).nullable().optional(),
    type: z.enum(CONTACT_TYPES).optional()
  })
  .refine(
    (b) =>
      b.displayName !== undefined ||
      b.pinnedMd !== undefined ||
      b.email !== undefined ||
      b.type !== undefined,
    { message: "Provide at least one of displayName, pinnedMd, email, type" }
  );

async function decodePathParam(raw: string): Promise<string> {
  // Next decodes path segments once; if upstream double-encodes the
  // second decode throws, so guard.
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ customerE164: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const raw = (await ctx.params).customerE164;
    const decoded = await decodePathParam(raw);
    const { customerE164 } = paramsSchema.parse({ customerE164: decoded });

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireOwner(businessId);

    const limiter = rateLimit(`customer-detail:${businessId}:${customerE164}`, READ_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const memory = await getCustomerMemory(businessId, customerE164);
    if (!memory) return errorResponse("NOT_FOUND", "Customer not found");

    const smsHistory = await listSmsHistoryForCustomer(businessId, customerE164, { limit: 50 });

    return successResponse({
      memory: {
        customerE164: memory.customer_e164,
        type: memory.type,
        displayName: memory.display_name,
        email: memory.email,
        summaryMd: memory.summary_md,
        pinnedMd: memory.pinned_md,
        interactionCount: memory.interaction_count,
        totalInteractionCount: memory.total_interaction_count,
        lastInteractionAt: memory.last_interaction_at,
        lastSummarizedAt: memory.last_summarized_at,
        lastChannel: memory.last_channel,
        createdAt: memory.created_at,
        updatedAt: memory.updated_at
      },
      smsHistory
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ customerE164: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const raw = (await ctx.params).customerE164;
    const decoded = await decodePathParam(raw);
    const { customerE164 } = paramsSchema.parse({ customerE164: decoded });

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireOwner(businessId);

    const limiter = rateLimit(`customer-write:${businessId}:${customerE164}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many edits, slow down.", 429);
    }

    const body = patchBodySchema.parse(await request.json());

    // Make sure the row exists before letting the owner edit it. The
    // alternative (silent update of zero rows) would let the UI think
    // a save succeeded after the row was deleted from another tab.
    const existing = await getCustomerMemory(businessId, customerE164);
    if (!existing) return errorResponse("NOT_FOUND", "Customer not found");

    await updateCustomerOwnerFields(businessId, customerE164, {
      // An owner editing the name here is a deliberate label → stamp it 'manual'
      // so it wins over the derived owner/employee overlay (name resolver).
      ...(body.displayName !== undefined
        ? { displayName: body.displayName, nameSource: "manual" as const }
        : {}),
      ...(body.pinnedMd !== undefined ? { pinnedMd: body.pinnedMd } : {}),
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.type !== undefined ? { type: body.type } : {})
    });

    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ customerE164: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const raw = (await ctx.params).customerE164;
    const decoded = await decodePathParam(raw);
    const { customerE164 } = paramsSchema.parse({ customerE164: decoded });

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireOwner(businessId);

    const limiter = rateLimit(`customer-delete:${businessId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many deletes, slow down.", 429);
    }

    // Delete-if-exists semantics: 204 even if the row is already gone
    // (idempotent retries from a flaky network shouldn't 404). The
    // SMS/voice history rows are NOT cascaded — those are facts about
    // what was sent/said, retained for the channel-specific dashboards.
    // Only the rollup memory is removed.
    await deleteCustomerMemory(businessId, customerE164);
    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
