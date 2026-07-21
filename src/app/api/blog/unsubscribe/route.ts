/**
 * Blog-notification unsubscribe.
 *
 *   GET  /api/blog/unsubscribe?token=… — the email footer link; performs
 *        the unsubscribe and redirects to the human-facing result page.
 *   POST (same query) — the RFC 8058 one-click target Gmail/Apple Mail hit.
 *
 * Idempotent; the response never reveals whether the token matched a row
 * beyond the ok/invalid page state.
 */

import { NextResponse } from "next/server";
import { unsubscribeBlogSubscriberByToken } from "@/lib/blog/db";
import { rateLimit, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const RATE = { interval: 60 * 1000, maxRequests: 30 };

async function unsubscribe(request: Request): Promise<boolean> {
  const url = new URL(request.url);
  const token = (url.searchParams.get("token") ?? "").trim();
  if (!token || token.length > 128) return false;
  // Per-client bucket: a post-publish wave of unsubscribes must not share
  // one global quota (later valid tokens would be refused).
  const limiter = rateLimit(
    `blog-unsubscribe:${rateLimitIdentifierFromRequest(request)}`,
    RATE
  );
  if (!limiter.success) return false;
  try {
    return await unsubscribeBlogSubscriberByToken(token);
  } catch (err) {
    logger.warn("blog unsubscribe failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}

export async function GET(request: Request): Promise<Response> {
  const ok = await unsubscribe(request);
  const target = new URL(`/blog/unsubscribe?ok=${ok ? "1" : "0"}`, request.url);
  return NextResponse.redirect(target, 303);
}

export async function POST(request: Request): Promise<Response> {
  const ok = await unsubscribe(request);
  return NextResponse.json({ ok });
}
