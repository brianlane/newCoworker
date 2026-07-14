import { z } from "zod";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getAuthUser } from "@/lib/auth";
import { getOnboardingDraft } from "@/lib/db/onboarding-drafts";
import { getBusiness, updateBusinessWebsiteUrl } from "@/lib/db/businesses";
import { setBusinessWebsiteCrawlReport, setBusinessWebsiteMd } from "@/lib/db/configs";
import {
  ingestWebsite,
  ingestWebsiteFromHtml,
  normalizeWebsiteUrl,
  WEBSITE_INGEST_DEEP_MAX_PAGES,
  WEBSITE_INGEST_MAX_PASTED_HTML_CHARS,
  type WebsiteIngestProgressEvent
} from "@/lib/website-ingest";
import { scheduleVaultSync } from "@/lib/vps/schedule-vault-sync";
import { logger } from "@/lib/logger";

// after() shares the route's max duration (it does NOT get a fresh window), so
// this must cover the WHOLE request: the website crawl + summary (can run tens
// of seconds) AND the post-response vault re-seed, whose own SSH timeout is
// 60s. Budget generously so a slow crawl can't starve the re-seed and leave
// the agent prompt stale.
export const runtime = "nodejs";
export const maxDuration = 300;

const schema = z.object({
  businessId: z.string().uuid(),
  websiteUrl: z.string().min(1),
  draftToken: z.string().uuid().optional(),
  businessName: z.string().optional(),
  businessType: z.string().optional(),
  /**
   * Manual escape hatch for WAF-blocked sites: the owner's pasted
   * "View Page Source" HTML. When present (non-blank), we skip the crawl
   * entirely and run the pasted markup through the same extraction +
   * summarization pipeline. See `ingestWebsiteFromHtml`.
   */
  pastedHtml: z
    .string()
    .max(WEBSITE_INGEST_MAX_PASTED_HTML_CHARS, "Pasted page source is too large")
    .optional(),
  /**
   * When true, respond with NDJSON: one `{"kind":"progress",...}` line per
   * crawl event (page fetched/failed, sitemap found, summarizing) and a
   * final `{"kind":"result",...}` line carrying the same payload the
   * non-streaming path returns under `data`. The dashboard re-crawl uses
   * this to show each page as it's read. The onboarding fire-and-forget
   * caller omits it and keeps the plain JSON contract.
   */
  stream: z.boolean().optional()
});

type IngestBody = z.infer<typeof schema>;

async function isAuthorized(
  businessId: string,
  draftToken?: string
): Promise<{ ok: true; source: "draft" | "owner" } | { ok: false; reason: string }> {
  if (draftToken) {
    const draft = await getOnboardingDraft(businessId).catch(() => null);
    if (draft && draft.draft_token === draftToken) return { ok: true, source: "draft" };
  }

  const user = await getAuthUser();
  if (!user) return { ok: false, reason: "not authenticated" };
  if (user.isAdmin) return { ok: true, source: "owner" };
  if (!user.email) return { ok: false, reason: "no email" };

  const business = await getBusiness(businessId);
  // `BusinessRow.owner_email` is typed as `string`, but the column is nullable
  // at the SQL layer (pending rows, manual DB edits, legacy backfills). Without
  // this guard a null value would throw `Cannot read properties of null` from
  // `.toLowerCase()` and bubble up as a 500, leaking an internal crash for what
  // should be a clean "not owner" 403.
  if (!business || !business.owner_email) {
    return { ok: false, reason: "not owner" };
  }
  if (business.owner_email.toLowerCase() !== user.email.toLowerCase()) {
    return { ok: false, reason: "not owner" };
  }
  return { ok: true, source: "owner" };
}

type IngestPayload =
  | {
      ok: true;
      pagesCrawled: number;
      bytesDownloaded: number;
      websiteMdPreview: string;
      websiteMd?: string;
      pages?: Array<{ url: string; chars: number }>;
      crawledAt?: string;
    }
  | { ok: false; error: string; detail: string | null };

/**
 * Shared tail of the streaming and JSON paths: run the ingest (crawl or
 * pasted-source), persist on success, schedule the vault re-seed, and shape
 * the response payload. Identical behavior in both paths by construction.
 */
