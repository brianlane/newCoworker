/**
 * Public unsubscribe for cold outreach (Prospecting).
 *
 *   GET  /api/outreach/unsubscribe?bid=<businessId>&p=<prospectId>&t=<hmac>
 *   POST (same query), the RFC 8058 one-click target Gmail and Apple Mail hit.
 *
 * The token is an HMAC over (business, prospect), so a link can only
 * unsubscribe the row it was minted for. Prospect-scoped rather than
 * contact-scoped because a prospect is not a contact yet when the pitch goes
 * out; when the outreach flow HAS filed them, their contact row is stamped too,
 * so a later campaign cannot reach them either.
 *
 * Two writes, both idempotent, and the response never reveals whether the
 * prospect existed.
 */

import { z } from "zod";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { verifyOutreachUnsubscribeToken } from "@/lib/outreach/compliance";
import { suppressProspect } from "@/lib/outreach/suppress";
import { rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const RATE = { interval: 60 * 1000, maxRequests: 30 };

const querySchema = z.object({
  bid: z.string().uuid(),
  p: z.string().uuid(),
  t: z.string().min(16).max(64)
});

function page(message: string, status: number): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Email preferences</title></head><body style="font-family:system-ui,sans-serif;background:#1F2430;color:#F5EFE0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="max-width:26rem;padding:2rem;text-align:center"><h1 style="font-size:1.2rem">Email preferences</h1><p style="color:#c9c3b4">${message}</p></div></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    bid: url.searchParams.get("bid") ?? "",
    p: url.searchParams.get("p") ?? "",
    t: url.searchParams.get("t") ?? ""
  });
  if (!parsed.success) {
    return page("That unsubscribe link is invalid or incomplete.", 400);
  }
  const { bid, p, t } = parsed.data;

  // Token first, rate limit second: the HMAC check is cheap and an invalid
  // request never touches the limiter, so nobody knowing a business id can
  // exhaust the quota with garbage tokens and block real opt-outs.
  if (!verifyOutreachUnsubscribeToken(bid, p, t)) {
    return page("That unsubscribe link is invalid or expired.", 400);
  }

  const limiter = rateLimit(`outreach-unsub:${bid}`, RATE);
  if (!limiter.success) {
    return page("Too many requests, please try again in a minute.", 429);
  }

  try {
    const db = await createSupabaseServiceClient();
    await suppressProspect(bid, p, db);
  } catch (err) {
    logger.warn("outreach unsubscribe failed", {
      businessId: bid,
      error: err instanceof Error ? err.message : String(err)
    });
    return page("Something went wrong, please try the link again.", 500);
  }

  return page(
    "You're unsubscribed. You will not hear from us again, and nothing further will be sent to this address.",
    200
  );
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

/** RFC 8058 one-click target. */
export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
