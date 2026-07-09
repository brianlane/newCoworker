import { getAuthUser, verifySignupIdentity } from "@/lib/auth";
import {
  createBusiness,
  getBusiness,
  isValidIanaTimezone,
  updateBusinessPreferredAreaCode,
  updateBusinessTimezone
} from "@/lib/db/businesses";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { normalizePreferredAreaCode } from "@/lib/telnyx/did-search-plan";
import { teamSizeBucketToInt } from "@/lib/onboarding/intakeOptions";
import { createOnboardingToken, createPendingOwnerEmail } from "@/lib/onboarding/token";
import { logger } from "@/lib/logger";
import { z } from "zod";

const schema = z.object({
  businessId: z.string().uuid(),
  name: z.string().min(1),
  tier: z.enum(["starter", "standard", "enterprise"]),
  ownerEmail: z.string().email().optional(),
  signupUserId: z.string().uuid().optional(),
  businessType: z.string().optional(),
  ownerName: z.string().optional(),
  phone: z.string().optional(),
  /**
   * Optional signup-chosen area code for the AI coworker's number. Free-form
   * (users type "(519)" etc.) — normalized below; anything that doesn't
   * reduce to a valid 3-digit NPA is silently dropped rather than failing
   * business creation.
   */
  preferredAreaCode: z.string().max(20).optional(),
  websiteUrl: z.string().optional(),
  serviceArea: z.string().optional(),
  typicalInquiry: z.string().optional(),
  teamSize: z.string().optional(),
  crmUsed: z.string().optional(),
  /** IANA timezone auto-detected from the owner's browser; validated below. */
  timezone: z.string().trim().min(1).max(64).optional()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    const body = schema.parse(await request.json());
    let ownerEmail: string;
    let onboardingToken: string | null = null;

    if (user?.email) {
      ownerEmail = user.email;
    } else {
      if (body.ownerEmail && body.signupUserId) {
        const isValidSignupIdentity = await verifySignupIdentity(body.signupUserId, body.ownerEmail);
        if (!isValidSignupIdentity) {
          return errorResponse("FORBIDDEN", "Not authorized to create business");
        }
        ownerEmail = body.ownerEmail;
      } else if (body.signupUserId) {
        return errorResponse("FORBIDDEN", "Authentication required");
      } else {
        ownerEmail = createPendingOwnerEmail(body.businessId);
        onboardingToken = createOnboardingToken({ businessId: body.businessId });
      }
    }

    // Idempotent re-create. The questionnaire client persists `businessId`
    // in localStorage, so any failure path between a successful INSERT
    // here and the subsequent `persistedToDatabase: true` write on the
    // client (e.g. tab close, network drop, intermediate route 5xx,
    // pre-deploy versions of the orchestrator that didn't set the flag)
    // strands the UUID in localStorage. The user retries "Proceed to
    // Payment", we hit the row, the INSERT fails with a unique-PK
    // violation (Postgres 23505), and `handleRouteError` collapses it
    // into a generic 500 the user can't recover from.
    //
    // Resolution: if a row already exists for this businessId, mirror
    // the contract of a fresh create when its `owner_email` is the same
    // value we'd otherwise assign on a fresh insert (the pending sentinel
    // for the anon Stripe-first flow, the user/legacy email for auth
    // paths). Mint a fresh `onboardingToken` for the anonymous case so
    // the client can continue. Different owner_email means another party
    // owns this UUID — refuse with 409 rather than silently overwrite.
    const existing = await getBusiness(body.businessId);
    if (existing) {
      if (existing.owner_email === ownerEmail) {
        // A retry can carry the browser timezone the original insert never
        // persisted (e.g. the row was created by a pre-timezone deploy, or
        // the first request raced the client write). Apply it on the
        // idempotent path too — otherwise the business stays on the UTC
        // fallback until the owner finds the Settings field.
        const tz =
          body.timezone && isValidIanaTimezone(body.timezone) ? body.timezone : null;
        if (tz && !existing.timezone) {
          await updateBusinessTimezone(existing.id, tz);
        }
        // Signup-requested DID area code: a retry can carry a preference the
        // original insert never persisted, OR a value the user changed on a
        // Step-1 back-navigation before completing checkout. This route only
        // runs during onboarding (nothing else writes the column), so the
        // latest VALID signup input wins; invalid/absent input leaves the
        // stored value untouched.
        const retryAreaCode = normalizePreferredAreaCode(body.preferredAreaCode);
        if (retryAreaCode && existing.preferred_area_code !== retryAreaCode) {
          await updateBusinessPreferredAreaCode(existing.id, retryAreaCode);
        }
        logger.info("business.create idempotent: returning existing row", {
          businessId: body.businessId,
          anonymous: !user
        });
        return successResponse({ businessId: existing.id, onboardingToken });
      }
      logger.warn("business.create blocked: businessId already bound to a different owner", {
        businessId: body.businessId
      });
      return errorResponse(
        "CONFLICT",
        "This business id is already in use. Please refresh and try again.",
        409
      );
    }

    const business = await createBusiness({
      id: body.businessId,
      name: body.name,
      ownerEmail,
      tier: body.tier,
      businessType: body.businessType,
      ownerName: body.ownerName,
      phone: body.phone,
      preferredAreaCode: normalizePreferredAreaCode(body.preferredAreaCode),
      websiteUrl: body.websiteUrl,
      serviceArea: body.serviceArea,
      typicalInquiry: body.typicalInquiry,
      teamSize: body.teamSize ? teamSizeBucketToInt(body.teamSize) : undefined,
      crmUsed: body.crmUsed,
      // Browser-detected; silently dropped when not a real IANA name so a
      // tampered value can never fail business creation.
      timezone: body.timezone && isValidIanaTimezone(body.timezone) ? body.timezone : undefined
    });

    return successResponse({ businessId: business.id, onboardingToken });
  } catch (err) {
    if (err instanceof z.ZodError) return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    return handleRouteError(err);
  }
}
