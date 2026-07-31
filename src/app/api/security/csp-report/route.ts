import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { rateLimit, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";

/**
 * Collection sink for `Content-Security-Policy-Report-Only` violations.
 *
 * Why this exists: `next.config.ts` ships a STRICT report-only policy
 * alongside the (looser) enforced one. Report-only changes nothing for users,
 * but every inline script the app emits produces a violation report here, and
 * that is the measurement we need before deciding whether a nonce rollout is
 * worth it. A report-only policy that already allowed `unsafe-inline` would
 * report nothing and teach us nothing.
 *
 * Cost control matters more than completeness here. The marketing pages are
 * scraped heavily (see the SSR hardening in #1032), and a strict policy means
 * a browser can emit a report per blocked directive per page view. So this
 * route is deliberately cheap and hard-capped: it never touches the database,
 * always answers 204, and drops anything past a small per-IP budget. Losing
 * reports past the cap is fine, because the point is to learn WHICH
 * directives fire, not to count them.
 */

// Deliberately the in-memory limiter, not `rateLimitDurable`: this is a
// telemetry sink, so a per-isolate budget is the right cost/benefit. Paying a
// database round trip to rate-limit a log line would cost more than the abuse
// it prevents.
const REPORT_LIMIT = { interval: 60_000, maxRequests: 10 } as const;

/** Cap the stored payload so an oversized report cannot bloat a log line. */
const MAX_REPORT_CHARS = 2_000;

type CspReportBody = {
  "csp-report"?: Record<string, unknown>;
};

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const limit = rateLimit(
    `csp-report:${rateLimitIdentifierFromRequest(request)}`,
    REPORT_LIMIT
  );

  // 204 even when dropped. A violation reporter is not a caller we owe an
  // error to, and a 429 would just make browsers retry.
  if (!limit.success) return new NextResponse(null, { status: 204 });

  try {
    const raw = await request.text();
    if (raw) {
      // Browsers send `application/csp-report` (the older `csp-report`
      // envelope) or `application/reports+json` (an array). Log whatever
      // arrives rather than insisting on one shape, since the shape varies by
      // browser and we care about the directive, not the wrapper.
      const parsed: unknown = JSON.parse(raw);
      const report =
        (parsed as CspReportBody)?.["csp-report"] ?? parsed;

      logger.warn("csp-report: report-only violation", {
        report: JSON.stringify(report).slice(0, MAX_REPORT_CHARS),
        userAgent: request.headers.get("user-agent")?.slice(0, 200) ?? null
      });
    }
  } catch {
    // Malformed body is not worth an error path: the browser cannot act on
    // our response, and a parse failure is itself uninteresting.
  }

  return new NextResponse(null, { status: 204 });
}
