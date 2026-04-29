import { z } from "zod";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";
import { ingestWebsite, normalizeWebsiteUrl } from "@/lib/website-ingest";
import { logger } from "@/lib/logger";

/**
 * Stateless website-summary preview for the onboarding questionnaire.
 *
 * The Step-2 assistant chat needs the user's website content in its
 * context (otherwise it asks "do you have a website?" right after the
 * user already pasted the URL on Step 1). The persistent ingest at
 * `/api/onboard/website-ingest` requires a `businessId` + `draftToken`
 * pair, but at Step 1 → Step 2 transition there is no business row yet
 * (we don't create it until Step 3 → Stripe in the new flow). Rather
 * than eagerly minting a pending business just to feed the chat, this
 * route runs `ingestWebsite()` statelessly and returns the markdown for
 * the client to cache in component state.
 *
 * Security: the underlying `ingestWebsite()` already enforces the
 * private-IP / DNS-lookup defenses against SSRF (see WebsiteIngestOptions
 * in `@/lib/website-ingest`), so exposing it without auth doesn't widen
 * the SSRF surface beyond what the authenticated variant already allows.
 * What it DOES expose is per-IP cost (LLM summarization is the dominant
 * spend), so we cap the route under the existing onboarding-chat rate
 * limit. No DB writes happen here; persistence remains the job of the
 * authenticated `/api/onboard/website-ingest` once the business exists.
 */

const RATE_LIMIT_CONFIG = {
  interval: 60 * 1000,
  maxRequests: 6
} as const;

const schema = z.object({
  websiteUrl: z.string().min(1),
  businessName: z.string().optional(),
  businessType: z.string().optional()
});

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const limiter = rateLimit(`website-preview:${rateLimitIdentifierFromRequest(request)}`, RATE_LIMIT_CONFIG);
    if (!limiter.success) {
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        "Too many website previews right now. Please wait a minute and try again.",
        429
      );
    }

    const normalized = normalizeWebsiteUrl(body.websiteUrl);
    if (!normalized) {
      return errorResponse("VALIDATION_ERROR", "Please provide a valid http(s) URL");
    }

    const result = await ingestWebsite(normalized, {
      businessName: body.businessName,
      businessType: body.businessType
    });

    if (!result.ok) {
      // Preview failures are not 500s — the URL itself was valid syntactically,
      // we just couldn't crawl/summarize it in time. Return ok:true with an
      // ingest-status payload so the chat client can fall back to "we tried
      // your site but couldn't read it; please summarize it for the
      // assistant" instead of breaking Step 2 entirely.
      logger.info("website-preview: ingest failed", {
        websiteUrl: normalized,
        error: result.error
      });
      return successResponse({
        ok: false,
        error: result.error,
        detail: result.detail ?? null
      });
    }

    return successResponse({
      ok: true,
      websiteMd: result.websiteMd,
      finalUrl: result.finalUrl,
      pagesCrawled: result.pagesCrawled
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid request");
    }
    return handleRouteError(err);
  }
}
