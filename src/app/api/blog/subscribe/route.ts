/**
 * Public blog-notification opt-in (the subscribe box on blog pages).
 * Upserts by email so a returning unsubscriber can re-subscribe; a fresh
 * unsubscribe token is minted on every subscribe.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { upsertBlogSubscriber } from "@/lib/blog/db";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  locale: z.enum(["en", "es"]).default("en")
});

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", "A valid email address is required");
    }
    const token = randomBytes(24).toString("hex");
    await upsertBlogSubscriber(parsed.data.email, parsed.data.locale, token);
    return successResponse({ subscribed: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