async function runIngestAndPersist(
  body: IngestBody,
  normalized: string,
  authSource: "draft" | "owner",
  onProgress?: (event: WebsiteIngestProgressEvent) => void
): Promise<IngestPayload> {
  const usePastedHtml = Boolean(body.pastedHtml && body.pastedHtml.trim().length > 0);
  const source = usePastedHtml ? ("pasted_html" as const) : ("crawl" as const);
  const result = usePastedHtml
    ? // WAF escape hatch: the owner pasted their homepage's page source
      // because every server-side fetch path is challenge-blocked. No
      // crawl, no SSRF surface — same extraction/summarization pipeline.
      await ingestWebsiteFromHtml(normalized, body.pastedHtml as string, {
        businessName: body.businessName,
        businessType: body.businessType,
        meterBusinessId: body.businessId
      })
    : await ingestWebsite(normalized, {
        businessName: body.businessName,
        businessType: body.businessType,
        // Meter the Gemini summary into this business's shared AI budget.
        meterBusinessId: body.businessId,
        // Deep crawl: this authenticated, once-per-onboarding (plus manual
        // re-crawl) path covers the whole site — sitemap-seeded, up to 80
        // pages — so the vault summary isn't limited to whatever the
        // homepage happens to link. The unauthenticated preview route keeps
        // the shallow default.
        maxPages: WEBSITE_INGEST_DEEP_MAX_PAGES,
        sitemapDiscovery: true,
        // Owner-consented bypass: this route is invoked post-checkout
        // with a URL the business owner explicitly provided during
        // onboarding. robots.txt expresses third-party-crawler
        // preferences, not first-party-agent prohibitions, and many
        // small-business sites ship a default-deny `User-agent: * /
        // Disallow: /` block that would otherwise prevent the owner's
        // own assistant from learning their own business. SSRF /
        // private-IP / size / redirect defenses still apply.
        ignoreRobots: true,
        // If the direct crawl is blocked (e.g. Cloudflare bot mitigation
        // returns a 403 challenge), fall back to the Jina Reader proxy. The
        // owner explicitly provided this URL, so fetching a rendered copy of
        // their own public site is consented.
        readerFallback: true,
        onProgress
      });

  if (!result.ok) {
    logger.warn("website-ingest: failed", {
      businessId: body.businessId,
      websiteUrl: normalized,
      source,
      error: result.error,
      detail: result.detail
    });
    return { ok: false, error: result.error, detail: result.detail ?? null };
  }

  // Persist results. `setBusinessWebsiteMd` is race-safe against the parallel
  // `/api/business/config` upsert that runs from checkout — it inserts a
  // skeleton row with `ignoreDuplicates` (so it never clobbers existing
  // soul/identity/memory drafts) and then targets `website_md` alone.
  await updateBusinessWebsiteUrl(body.businessId, normalized).catch((err) => {
    logger.warn("website-ingest: persist website_url failed", {
      businessId: body.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  });

  await setBusinessWebsiteMd(body.businessId, result.websiteMd);

  // Last-crawl snapshot for the dashboard ("Crawled N pages on <date>" +
  // page list). Cosmetic relative to website_md, so a write failure logs
  // and moves on rather than failing an otherwise-successful ingest.
  const crawledAt = new Date().toISOString();
  await setBusinessWebsiteCrawlReport(body.businessId, {
    crawledAt,
    source,
    pages: result.pages
  }).catch((err) => {
    logger.warn("website-ingest: persist crawl report failed", {
      businessId: body.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  });

  // Re-seed the live VPS vault + MongoDB agent prompt with the new
  // website summary. Without this the just-persisted `website_md`
  // would only reach Supabase; the agent's `instructions` field on
  // the VPS would still reflect the provision-time snapshot. Skipped
  // silently when the business has no VPS yet (pre-checkout draft
  // ingest) — `syncVaultToVpsAndLog` returns `no_vps_assigned`. Deferred via
  // after() so the SSH re-seed reliably completes post-response on Vercel.
  scheduleVaultSync(body.businessId);

  logger.info("website-ingest: success", {
    businessId: body.businessId,
    source,
    pagesCrawled: result.pagesCrawled,
    bytesDownloaded: result.bytesDownloaded
  });

  return {
    ok: true,
    pagesCrawled: result.pagesCrawled,
    bytesDownloaded: result.bytesDownloaded,
    websiteMdPreview: result.websiteMd.slice(0, 320),
    // Owners re-crawl from the dashboard and need the full summary (and the
    // crawled-page list) to refresh the editor in place. The onboarding
    // caller (pre-auth) ignores these. Only returned when the caller proved
    // ownership.
    websiteMd: authSource === "owner" ? result.websiteMd : undefined,
    pages: authSource === "owner" ? result.pages : undefined,
    crawledAt
  };
}

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const normalized = normalizeWebsiteUrl(body.websiteUrl);
    if (!normalized) {
      return errorResponse("VALIDATION_ERROR", "Please provide a valid http(s) URL");
    }

    const auth = await isAuthorized(body.businessId, body.draftToken);
    if (!auth.ok) {
      return errorResponse("FORBIDDEN", auth.reason, 403);
    }

    if (body.stream) {
      // NDJSON progress stream. Validation/auth failures above still return
      // plain JSON — the client only switches to line-reading after it sees
      // the ndjson content type on a 200.
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const emit = (line: Record<string, unknown>) => {
            controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          };
          try {
            const payload = await runIngestAndPersist(body, normalized, auth.source, (event) =>
              emit({ kind: "progress", ...event })
            );
            emit({ kind: "result", ...payload });
          } catch (err) {
            // Mirrors handleRouteError semantics for a body that's already
            // streaming: we can't change the status code anymore, so surface
            // a terminal error line the client maps to its failure state.
            logger.error("website-ingest: stream failed", {
              businessId: body.businessId,
              error: err instanceof Error ? err.message : String(err)
            });
            emit({ kind: "error", message: "Re-crawl failed" });
          }
          controller.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-cache, no-transform"
        }
      });
    }

    const payload = await runIngestAndPersist(body, normalized, auth.source);
    return successResponse(payload);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
