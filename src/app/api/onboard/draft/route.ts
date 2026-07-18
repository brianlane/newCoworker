import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { businessExists } from "@/lib/db/businesses";
import { getOnboardingDraft, upsertOnboardingDraft } from "@/lib/db/onboarding-drafts";
import { onboardingAssistantProfileSchema } from "@/lib/onboarding/chat";
import { verifyOnboardingToken } from "@/lib/onboarding/token";
import { rateLimitDurable, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";
import { z } from "zod";

// Durable (cross-isolate) per-IP limit on this unauthenticated write/read
// surface, so the quota binds fleet-wide instead of per Vercel isolate
// (audit 2026-07, finding M3). Generous: the questionnaire saves at step
// transitions, never in a loop.
const DRAFT_RATE = { interval: 60 * 1000, maxRequests: 30 };

const onboardingDraftPayloadSchema = z.object({
  businessId: z.string().uuid().optional(),
  draftToken: z.string().uuid().optional(),
  onboardingToken: z.string().optional(),
  ownerEmail: z.string().email().optional(),
  signupUserId: z.string().uuid().optional(),
  persistedToDatabase: z.boolean().optional(),
  tier: z.enum(["starter", "standard"]),
  billingPeriod: z.enum(["monthly", "annual", "biennial"]),
  businessName: z.string(),
  businessType: z.string(),
  ownerName: z.string(),
  phone: z.string(),
  websiteUrl: z.string().optional(),
  serviceArea: z.string(),
  typicalInquiry: z.string(),
  teamSize: z.string(),
  crmUsed: z.string(),
  assistantChat: z.object({
    readyToFinalize: z.boolean(),
    completionPercent: z.number(),
    profile: onboardingAssistantProfileSchema,
    drafts: z.object({
      soulMd: z.string(),
      identityMd: z.string(),
      memoryMd: z.string()
    })
  }).optional()
});

const postSchema = z.object({
  businessId: z.string().uuid(),
  draftToken: z.string().uuid(),
  // Proof of ownership for first-claiming a draft slot whose `businesses`
  // row already exists (see the gate in POST below). Optional because the
  // normal flow's FIRST save happens before /api/business/create mints it.
  onboardingToken: z.string().optional(),
  onboardingData: onboardingDraftPayloadSchema
});

const getSchema = z.object({
  businessId: z.string().uuid(),
  draftToken: z.string().uuid()
});

export async function POST(request: Request) {
  try {
    const limiter = await rateLimitDurable(
      `onboard-draft:${rateLimitIdentifierFromRequest(request)}`,
      DRAFT_RATE
    );
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests. Please wait a minute and try again.", 429);
    }

    const body = postSchema.parse(await request.json());
    const existing = await getOnboardingDraft(body.businessId);

    if (existing && existing.draft_token !== body.draftToken) {
      return errorResponse("FORBIDDEN", "Onboarding draft token mismatch", 403);
    }

    // First-claim gate (audit 2026-07, finding L3): the first write binds
    // the draftToken, so an open first write would let anyone who learned a
    // businessId pre-claim the slot and 403 the legitimate client's saves.
    // In the normal flow the FIRST save happens before /api/business/create
    // (the businessId is a fresh client-side UUID that has never left the
    // browser, so it cannot have leaked) — but once the `businesses` row
    // exists the id is no longer secret, so claiming a missing draft slot
    // for it requires the HMAC onboardingToken minted by
    // /api/business/create, the same proof of ownership /api/checkout and
    // /api/business/config already demand. `businessExists` THROWS on a
    // lookup error (surfacing as a 500 via handleRouteError) so a transient
    // DB failure fails closed instead of skipping the token requirement.
    if (!existing) {
      const exists = await businessExists(body.businessId);
      if (
        exists &&
        !(body.onboardingToken &&
          verifyOnboardingToken(body.onboardingToken, { businessId: body.businessId }))
      ) {
        return errorResponse("FORBIDDEN", "Onboarding token required to claim this draft", 403);
      }
    }

    const row = await upsertOnboardingDraft({
      businessId: body.businessId,
      draftToken: body.draftToken,
      payload: body.onboardingData
    });

    return successResponse({
      businessId: row.business_id,
      draftToken: row.draft_token,
      onboardingData: row.payload
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}

export async function GET(request: Request) {
  try {
    const limiter = await rateLimitDurable(
      `onboard-draft:${rateLimitIdentifierFromRequest(request)}`,
      DRAFT_RATE
    );
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests. Please wait a minute and try again.", 429);
    }

    const url = new URL(request.url);
    const params = getSchema.parse({
      businessId: url.searchParams.get("businessId"),
      draftToken: url.searchParams.get("draftToken")
    });

    const row = await getOnboardingDraft(params.businessId, params.draftToken);
    if (!row) {
      return errorResponse("NOT_FOUND", "Onboarding draft not found", 404);
    }

    return successResponse({
      businessId: row.business_id,
      draftToken: row.draft_token,
      onboardingData: row.payload
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
