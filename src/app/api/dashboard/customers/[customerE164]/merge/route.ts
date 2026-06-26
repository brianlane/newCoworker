/**
 * Customer profile merge endpoint.
 *
 * POST /api/dashboard/customers/:e164/merge?businessId=<uuid>
 *        body: { intoE164: "+1..." }
 *        → { memory }   (the surviving, merged profile)
 *
 * Folds the path customer (the one being viewed) INTO the body customer:
 * concatenated summary/pinned notes, summed counters, earliest first-seen,
 * and the path number recorded in alias_e164s so future texts/calls from it
 * resolve to the surviving profile. The path row is deleted. Semantics live
 * in the merge_customer_memories RPC
 * (supabase/migrations/20260617000000_employees_and_customer_merge.sql).
 *
 * Auth: getAuthUser + requireOwner(businessId); admins bypass.
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { getCustomerMemory, mergeCustomerMemories } from "@/lib/customer-memory/db";

export const dynamic = "force-dynamic";

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 10 };

const E164 = /^\+[1-9]\d{6,15}$/;

const paramsSchema = z.object({
  customerE164: z.string().regex(E164)
});

const querySchema = z.object({ businessId: z.string().uuid() });

const bodySchema = z.object({
  intoE164: z.string().regex(E164, "Target must be an E.164 phone, e.g. +16025551234")
});

export async function POST(
  request: Request,
  ctx: { params: Promise<{ customerE164: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const raw = (await ctx.params).customerE164;
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    const { customerE164 } = paramsSchema.parse({ customerE164: decoded });

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireOwner(businessId);

    const limiter = rateLimit(`customer-merge:${businessId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many merges, slow down.", 429);
    }

    const body = bodySchema.parse(await request.json());

    if (body.intoE164 === customerE164) {
      return errorResponse("VALIDATION_ERROR", "Pick a different customer to merge into.");
    }

    // Friendly 404s before the RPC so the UI can distinguish "target number
    // isn't a known customer" from a server error.
    const target = await getCustomerMemory(businessId, body.intoE164);
    if (!target) {
      return errorResponse("NOT_FOUND", `No customer profile found for ${body.intoE164}`);
    }
    // The target lookup is alias-aware; if the typed number is an alias of
    // the SOURCE profile (already-merged number), the RPC would fold a row
    // into itself — reject explicitly.
    if (target.customer_e164 === customerE164) {
      return errorResponse("VALIDATION_ERROR", "That number already belongs to this customer.");
    }
    const source = await getCustomerMemory(businessId, customerE164);
    if (!source) {
      return errorResponse("NOT_FOUND", "Customer not found");
    }
    // Both lookups are alias-aware, so a path that is itself a merged ALIAS
    // can resolve to the same profile as the typed target (e.g. viewing an
    // alias URL and typing that profile's primary). The RPC would then fold
    // the row into itself and error — reject as validation instead.
    if (source.customer_e164 === target.customer_e164) {
      return errorResponse("VALIDATION_ERROR", "That number already belongs to this customer.");
    }
    // Merge is "same person, two numbers" and is irreversible. Refuse to fold a
    // non-customer directory row (company short code, vendor, tester,
    // owner/employee) in either direction — the UI hides the action for these,
    // this is the authoritative guard.
    if (source.type !== "customer" || target.type !== "customer") {
      return errorResponse(
        "VALIDATION_ERROR",
        "Only customer profiles can be merged. Re-tag the contact as a customer first."
      );
    }

    const memory = await mergeCustomerMemories(
      businessId,
      source.customer_e164,
      target.customer_e164
    );

    return successResponse({ memory });
  } catch (err) {
    return handleRouteError(err);
  }
}
