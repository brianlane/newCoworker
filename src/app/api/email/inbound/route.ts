/**
 * Inbound webhook for per-tenant AI mailboxes.
 *
 * Cloudflare Email Routing's catch-all -> Email Worker POSTs every message
 * addressed to `<tenant>@<platform domain>` here. We resolve the recipient to a
 * business, log it on the Emails page, and enqueue any matching `tenant_email`
 * flows.
 *
 * Auth: `Authorization: Bearer <EMAIL_INBOUND_SECRET>`.
 *
 * Always returns 200 on accepted input (even for unknown recipients) so
 * Cloudflare doesn't retry/bounce — mail is already delivered at the edge by
 * the time we run. Only a genuinely malformed body (400) or an internal fault
 * (500) is surfaced, and the worker treats a non-200 as retryable.
 */
import { z } from "zod";
import { assertEmailInboundAuth } from "@/lib/email/inbound-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { processInboundTenantEmail } from "@/lib/email/inbound";

export const runtime = "nodejs";
export const maxDuration = 30;

const bodySchema = z.object({
  to: z.string().min(3).max(320),
  from: z.string().min(3).max(320),
  subject: z.string().max(998).default(""),
  text: z.string().max(200_000).default(""),
  messageId: z.string().min(1).max(998)
});

export async function POST(request: Request): Promise<Response> {
  if (!assertEmailInboundAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid inbound bearer", 403);
  }
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    return handleRouteError(err);
  }
  try {
    const result = await processInboundTenantEmail(body);
    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
