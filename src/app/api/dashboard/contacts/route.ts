/**
 * Owner-set contact name overrides.
 *
 * POST   /api/dashboard/contacts?businessId=<uuid>  body: { e164, name }
 * DELETE /api/dashboard/contacts?businessId=<uuid>  body: { e164 }
 *
 * Overrides win over derived contact names (owner/employee/customer) in
 * dashboard display — see src/lib/db/contact-names.ts. `e164` accepts a
 * real E.164 number or a bare 3-8 digit short code (lead sources like
 * ReferralExchange text from short codes).
 *
 * Auth: getAuthUser + requireOwner(businessId); admins bypass.
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  CONTACT_NUMBER_RE,
  deleteContactOverride,
  setContactOverride
} from "@/lib/db/contact-overrides";

export const dynamic = "force-dynamic";

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 20 };

const querySchema = z.object({ businessId: z.string().uuid() });

const setSchema = z.object({
  e164: z.string().regex(CONTACT_NUMBER_RE, "Must be E.164 (+1602...) or a short code"),
  name: z.string().trim().min(1).max(120)
});

const deleteSchema = z.object({
  e164: z.string().regex(CONTACT_NUMBER_RE, "Must be E.164 (+1602...) or a short code")
});

async function authorize(request: Request) {
  const user = await getAuthUser();
  if (!user) return { error: errorResponse("UNAUTHORIZED", "Authentication required") };
  const url = new URL(request.url);
  const { businessId } = querySchema.parse({
    businessId: url.searchParams.get("businessId") ?? ""
  });
  if (!user.isAdmin) await requireOwner(businessId);
  const limiter = rateLimit(`dashboard-contacts:${businessId}:${user.userId}`, WRITE_RATE);
  if (!limiter.success) {
    return { error: errorResponse("CONFLICT", "Too many requests, please slow down.", 429) };
  }
  return { businessId };
}

export async function POST(request: Request) {
  try {
    const auth = await authorize(request);
    if ("error" in auth) return auth.error;
    const { e164, name } = setSchema.parse(await request.json());
    await setContactOverride(auth.businessId, e164, name);
    return successResponse({ e164, name });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await authorize(request);
    if ("error" in auth) return auth.error;
    const { e164 } = deleteSchema.parse(await request.json());
    await deleteContactOverride(auth.businessId, e164);
    return successResponse({ e164 });
  } catch (err) {
    return handleRouteError(err);
  }
}
