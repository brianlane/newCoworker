/**
 * Blog-notification unsubscribe.
 *
 *   GET  /api/blog/unsubscribe?token=… — the email footer link; performs
 *        the unsubscribe and redirects to the human-facing result page.
 *   POST (same query) — the RFC 8058 one-click target Gmail/Apple Mail hit.
 *
 * Idempotent. A rate-limited or errored attempt is distinguished from an
 * invalid token: the GET redirect shows a "try again" page (not "invalid
 * link"), and the POST answers 429/500 so one-click clients can retry —
 * a publish-wave of unsubscribes behind one NAT must not eat valid tokens.
 */

import { NextResponse } from "next/server";
import { unsubscribeBlogSubscriberByToken } from "@/lib/blog/db";
import { rateLimit, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const RATE = { interval: 60 * 1000, maxRequests: 30 };

type UnsubscribeOutcome = "ok" | "invalid" | "retry";

async function unsubscribe(request: Request): Promise<UnsubscribeOutcome> {
  const url = new URL(request.url);
  const token = (url.searchParams.get("token") ?? "").trim();
  if (!token || token.length > 128) return "invalid";
  // Per-client bucket: a post-publish wave of unsubscribes must not share
  // one global quota (later valid tokens would be refused).
  const limiter = rateLimit(
    `blog-unsubscribe:${rateLimitIdentifierFromRequest(request)}`,
    RATE
  );
  if (!limiter.success) return "retry";
  try {
    return (await unsubscribeBlogSubscriberByToken(token)) ? "ok" : "invalid";
  } catch (err) {
    logger.warn("blog unsubscribe failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return "retry";
  }
}

export async function GET(request: Request): Promise<Response> {
  const outcome = await unsubscribe(request);
  const ok = outcome === "ok" ? "1" : outcome === "retry" ? "retry" : "0";
  // Spanish subscribers (locale=es carried on the email link) land on the
  // /es mirror, which also pins the locale cookie for the result copy.
  const esPrefix = new URL(request.url).searchParams.get("locale") === "es" ? "/es" : "";
  const target = new URL(`${esPrefix}/blog/unsubscribe?ok=${ok}`, request.url);
  return NextResponse.redirect(target, 303);
}

export async function POST(request: Request): Promise<Response> {
  const outcome = await unsubscribe(request);
  if (outcome === "retry") {
    // Non-2xx so RFC 8058 one-click senders retry instead of giving up.
    return NextResponse.json({ ok: false, retry: true }, { status: 429 });
  }
  return NextResponse.json({ ok: outcome === "ok" });
}
