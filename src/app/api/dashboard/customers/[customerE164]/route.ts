/**
 * Per-customer cross-channel detail endpoint (Phase 4).
 *
 * GET    /api/dashboard/customers/:e164?businessId=<uuid>
 *          → { memory, smsHistory, voiceTurnCount }
 *
 * PATCH  /api/dashboard/customers/:e164?businessId=<uuid>
 *          body: { displayName?, pinnedMd?, email?, type?, smsReplyMode?,
 *                  tags?, ownerEmployeeId? }
 *          → { ok: true }
 *
 * DELETE /api/dashboard/customers/:e164?businessId=<uuid>
 *          → { ok: true }
 *
 * Auth: getAuthUser + requireBusinessRole(businessId, "operate_messages"). Admins may bypass the
 * ownership check, matching the rest of the dashboard API. The
 * cascade-on-business-delete is enforced by the FK in
 * supabase/migrations/20260507000000_customer_memories.sql; this
 * route is the per-row delete affordance the customers page calls
 * when the owner removes someone explicitly.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  deleteCustomerMemory,
  getCustomerMemory,
  listSmsHistoryForCustomer,
  setContactSmsReplyMode,
  updateCustomerOwnerFields
} from "@/lib/customer-memory/db";
import {
  CONTACT_TYPES,
  MAX_CONTACT_TAGS,
  MAX_CONTACT_TAG_LENGTH,
  SMS_REPLY_MODES,
  normalizeContactTags
} from "@/lib/customer-memory/types";
import { getTeamMember } from "@/lib/db/employees";
import { fireGoalEvent } from "@/lib/ai-flows/goal-hooks";
import { fireContactEvent } from "@/lib/ai-flows/contact-event-hooks";

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
    type: z.enum(CONTACT_TYPES).optional(),
    smsReplyMode: z.enum(SMS_REPLY_MODES).optional(),
    // Replace-the-set semantics; normalized (trim/de-dup/cap) before write.
    tags: z.array(z.string().max(MAX_CONTACT_TAG_LENGTH)).max(MAX_CONTACT_TAGS).optional(),
    // Assign (uuid, validated against the roster below) or clear (null).
    ownerEmployeeId: z.string().uuid().nullable().optional(),
    // Birth date ("YYYY-MM-DD") for the AiFlow birthday trigger; null clears.
    birthday: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
      .nullable()
      .optional()
  })
  .refine(
    (b) =>
      b.displayName !== undefined ||
      b.pinnedMd !== undefined ||
      b.email !== undefined ||
      b.type !== undefined ||
      b.smsReplyMode !== undefined ||
      b.tags !== undefined ||
      b.ownerEmployeeId !== undefined ||
      b.birthday !== undefined,
    {
      message:
        "Provide at least one of displayName, pinnedMd, email, type, smsReplyMode, tags, ownerEmployeeId, birthday"
    }
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

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

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
        smsReplyMode: memory.sms_reply_mode,
        displayName: memory.display_name,
        email: memory.email,
        summaryMd: memory.summary_md,
        pinnedMd: memory.pinned_md,
        interactionCount: memory.interaction_count,
        totalInteractionCount: memory.total_interaction_count,
        lastInteractionAt: memory.last_interaction_at,
        lastSummarizedAt: memory.last_summarized_at,
        lastChannel: memory.last_channel,
        tags: memory.tags,
        ownerEmployeeId: memory.owner_employee_id,
        birthday: memory.birthday,
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

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const limiter = rateLimit(`customer-write:${businessId}:${customerE164}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many edits, slow down.", 429);
    }

    const body = patchBodySchema.parse(await request.json());

    // Make sure the row exists before letting the owner edit it. The
    // alternative (silent update of zero rows) would let the UI think
    // a save succeeded after the row was deleted from another tab.
    // EXCEPTION: a reply-mode-only patch may target a number that has SMS
    // history but no contact row yet (the thread page offers the toggle for
    // any thread) — setContactSmsReplyMode creates the minimal row.
    const existing = await getCustomerMemory(businessId, customerE164);
    if (!existing) {
      const onlyReplyMode =
        body.smsReplyMode !== undefined &&
        body.displayName === undefined &&
        body.pinnedMd === undefined &&
        body.email === undefined &&
        body.type === undefined &&
        body.tags === undefined &&
        body.ownerEmployeeId === undefined &&
        body.birthday === undefined;
      if (!onlyReplyMode) return errorResponse("NOT_FOUND", "Customer not found");
      await setContactSmsReplyMode(businessId, customerE164, body.smsReplyMode!);
      return successResponse({ ok: true });
    }

    // An assigned owner must be one of THIS business's roster members (active
    // or not — deactivating someone shouldn't block re-labeling history, and
    // routing already skips inactive members).
    if (body.ownerEmployeeId) {
      const member = await getTeamMember(businessId, body.ownerEmployeeId);
      if (!member) {
        return errorResponse("VALIDATION_ERROR", "That employee is not on this business's roster");
      }
    }

    // The URL segment may be a merged-away ALIAS; getCustomerMemory resolved
    // it alias-aware to the surviving row. Write (and fire goal events)
    // against that row's PRIMARY number — updateCustomerOwnerFields filters
    // on customer_e164 only, so the alias spelling would update nothing
    // while events fired anyway.
    const canonicalE164 = existing.customer_e164;

    await updateCustomerOwnerFields(businessId, canonicalE164, {
      // A non-empty name the owner types is a deliberate label → 'manual' (wins
      // over the derived owner/employee overlay). CLEARING the name (null/empty)
      // resets provenance to 'auto' so a later auto-capture isn't mistaken for an
      // owner override on the now-nameless row (a manual stamp on "no name" would
      // make record_customer_interaction's fill look manual).
      ...(body.displayName !== undefined
        ? {
            displayName: body.displayName,
            nameSource: body.displayName ? ("manual" as const) : ("auto" as const)
          }
        : {}),
      ...(body.pinnedMd !== undefined ? { pinnedMd: body.pinnedMd } : {}),
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.smsReplyMode !== undefined ? { smsReplyMode: body.smsReplyMode } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      ...(body.ownerEmployeeId !== undefined ? { ownerEmployeeId: body.ownerEmployeeId } : {}),
      ...(body.birthday !== undefined ? { birthday: body.birthday } : {})
    });

    // Goal Events + tag_changed triggers: tags the edit ADDED or REMOVED (vs.
    // the pre-edit row) may fast-forward parked runs to a "tag added" goal
    // and/or start flows watching for the change. Diffed against the same
    // normalization the write used; best-effort inside both hooks, so a
    // trigger failure never fails the save.
    if (body.tags !== undefined) {
      // Both sides of the diff go through the SAME normalization the write
      // used — comparing raw stored tags would make a legacy spelling or
      // stray whitespace look "new" and fire a spurious event.
      const nextTags = normalizeContactTags(body.tags);
      const previousTags = normalizeContactTags(existing.tags ?? []);
      const before = new Set(previousTags.map((t) => t.toLowerCase()));
      const after = new Set(nextTags.map((t) => t.toLowerCase()));
      const eventStamp = Date.now();
      // Runs match goal events by the exact number they were triggered with,
      // which after a profile merge may be an ALIAS — fire for every linked
      // number so a parked run keyed on the old number still jumps.
      const goalNumbers = [canonicalE164, ...(existing.alias_e164s ?? [])];
      for (const tag of nextTags) {
        if (before.has(tag.toLowerCase())) continue;
        for (const number of goalNumbers) {
          await fireGoalEvent(businessId, number, { kind: "tag_added", tag });
        }
        await fireContactEvent(businessId, {
          kind: "tag_changed",
          contact: { e164: canonicalE164, tags: nextTags },
          tag,
          change: "added",
          dedupeKey: `ce:tag:${canonicalE164}:${tag.toLowerCase()}:added:${eventStamp}`
        });
      }
      for (const tag of previousTags) {
        if (after.has(tag.toLowerCase())) continue;
        await fireContactEvent(businessId, {
          kind: "tag_changed",
          contact: { e164: canonicalE164, tags: nextTags },
          tag,
          change: "removed",
          dedupeKey: `ce:tag:${canonicalE164}:${tag.toLowerCase()}:removed:${eventStamp}`
        });
      }
    }

    // owner_assigned triggers: a manual owner pick (not a clear) may start
    // flows — but only when the owner actually CHANGED to someone new.
    if (
      body.ownerEmployeeId !== undefined &&
      body.ownerEmployeeId !== null &&
      body.ownerEmployeeId !== existing.owner_employee_id
    ) {
      const member = await getTeamMember(businessId, body.ownerEmployeeId).catch(() => null);
      await fireContactEvent(businessId, {
        kind: "owner_assigned",
        contact: { e164: canonicalE164 },
        ...(member?.name ? { ownerName: member.name } : {}),
        dedupeKey: `ce:owner:${canonicalE164}:${body.ownerEmployeeId}:${Date.now()}`
      });
    }

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

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

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
