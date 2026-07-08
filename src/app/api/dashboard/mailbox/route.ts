/**
 * Settings → AI Mailbox.
 *
 * GET  ?businessId=                 → current mailbox (address, personalized, canPersonalize)
 * GET  ?businessId=&check=<handle>  → live availability for a proposed handle
 * POST { businessId, localPart }    → set a personalized handle (standard/enterprise only)
 *
 * Auth: getAuthUser + requireBusinessRole(businessId, "manage_settings") (admin bypasses ownership),
 * mirroring /api/dashboard/agent-tools. The tier gate is enforced server-side
 * from the businesses row, never trusting the client.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getBusiness } from "@/lib/db/businesses";
import {
  PERSONALIZE_TIERS,
  TenantMailboxError,
  checkLocalPartAvailable,
  ensureTenantMailbox,
  setPersonalizedLocalPart,
  tenantMailboxAddress
} from "@/lib/email/tenant-mailbox";

export const dynamic = "force-dynamic";

const businessIdSchema = z.string().uuid();

const postBodySchema = z.object({
  businessId: z.string().uuid(),
  localPart: z.string().min(1).max(64)
});

/** Map a TenantMailboxError to the right HTTP error contract. */
function mailboxErrorResponse(err: TenantMailboxError) {
  switch (err.code) {
    case "tier_not_eligible":
      return errorResponse("FORBIDDEN", err.message);
    case "taken":
      return errorResponse("CONFLICT", err.message);
    default:
      return errorResponse("VALIDATION_ERROR", err.message);
  }
}

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const businessId = businessIdSchema.parse(url.searchParams.get("businessId") ?? "");
    if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

    const check = url.searchParams.get("check");
    if (check !== null) {
      const result = await checkLocalPartAvailable(check, businessId);
      return successResponse(result);
    }

    const business = await getBusiness(businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");
    const mailbox = await ensureTenantMailbox(businessId);
    return successResponse({
      localPart: mailbox.local_part,
      address: tenantMailboxAddress(mailbox.local_part),
      personalized: mailbox.personalized,
      canPersonalize: PERSONALIZE_TIERS.has(business.tier)
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const body = postBodySchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_settings");

    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    try {
      const mailbox = await setPersonalizedLocalPart({
        businessId: body.businessId,
        tier: business.tier,
        localPart: body.localPart
      });
      return successResponse({
        localPart: mailbox.local_part,
        address: tenantMailboxAddress(mailbox.local_part),
        personalized: mailbox.personalized,
        canPersonalize: PERSONALIZE_TIERS.has(business.tier)
      });
    } catch (err) {
      if (err instanceof TenantMailboxError) return mailboxErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
