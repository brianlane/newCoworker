/**
 * Public marketing unsubscribe (campaign email).
 *
 *   GET  /api/marketing/unsubscribe?bid=<businessId>&c=<contactId>&t=<hmac>
 *   POST (same query) — the RFC 8058 one-click target Gmail/Apple Mail hit.
 *
 * The token is an HMAC over (business, contact), so a link can only
 * unsubscribe the person it was minted for. Stamping is idempotent; the
 * response never reveals whether the contact existed. Marketing-only:
 * conversational/transactional mail (replies, receipts, reminders) is
 * unaffected — this clears the customer out of campaign audiences.
 */

import { z } from "zod";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { verifyMarketingUnsubscribeToken } from "@/lib/campaigns/send";
import { rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const RATE = { interval: 60 * 1000, maxRequests: 30 };

const querySchema = z.object({
  bid: z.string().uuid(),
  c: z.string().uuid(),
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
    c: url.searchParams.get("c") ?? "",
    t: url.searchParams.get("t") ?? ""
  });
  if (!parsed.success) {
    return page("That unsubscribe link is invalid or incomplete.", 400);
  }
  const { bid, c, t } = parsed.data;

  const limiter = rateLimit(`marketing-unsub:${bid}`, RATE);
  if (!limiter.success) {
    return page("Too many requests — try again in a minute.", 429);
  }

  if (!verifyMarketingUnsubscribeToken(bid, c, t)) {
    return page("That unsubscribe link is invalid or expired.", 400);
  }

  try {
    const db = await createSupabaseServiceClient();
    // Idempotent, first stamp wins; scoped to the token's business.
    const { error } = await db
      .from("contacts")
      .update({ marketing_unsubscribed_at: new Date().toISOString() })
      .eq("business_id", bid)
      .eq("id", c)
      .is("marketing_unsubscribed_at", null);
    if (error) throw new Error(error.message);
  } catch (err) {
    logger.warn("marketing unsubscribe failed", {
      businessId: bid,
      error: err instanceof Error ? err.message : String(err)
    });
    return page("Something went wrong — please try the link again.", 500);
  }

  return page("You're unsubscribed from marketing emails. Replies and appointment messages still reach you.", 200);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

/** RFC 8058 one-click target. */
export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
