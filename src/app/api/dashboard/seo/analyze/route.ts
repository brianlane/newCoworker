/**
 * On-demand website SEO audit (BizBlasts Seo::AnalysisService port).
 *
 * POST /api/dashboard/seo/analyze  { businessId }
 *   → { report }  and persists it on business_configs.seo_report
 *
 * Audits the business's configured website (businesses.website_url — the
 * same site the onboarding ingest crawls). AI recommendations run through
 * the metered Gemini path (owner AI budget) and are best-effort: a model
 * failure still returns the deterministic report.
 *
 * Auth: manage_settings on the business (admins bypass). Rate-limited —
 * each run fetches a third-party site and may spend AI budget.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { analyzeWebsiteSeo } from "@/lib/seo/analyze";
import { geminiGenerateTextDetailed } from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 3 };

const bodySchema = z.object({ businessId: z.string().uuid() });

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const { businessId } = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

    const limiter = rateLimit(`seo-analyze:${businessId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many audits, try again in a minute.", 429);
    }

    const db = await createSupabaseServiceClient();
    const { data: business, error } = await db
      .from("businesses")
      .select("website_url, business_type")
      .eq("id", businessId)
      .maybeSingle();
    if (error) return errorResponse("INTERNAL_SERVER_ERROR", "Lookup failed", 500);
    const websiteUrl = (business as { website_url: string | null } | null)?.website_url;
    if (!websiteUrl) {
      return errorResponse(
        "VALIDATION_ERROR",
        "Set your website first (Coworker Memory → Website Knowledge)."
      );
    }

    const apiKey = (process.env.GOOGLE_API_KEY ?? "").trim();
    const model = (process.env.GEMINI_SUMMARY_MODEL ?? "").trim() || "gemini-3-flash-preview";
    const result = await analyzeWebsiteSeo(websiteUrl, {
      businessType: (business as { business_type: string | null }).business_type,
      // AI advice is optional: without a key the deterministic report ships.
      generate: !apiKey
        ? undefined
        : async (prompt) => {
            const { text, usage } = await geminiGenerateTextDetailed({
              apiKey,
              model,
              systemInstruction:
                "You are a practical SEO consultant for small local service businesses.",
              userText: prompt,
              temperature: 0.3,
              maxOutputTokens: 600
            });
            await meterGeminiSpendForBusiness({
              businessId,
              model,
              surface: "seo_insights",
              usage,
              inputChars: prompt.length,
              outputChars: text.length
            });
            return text;
          }
    });
    if (!result.ok) {
      const message =
        result.error === "invalid_url"
          ? "The saved website URL is not valid."
          : result.error === "private_address"
            ? "That website address is not publicly reachable."
            : result.error === "empty_page"
              ? "The site returned an empty page."
              : `Could not fetch the site (${result.detail ?? "fetch failed"}).`;
      return errorResponse("VALIDATION_ERROR", message);
    }

    const { data: saved, error: saveErr } = await db
      .from("business_configs")
      .update({
        seo_report: result.report,
        seo_report_at: result.report.analyzedAt,
        updated_at: new Date().toISOString()
      })
      .eq("business_id", businessId)
      .select("business_id");
    if (saveErr || !Array.isArray(saved) || saved.length === 0) {
      // No config row yet (unprovisioned business) or a write blip: the
      // caller still gets the freshly computed report, it just won't be
      // there on the next page load.
      logger.warn("seo-analyze: report persist failed (returning it anyway)", {
        businessId,
        error: saveErr?.message ?? "no business_configs row matched"
      });
    }

    return successResponse({ report: result.report });
  } catch (err) {
    return handleRouteError(err);
  }
}
