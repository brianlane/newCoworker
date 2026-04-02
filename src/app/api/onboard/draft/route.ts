import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getOnboardingDraft, upsertOnboardingDraft } from "@/lib/db/onboarding-drafts";
import { onboardingAssistantProfileSchema } from "@/lib/onboarding/chat";
import { z } from "zod";

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
  onboardingData: onboardingDraftPayloadSchema
});

const getSchema = z.object({
  businessId: z.string().uuid(),
  draftToken: z.string().uuid()
});

export async function POST(request: Request) {
  try {
    const body = postSchema.parse(await request.json());
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
