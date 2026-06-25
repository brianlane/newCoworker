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
import { normalizeContactNumber } from "@/lib/telnyx/format";
import {
  deleteContactOverride,
  listContactOverrides,
  setContactOverride
} from "@/lib/db/contact-overrides";

export const dynamic = "force-dynamic";

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 20 };
const READ_RATE = { interval: 60 * 1000, maxRequests: 60 };

const querySchema = z.object({ businessId: z.string().uuid() });

// Coerce whatever the owner typed ("(305) 613-3412", "305-613-3412", "+44 20…")
// into a canonical E.164 number or short code, so the stored value is always
// clean and the owner never has to pre-format. Assumes US when no country code.
const contactNumberField = z
  .string()
  .transform((val, ctx) => {
    const result = normalizeContactNumber(val);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.reason });
      return z.NEVER;
    }
    return result.value;
  });

const setSchema = z.object({
  e164: contactNumberField,
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email("Enter a valid email").max(254).optional()
});

const deleteSchema = z.object({
  e164: contactNumberField
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

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });
    if (!user.isAdmin) await requireOwner(businessId);
    const limiter = rateLimit(`dashboard-contacts-list:${businessId}`, READ_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, please slow down.", 429);
    }
    const contacts = await listContactOverrides(businessId);
    return successResponse({ contacts });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await authorize(request);
    if ("error" in auth) return auth.error;
    const { e164, name, email } = setSchema.parse(await request.json());
    // Only touch email when the caller actually sent it: setContactOverride
    // treats the key's presence as "overwrite", so passing it on a name-only
    // save would unlink an existing address. (Schema rejects null/empty, so a
    // present `email` is always a real address.)
    const options = email === undefined ? {} : { email };
    await setContactOverride(auth.businessId, e164, name, options);
    return successResponse({ e164, name, email: email ?? null });
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
