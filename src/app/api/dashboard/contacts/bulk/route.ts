/**
 * Bulk contact actions (customers page multi-select).
 *
 * POST /api/dashboard/contacts/bulk?businessId=<uuid>
 *        body: { action: "add_tag" | "remove_tag" | "assign_owner",
 *                contactKeys: string[] (1..200 contact keys),
 *                tag? (tag actions), employeeId? (assign_owner) }
 *          → { results: [{ key, ok, error? }], updated, failed }
 *
 * Auth: the EXACT gate the single-contact editor's save path uses
 * (getAuthUser + requireBusinessRole(businessId, "operate_messages"), admins
 * bypass; see /api/dashboard/customers/[customerE164]), so a bulk request
 * can do nothing a per-row edit cannot. All logic lives in
 * src/lib/contacts/bulk.ts; this route only checks shape and maps errors.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  BULK_MAX_CONTACTS,
  BulkContactError,
  applyBulkContactAction
} from "@/lib/contacts/bulk";
import { MAX_CONTACT_TAG_LENGTH } from "@/lib/customer-memory/types";
import { classifyContactKey } from "../../../../../../supabase/functions/_shared/contact_key";

export const dynamic = "force-dynamic";

// One request can write up to BULK_MAX_CONTACTS contacts, so the budget sits
// well under the per-contact editor's 20/min-per-contact allowance.
const WRITE_RATE = { interval: 60 * 1000, maxRequests: 10 };

const querySchema = z.object({ businessId: z.string().uuid() });

// Any contact KEY, same contract as the single-contact route: an E.164
// number, a bare short code, or an `email:` key.
const contactKeySchema = z.string().refine((v) => classifyContactKey(v) !== null, {
  message: "Not a contact key"
});

const contactKeysSchema = z.array(contactKeySchema).min(1).max(BULK_MAX_CONTACTS);

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add_tag"),
    contactKeys: contactKeysSchema,
    tag: z.string().trim().min(1).max(MAX_CONTACT_TAG_LENGTH)
  }),
  z.object({
    action: z.literal("remove_tag"),
    contactKeys: contactKeysSchema,
    tag: z.string().trim().min(1).max(MAX_CONTACT_TAG_LENGTH)
  }),
  z.object({
    action: z.literal("assign_owner"),
    contactKeys: contactKeysSchema,
    employeeId: z.string().uuid()
  })
]);

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const limiter = rateLimit(`contacts-bulk:${businessId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many bulk requests, slow down.", 429);
    }

    const body = bodySchema.parse(await request.json());
    const summary = await applyBulkContactAction(
      businessId,
      body.contactKeys,
      body.action === "assign_owner"
        ? { action: "assign_owner", employeeId: body.employeeId }
        : { action: body.action, tag: body.tag }
    );
    return successResponse(summary);
  } catch (err) {
    if (err instanceof BulkContactError) {
      return errorResponse("VALIDATION_ERROR", err.message);
    }
    return handleRouteError(err);
  }
}
